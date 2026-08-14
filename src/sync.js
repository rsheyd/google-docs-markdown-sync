import { unwatchFile, watchFile } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getAuthClient } from "./auth.js";
import { sha256, writeTextAtomic } from "./files.js";
import {
  assetDirectoryPath,
  hashMarkdownWithAssets,
  hasImagesForSync,
  materializeRemoteImages,
  prepareImagePush,
} from "./images.js";
import { createR2Stager, loadR2Configuration } from "./r2.js";
import {
  createGoogleServices,
  exportMarkdown,
  getRemoteInfo,
  updateDocumentParagraphSpacing,
  updateDocumentFromMarkdown,
  updateDocumentStatus,
} from "./google.js";
import {
  applyLocalMove,
  applyRemoteTitle,
  loadPairings,
} from "./manifests.js";
import { workspaceRoot } from "./paths.js";
import { loadSettings } from "./config.js";
import { loadState, saveState, stateKey } from "./state.js";
import {
  cancelMissingDeletion,
  deletionDue,
  recordMissingDeletion,
  retryDeletionNotifications,
  trashPairedDocument,
} from "./deletions.js";
import { createTimestampLogger } from "./progress.js";
import { readPackageVersion } from "./version.js";
import {
  getSpreadsheetInfo,
  pullSpreadsheet,
  pushSpreadsheet,
  readLocalSpreadsheet,
  hasSpreadsheetStatus,
  writeSpreadsheetStatus,
} from "./sheets.js";
import {
  documentStatusMarkdown,
  hasMarkdownStatus,
  hasRemoteDocumentStatus,
  remoteDocumentStatusMarkdown,
  SHEET_STATUS_FILE,
  spreadsheetStatusMarkdown,
  stripDocumentStatus,
} from "./status.js";

async function localSnapshot(filePath) {
  try {
    const [text, stat] = await Promise.all([
      fs.readFile(filePath, "utf8"),
      fs.stat(filePath),
    ]);
    const content = stripDocumentStatus(text);
    return {
      exists: true,
      text,
      content,
      hash: await hashMarkdownWithAssets(filePath, content),
      modifiedTime: stat.mtimeMs,
    };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false };
    throw error;
  }
}

export async function pullDocument(services, pairing, remote) {
  const status = {
    lastWriter: "google-docs",
    lastSuccessfulSync: new Date().toISOString(),
  };
  // Complete the fallible remote write before touching the local file. If a
  // collaborator wins the revision race, the pull can retry without leaving a
  // daemon-authored local change behind with stale sync state.
  const updatedRemote = await updateDocumentStatus(
    services,
    pairing.documentId,
    remoteDocumentStatusMarkdown(pairing, status),
  );
  const exported = await exportMarkdown(services, pairing.documentId);
  const content = await materializeRemoteImages(
    services,
    pairing,
    updatedRemote.document,
    exported,
  );
  status.content = content;
  await writeTextAtomic(pairing.absolutePath, documentStatusMarkdown(pairing, status));
  const local = await localSnapshot(pairing.absolutePath);
  return {
    localHash: local.hash,
    localModifiedTime: local.modifiedTime,
    remoteRevisionId: updatedRemote.revisionId,
    remoteModifiedTime: updatedRemote.modifiedTime,
    lastWriter: "google-docs",
    lastSuccessfulSync: new Date().toISOString(),
  };
}

