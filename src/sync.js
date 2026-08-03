import { unwatchFile, watchFile } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getAuthClient } from "./auth.js";
import { sha256, writeTextAtomic } from "./files.js";
import {
  createGoogleServices,
  exportMarkdown,
  getRemoteInfo,
  updateDocumentFromMarkdown,
  updateDocumentStatus,
} from "./google.js";
import {
  applyLocalMove,
  applyRemoteTitle,
  loadPairings,
} from "./manifests.js";
import { DEFAULT_DEV_ROOT } from "./paths.js";
import { loadState, saveState, stateKey } from "./state.js";
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
      hash: sha256(content),
      modifiedTime: stat.mtimeMs,
    };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false };
    throw error;
  }
}

async function pull(services, pairing, remote) {
  const content = await exportMarkdown(services, pairing.documentId);
  const status = {
    content,
    lastWriter: "google-docs",
    lastSuccessfulSync: new Date().toISOString(),
  };
  await writeTextAtomic(pairing.absolutePath, documentStatusMarkdown(pairing, status));
  const updatedRemote = await updateDocumentStatus(
    services,
    pairing.documentId,
    remoteDocumentStatusMarkdown(pairing, status),
  );
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

async function push(services, pairing, local) {
  const status = {
    content: local.content,
    lastWriter: "markdown",
    lastSuccessfulSync: new Date().toISOString(),
  };
  await writeTextAtomic(pairing.absolutePath, documentStatusMarkdown(pairing, status));
  await updateDocumentFromMarkdown(
    services,
    pairing.documentId,
    local.content,
  );
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
  if (action === "pull") {
    return {
      action: "pull",
      pairing: effectivePairing,
      state: spreadsheet
        ? await pullSheet(services, effectivePairing, remote)
        : await pull(services, effectivePairing, remote),
    };
  }
  if (action === "none") {
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
      : await push(services, effectivePairing, local),
  };
}

export async function runSyncPass({
  root = process.env.GOOGLE_DOCS_SYNC_ROOT ?? DEFAULT_DEV_ROOT,
  interactiveAuth = false,
  logger = console,
  pairings: suppliedPairings,
  targetPaths,
  deferMissingLocal,
} = {}) {
  const auth = await getAuthClient({ interactive: interactiveAuth });
  const services = createGoogleServices(auth);
  const discoveredPairings = suppliedPairings ?? (await loadPairings(root));
  const pairings = targetPaths
    ? discoveredPairings.filter((pairing) =>
        targetPaths.has(pairing.absolutePath),
      )
    : discoveredPairings;
  const state = await loadState();
  const results = [];

  for (const pairing of pairings) {
    const key = stateKey(pairing);
    try {
      const result = await syncPairing(services, pairing, state.documents[key], {
        deferMissingLocal,
      });
      state.documents[key] = result.state;
      results.push({ pairing: result.pairing, action: result.action });
      if (result.action !== "none") {
        logger.log(`${result.action}: ${result.pairing.absolutePath}`);
      }
      if (result.pairing.absolutePath !== pairing.absolutePath) {
        logger.log(
          `rename: ${pairing.absolutePath} -> ${result.pairing.absolutePath}`,
        );
      }
    } catch (error) {
      results.push({ pairing, action: "error", error });
      logger.error(`${pairing.absolutePath}: ${error.message}`);
    }
  }
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
} = {}) {
  logger.log(
    `Google Docs Markdown Sync started (${debounceMs}ms local debounce, ${intervalMs}ms remote poll).`,
  );
  let stopping = false;
  let sleepTimer;
  let wakeSleep;
  let debounceTimer;
  const pendingPaths = new Set();
  const pendingMoves = new Map();
  const deferredMissingPaths = new Map();
  const enqueue = createSingleFlight();
  const root = process.env.GOOGLE_DOCS_SYNC_ROOT ?? DEFAULT_DEV_ROOT;

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
    const deferredAt = deferredMissingPaths.get(pairing.absolutePath);
    if (deferredAt && Date.now() - deferredAt <= intervalMs * 2) {
      deferredMissingPaths.delete(pairing.absolutePath);
      return false;
    }
    deferredMissingPaths.set(pairing.absolutePath, Date.now());
    return true;
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
      const pairings = await loadPairings(root);
      await watcherManager.refresh(pairings);
      const results = await enqueue(() =>
        runSyncPass({
          root,
          pairings: pairings.filter(
            (pairing) => !pendingMoves.has(pairing.absolutePath),
          ),
          deferMissingLocal,
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