async function push(services, pairing, local, before) {
  const status = {
    content: local.content,
    lastWriter: "markdown",
    lastSuccessfulSync: new Date().toISOString(),
  };
  await writeTextAtomic(pairing.absolutePath, documentStatusMarkdown(pairing, status));
  const imageSync = hasImagesForSync(before.document, local.content)
    ? await prepareImagePush(
        services,
        pairing.absolutePath,
        local.content,
        before.document,
        createR2Stager(loadR2Configuration()),
      )
    : undefined;
  try {
    await updateDocumentFromMarkdown(
      services,
      pairing.documentId,
      local.content,
      { imageSync },
    );
  } finally {
    await imageSync?.cleanup();
  }
  const remote = await updateDocumentStatus(
    services,
    pairing.documentId,
    remoteDocumentStatusMarkdown(pairing, status),
  );
  const refreshed = await localSnapshot(pairing.absolutePath);
  return {
    localHash: refreshed.hash,
    localModifiedTime: refreshed.modifiedTime,
    remoteRevisionId: remote.revisionId,
    remoteModifiedTime: remote.modifiedTime,
    lastWriter: "markdown",
    lastSuccessfulSync: new Date().toISOString(),
  };
}

async function pullSheet(services, pairing, remote) {
  const local = await pullSpreadsheet(services, pairing, remote);
  const state = {
    localHash: local.hash,
    localModifiedTime: local.modifiedTime,
    remoteRevisionId: remote.revisionId,
    remoteModifiedTime: remote.modifiedTime,
    lastWriter: "google-sheets",
    lastSuccessfulSync: new Date().toISOString(),
  };
  const updated = await writeSpreadsheetStatus(services, pairing, state, remote);
  return { ...state, remoteRevisionId: updated.revisionId, remoteModifiedTime: updated.modifiedTime };
}

async function pushSheet(services, pairing, local, remote) {
  const updated = await pushSpreadsheet(services, pairing, local, remote);
  const refreshedLocal = await readLocalSpreadsheet(pairing.absolutePath);
  const state = {
    localHash: refreshedLocal.hash,
    localModifiedTime: refreshedLocal.modifiedTime,
    remoteRevisionId: updated.revisionId,
    remoteModifiedTime: updated.modifiedTime,
    lastWriter: "csv",
    lastSuccessfulSync: new Date().toISOString(),
  };
  const finalRemote = await writeSpreadsheetStatus(services, pairing, state, updated);
  return { ...state, remoteRevisionId: finalRemote.revisionId, remoteModifiedTime: finalRemote.modifiedTime };
}

async function repairStatus(services, pairing, previous, local, remote) {
  if (pairing.type === "spreadsheet") {
    const updated = await writeSpreadsheetStatus(services, pairing, previous, remote);
    return { ...previous, remoteRevisionId: updated.revisionId, remoteModifiedTime: updated.modifiedTime };
  }
  await writeTextAtomic(pairing.absolutePath, documentStatusMarkdown(pairing, {
    ...previous,
    content: local.content,
  }));
  const updated = await updateDocumentStatus(
    services,
    pairing.documentId,
    remoteDocumentStatusMarkdown(pairing, previous),
  );
  const refreshed = await localSnapshot(pairing.absolutePath);
  return {
    ...previous,
    localHash: refreshed.hash,
    localModifiedTime: refreshed.modifiedTime,
    remoteRevisionId: updated.revisionId,
    remoteModifiedTime: updated.modifiedTime,
  };
}

export function chooseSyncAction({ local, remote, previous }) {
  if (!local.exists || !previous) return "pull";
  const localChanged = local.hash !== previous.localHash;
  const remoteChanged = remote.revisionId !== previous.remoteRevisionId;
  if (!localChanged && !remoteChanged) return "none";
  if (localChanged && !remoteChanged) return "push";
  if (!localChanged && remoteChanged) return "pull";
  return local.modifiedTime > Date.parse(remote.modifiedTime) ? "push" : "pull";
}

export function hasImageConflict({ local, remote, previous }) {
  return Boolean(
    previous &&
    local.exists &&
    local.hash !== previous.localHash &&
    remote.revisionId !== previous.remoteRevisionId &&
    hasImagesForSync(remote.document, local.content),
  );
}

export async function syncPairing(
  services,
  pairing,
  previous,
  { deferMissingLocal } = {},
) {
  const spreadsheet = pairing.type === "spreadsheet";
  const remote = spreadsheet
    ? await getSpreadsheetInfo(services, pairing.spreadsheetId)
    : await getRemoteInfo(services, pairing.documentId);
  const effectivePairing = spreadsheet ? pairing : await applyRemoteTitle(pairing, remote.name);
  const local = spreadsheet
    ? await readLocalSpreadsheet(effectivePairing.absolutePath)
    : await localSnapshot(effectivePairing.absolutePath);
  if (!local.exists && (await deferMissingLocal?.(effectivePairing))) {
    return {
      action: "defer",
      pairing: effectivePairing,
      state: previous,
    };
  }
  const action = chooseSyncAction({ local, remote, previous });
  if (
    !spreadsheet &&
    previous &&
    local.exists &&
    local.hash !== previous.localHash &&
    (remote.revisionId !== previous.remoteRevisionId || hasMarkdownStatus(local.text))
  ) {
    const remoteContent = await exportMarkdown(services, effectivePairing.documentId);
    if (sha256(remoteContent) === local.hash) {
      return {
        action: "repair-status",
        pairing: effectivePairing,
        state: await repairStatus(
          services,
          effectivePairing,
          { ...previous, localHash: local.hash },
          local,
          remote,
        ),
      };
    }
  }
  if (!spreadsheet && hasImageConflict({ local, remote, previous })) {
    throw new Error(
      "Image conflict: both Markdown/assets and Google Docs changed since " +
        "the last synchronized baseline. Resolve one side before syncing.",
    );
  }
  if (action === "pull") {
    return {
      action: "pull",
      pairing: effectivePairing,
      state: spreadsheet
        ? await pullSheet(services, effectivePairing, remote)
        : await pullDocument(services, effectivePairing, remote),
    };
  }
  if (action === "none") {
    if (!spreadsheet) {
      const styledRemote = await updateDocumentParagraphSpacing(
        services,
        effectivePairing.documentId,
        remote.document,
        local.content,
      );
      if (styledRemote) {
        return {
          action: "style",
          pairing: effectivePairing,
          state: {
            ...previous,
            remoteRevisionId: styledRemote.revisionId,
            remoteModifiedTime: styledRemote.modifiedTime,
          },
        };
      }
    }
    const localStatusPath = spreadsheet
      ? path.join(effectivePairing.absolutePath, SHEET_STATUS_FILE)
      : effectivePairing.absolutePath;
    const expectedLocalStatus = spreadsheet
      ? spreadsheetStatusMarkdown(effectivePairing, previous)
      : documentStatusMarkdown(effectivePairing, { ...previous, content: local.content });
    const actualLocalStatus = spreadsheet
      ? await fs.readFile(localStatusPath, "utf8").catch((error) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        })
      : local.text;
    const localStatusNeedsRepair = actualLocalStatus !== expectedLocalStatus;
    const remoteStatusMissing = spreadsheet
      ? !hasSpreadsheetStatus(remote)
      : !hasRemoteDocumentStatus(remote.document);
    if (localStatusNeedsRepair || remoteStatusMissing) {
      return {
        action: "repair-status",
        pairing: effectivePairing,
        state: await repairStatus(services, effectivePairing, previous, local, remote),
      };
    }
    return { action: "none", pairing: effectivePairing, state: previous };
  }
  return {
    action: "push",
    pairing: effectivePairing,
    state: spreadsheet
      ? await pushSheet(services, effectivePairing, local, remote)
      : await push(services, effectivePairing, local, remote),
  };
}

export async function runSyncPass({
  root = workspaceRoot(),
  interactiveAuth = false,
  logger = console,
  pairings: suppliedPairings,
  targetPaths,
  deferMissingLocal,
  onProgress,
  missingLocalWaitMs,
} = {}) {
  const auth = await getAuthClient({ interactive: interactiveAuth });
  const services = createGoogleServices(auth);
  const discoveredPairings = suppliedPairings ?? (await loadPairings(root));
  const settings = await loadSettings();
  const configuredPairings = discoveredPairings.map((pairing) => ({
    ...pairing,
    deletionPolicy: settings.deletionPolicy,
  }));
  const pairings = targetPaths
    ? configuredPairings.filter((pairing) =>
        targetPaths.has(pairing.absolutePath),
      )
    : configuredPairings;
  const state = await loadState();
  const results = [];

  for (const pairing of pairings) {
    const current = results.length + 1;
    onProgress?.({ type: "start", current, total: pairings.length, pairing });
    const key = stateKey(pairing);
    try {
      if (
        pairing.type !== "spreadsheet" &&
        pairing.deletionPolicy?.mode === "trash-after-grace-period" &&
        state.documents[key]
      ) {
        const localExists = await fs.access(pairing.absolutePath).then(
          () => true,
          (error) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        );
        if (localExists) {
          await cancelMissingDeletion(pairing, state, { persistState: saveState });
        } else if (
          (state.deletions?.[pairing.documentId] &&
            state.deletions[pairing.documentId].phase !== "notified") ||
          !deferMissingLocal ||
          !(await deferMissingLocal(pairing))
        ) {
          const deletion = await recordMissingDeletion(pairing, state, {
            persistState: saveState,
          });
          if (deletionDue(pairing, deletion)) {
            await trashPairedDocument({
              services,
              pairing,
              state,
              deletion,
              persistState: saveState,
            });
            const completed = { pairing, action: "trash" };
            results.push(completed);
            onProgress?.({ type: "complete", current, total: pairings.length, ...completed });
            if (!onProgress) {
              logger.log(
                `trash: Google Doc moved to Drive trash and pairing removed: ${pairing.absolutePath}`,
              );
            }
          } else {
            const remainingSeconds = Math.max(
              1,
              Math.ceil(
                (Date.parse(deletion.missingSince) +
                  pairing.deletionPolicy.gracePeriodMinutes * 60_000 -
                  Date.now()) /
                  1_000,
              ),
            );
            const completed = { pairing, action: "pending-trash", remainingSeconds };
            results.push(completed);
            onProgress?.({ type: "complete", current, total: pairings.length, ...completed });
            if (!onProgress) {
              logger.log(
                `pending-trash: deletion grace period active; ${remainingSeconds} second(s) remaining: ${pairing.absolutePath}`,
              );
            }
          }
          continue;
        } else {
          const moveDetectionSeconds = Math.ceil((missingLocalWaitMs ?? 0) / 1_000);
          const completed = { pairing, action: "defer", moveDetectionSeconds };
          results.push(completed);
          onProgress?.({ type: "complete", current, total: pairings.length, ...completed });
          if (!onProgress) {
            logger.log(
              `missing-local: waiting up to ${moveDetectionSeconds} second(s) to detect a move before starting the ${pairing.deletionPolicy.gracePeriodMinutes}-minute deletion grace period: ${pairing.absolutePath}`,
            );
          }
          continue;
        }
      }
      const result = await syncPairing(services, pairing, state.documents[key], {
        deferMissingLocal,
      });
      state.documents[key] = result.state;
      const completed = {
        pairing: result.pairing,
        action: result.action,
        ...(result.action === "defer"
          ? { moveDetectionSeconds: Math.ceil((missingLocalWaitMs ?? 0) / 1_000) }
          : {}),
      };
      results.push(completed);
      onProgress?.({ type: "complete", current, total: pairings.length, ...completed });
      if (!onProgress && result.action !== "none") {
        if (result.action === "defer") {
          const destination = pairing.deletionPolicy?.mode === "trash-after-grace-period"
            ? "starting the deletion grace period"
            : "restoring from Google Docs";
          logger.log(
            `missing-local: waiting up to ${completed.moveDetectionSeconds} second(s) to detect a move before ${destination}: ${result.pairing.absolutePath}`,
          );
        } else {
          logger.log(`${result.action}: ${result.pairing.absolutePath}`);
        }
      }
      if (!onProgress && result.pairing.absolutePath !== pairing.absolutePath) {
        logger.log(
          `rename: ${pairing.absolutePath} -> ${result.pairing.absolutePath}`,
        );
      }
    } catch (error) {
      const completed = { pairing, action: "error", error };
      results.push(completed);
      onProgress?.({ type: "complete", current, total: pairings.length, ...completed });
      if (!onProgress) logger.error(`${pairing.absolutePath}: ${error.message}`);
    }
  }
  await retryDeletionNotifications(state, {
    persistState: saveState,
    logger,
  });
  await saveState(state);
  return results;
}

export function createSingleFlight() {
  let tail = Promise.resolve();
  return function enqueue(operation) {
    const result = tail.then(operation, operation);
    tail = result.catch(() => undefined);
    return result;
  };
}

export function backoffDelay(
  baseMs,
  consecutiveFailures,
  random = Math.random,
) {
  if (!consecutiveFailures) return baseMs;
  const exponential = baseMs * 2 ** Math.min(consecutiveFailures, 4);
  const jitter = Math.floor(random() * Math.min(1_000, baseMs));
  return Math.min(60_000, exponential + jitter);
}

export function shouldDeferMissingPath(
  firstMissingByPath,
  filePath,
  waitMs,
  now = Date.now(),
) {
  if (!firstMissingByPath.has(filePath)) {
    firstMissingByPath.set(filePath, now);
    return true;
  }
  if (now - firstMissingByPath.get(filePath) < waitMs) return true;
  firstMissingByPath.delete(filePath);
  return false;
}

export function createWatcherManager({ onChange, logger }) {
  let signature = "";
  let watchedPaths = [];

  function close() {
    for (const filePath of watchedPaths) unwatchFile(filePath);
    watchedPaths = [];
    signature = "";
  }

  async function refresh(pairings) {
    const watchEntries = [];
    for (const pairing of pairings) {
      watchEntries.push({ watchPath: pairing.absolutePath, pairing });
      if (pairing.type === "spreadsheet") {
        const entries = await fs.readdir(pairing.absolutePath, { withFileTypes: true }).catch((error) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
        for (const entry of entries) {
          if (entry.isFile() && entry.name.toLowerCase().endsWith(".csv")) {
            if (entry.name !== SHEET_STATUS_FILE) {
              watchEntries.push({ watchPath: `${pairing.absolutePath}/${entry.name}`, pairing });
            }
          }
        }
      } else {
        const assetDirectory = assetDirectoryPath(pairing.absolutePath);
        watchEntries.push({ watchPath: assetDirectory, pairing });
        const entries = await fs.readdir(assetDirectory, { withFileTypes: true }).catch((error) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
        for (const entry of entries) {
          if (entry.isFile()) {
            watchEntries.push({
              watchPath: path.join(assetDirectory, entry.name),
              pairing,
            });
          }
        }
      }
    }
    const paths = [...new Set(watchEntries.map((entry) => entry.watchPath))].sort();
    const nextSignature = paths.join("\n");
    if (nextSignature === signature) return;
    close();
    signature = nextSignature;
    const pairingsByPath = new Map(watchEntries.map(({ watchPath, pairing }) => [watchPath, pairing]));
    for (const filePath of paths) {
      watchFile(filePath, { interval: 250 }, (current, previous) => {
        if (
          current.mtimeMs !== previous.mtimeMs ||
          current.size !== previous.size ||
          current.ino !== previous.ino
        ) {
          const pairing = pairingsByPath.get(filePath);
          onChange(pairing.absolutePath, {
            pairing,
            current,
            previous,
          });
        }
      });
      watchedPaths.push(filePath);
    }
  }

  return { refresh, close };
}

export async function runDaemon({
  intervalMs = Number(process.env.GOOGLE_DOCS_SYNC_INTERVAL_MS ?? 5_000),
  debounceMs = Number(process.env.GOOGLE_DOCS_SYNC_DEBOUNCE_MS ?? 750),
  logger = console,
  getVersion = readPackageVersion,
  getState = loadState,
  persistState = saveState,
} = {}) {
  logger = createTimestampLogger(logger);
  const runningVersion = await getVersion();
  const daemonState = await getState();
  daemonState.daemon = {
    version: runningVersion,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  await persistState(daemonState);
  logger.log(
    `Google Docs Markdown Sync ${runningVersion} started (${debounceMs}ms local debounce, ${intervalMs}ms remote poll).`,
  );
  let stopping = false;
  let sleepTimer;
  let wakeSleep;
  let debounceTimer;
  const pendingPaths = new Set();
  const pendingMoves = new Map();
  const deferredMissingPaths = new Map();
  const enqueue = createSingleFlight();
  const root = workspaceRoot();

  const watcherManager = createWatcherManager({
    logger,
    onChange(filePath, { pairing, current, previous } = {}) {
      if (stopping) return;
      pendingPaths.add(filePath);
      if (!current?.ino && previous?.ino && pairing?.type !== "spreadsheet") {
        pendingMoves.set(filePath, {
          pairing,
          identity: { dev: previous.dev, ino: previous.ino },
        });
      }
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const targetPaths = new Set(pendingPaths);
        pendingPaths.clear();
        const moves = [...pendingMoves.entries()];
        enqueue(async () => {
          try {
            for (const [, move] of moves) {
              const updated = await applyLocalMove(move.pairing, move.identity);
              if (updated.absolutePath !== move.pairing.absolutePath) {
                deferredMissingPaths.delete(move.pairing.absolutePath);
                targetPaths.delete(move.pairing.absolutePath);
                targetPaths.add(updated.absolutePath);
                logger.log(
                  `move: ${move.pairing.absolutePath} -> ${updated.absolutePath}`,
                );
              }
            }
            return runSyncPass({
              root,
              targetPaths,
              deferMissingLocal,
              missingLocalWaitMs: intervalMs * 2,
              logger,
            });
          } finally {
            for (const [filePath, move] of moves) {
              if (pendingMoves.get(filePath) === move) {
                pendingMoves.delete(filePath);
              }
            }
          }
        }).catch((error) => logger.error(`local sync: ${error.message}`));
      }, debounceMs);
    },
  });

  function deferMissingLocal(pairing) {
    if (pendingMoves.has(pairing.absolutePath)) return true;
    return shouldDeferMissingPath(
      deferredMissingPaths,
      pairing.absolutePath,
      intervalMs * 2,
    );
  }

  const stop = () => {
    stopping = true;
    clearTimeout(debounceTimer);
    clearTimeout(sleepTimer);
    wakeSleep?.();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let consecutiveFailures = 0;
  try {
    while (!stopping) {
      const onDiskVersion = await getVersion();
      if (onDiskVersion !== runningVersion) {
        logger.log(
          `version-change: ${runningVersion} -> ${onDiskVersion}; exiting so the LaunchAgent can restart GDMS. Foreground users should run \`gdms daemon\` again.`,
        );
        break;
      }
      const pairings = await loadPairings(root);
      await watcherManager.refresh(pairings);
      const results = await enqueue(() =>
        runSyncPass({
          root,
          pairings: pairings.filter(
            (pairing) => !pendingMoves.has(pairing.absolutePath),
          ),
          deferMissingLocal,
          missingLocalWaitMs: intervalMs * 2,
          logger,
        }),
      );
      consecutiveFailures = results.some((result) => result.action === "error")
        ? consecutiveFailures + 1
        : 0;
      const waitMs = backoffDelay(intervalMs, consecutiveFailures);
      await new Promise((resolve) => {
        wakeSleep = resolve;
        sleepTimer = setTimeout(resolve, waitMs);
      });
      wakeSleep = undefined;
    }
  } finally {
    watcherManager.close();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
