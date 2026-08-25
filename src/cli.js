#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs/promises";
import { authorize, getAuthClient } from "./auth.js";
import { writeJsonAtomic, writeTextAtomic, sha256 } from "./files.js";
import {
  hashMarkdownWithAssets,
  hasImagesForSync,
  materializeRemoteImages,
  prepareImagePush,
} from "./images.js";
import { createR2Stager, loadR2Configuration } from "./r2.js";
import { MANIFEST_NAME, R2_CONFIG_PATH, SETTINGS_PATH } from "./paths.js";
import {
  loadSettings,
  saveDeletionPolicy,
  saveNotificationSettings,
} from "./config.js";
import {
  createDocumentFromMarkdown,
  createGoogleServices,
  cleanupDocumentSpacing,
  exportMarkdown,
  getRemoteInfo,
  planIncrementalUpdate,
  updateDocumentFromMarkdown,
  updateDocumentStatus,
} from "./google.js";
import {
  installHeartbeatLaunchAgent,
  installLaunchAgent,
} from "./launch-agent.js";
import { runHeartbeat } from "./heartbeat.js";
import { trashPairedDocument } from "./deletions.js";
import {
  assertRecoveryTargetAvailable,
  clearRecoveryDeletion,
  preserveRecoveryContent,
  restoreDriveDocument,
} from "./recovery.js";
import {
  defaultDocumentTitle,
  loadPairings,
  removeDocumentPairing,
  registerPairing,
} from "./manifests.js";
import { registerSpreadsheetPairing } from "./manifests.js";
import { loadState, saveState, stateKey } from "./state.js";
import { runDaemon, runSyncPass } from "./sync.js";
import {
  createTimestampLogger,
  formatSyncProgress,
  syncSummary,
} from "./progress.js";
import { formatVersionReport, readPackageVersion } from "./version.js";
import { runDocumentMigrations } from "./migrations.js";
import { installFinderQuickAction } from "./finder-quick-action.js";
import { openUrl } from "./macos.js";
import {
  createSpreadsheet,
  getSpreadsheetInfo,
  initialSheetTitle,
  organizeCsvFiles,
  parseCsv,
  writeSpreadsheetStatus,
  pullSpreadsheet,
  pushSpreadsheet,
  readLocalSpreadsheet,
} from "./sheets.js";
import {
  documentStatusMarkdown,
  remoteDocumentStatusMarkdown,
  stripDocumentStatus,
} from "./status.js";
import {
  documentHasNativeTableOfContents,
  refreshGeneratedTableOfContents,
  representNativeTableOfContents,
  representNativeTableOfContentsFromRemote,
  restoreNativeTableOfContents,
  stripGeneratedTableOfContents,
} from "./toc.js";

function parseArguments(values) {
  const [command, ...rest] = values;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    if ([
      "all",
      "dry-run",
      "yes",
      "disable",
      "open",
      "disable-error-email",
      "enable-error-email",
      "disable-desktop-notifications",
      "enable-desktop-notifications",
    ].includes(key)) {
      options[key] = true;
      continue;
    }
    const next = rest[index + 1];
    if (options[key] === undefined) options[key] = next;
    else options[key] = Array.isArray(options[key]) ? [...options[key], next] : [options[key], next];
    index += 1;
  }
  return { command, options };
}

function optionValues(value) {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function helpText() {
  return `GDMS — Google Docs/Sheets ↔ Markdown/CSV Sync

Usage: gdms COMMAND [OPTIONS]

Commands:
  auth
  create --file RELATIVE.md [--workspace PATH] [--name NAME] [--open]
  create-sheet --file FILE.csv [--file TAB.csv ...] [--name NAME] [--open]
  pair --url URL --workspace PATH --file RELATIVE.md [--name NAME]
  pair-sheet --url URL --workspace PATH --directory RELATIVE_DIRECTORY [--name NAME]
  plan --document-id ID
  push (--document-id ID | --spreadsheet-id ID)
  cleanup-spacing --document-id ID
  delete (--file MARKDOWN.md | --document-id ID) --yes
  recover --document-id ID --workspace PATH --file RELATIVE.md
  migrate (--all | --document-id ID) [--dry-run]
  configure-r2 --account-id ID --bucket NAME --gateway-url URL
  configure-deletion --grace-period-minutes MINUTES --to EMAIL [--from SENDER]
  configure-deletion --disable
  configure-notifications [--to EMAIL] [--from SENDER] [--error-email-delay-minutes MINUTES]
                          [--enable-error-email | --disable-error-email]
                          [--enable-desktop-notifications | --disable-desktop-notifications]
  sync-once
  daemon
  install-service
  install-finder-action
  heartbeat --to EMAIL [--from SENDER]
  install-heartbeat [--to EMAIL] [--from SENDER]
  version
  help

Global options:
  --version   Print the installed GDMS version.
  --help      Show this help.

See OPERATIONS.md for the complete command reference and write-scope details.`;
}

async function pair(options) {
  for (const required of ["url", "workspace", "file"]) {
    if (!options[required]) throw new Error(`pair requires --${required}.`);
  }
  const workspace = path.resolve(options.workspace);
  const manifestPath = path.join(workspace, MANIFEST_NAME);
  const previousManifest = await fs.readFile(manifestPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  try {
    const pairing = await registerPairing({
      workspace,
      documentUrl: options.url,
      markdownPath: options.file,
      name: options.name,
    });
    const auth = await getAuthClient();
    const services = createGoogleServices(auth);
    const [exportedMarkdown, remote] = await Promise.all([
      exportMarkdown(services, pairing.documentId),
      getRemoteInfo(services, pairing.documentId),
    ]);
    const materialized = await materializeRemoteImages(
      services,
      pairing,
      remote.document,
      exportedMarkdown,
    );
    const markdown = documentHasNativeTableOfContents(remote.document)
      ? representNativeTableOfContents(materialized)
      : materialized;
    const status = {
      content: markdown,
      lastWriter: "google-docs",
      lastSuccessfulSync: new Date().toISOString(),
    };
    const finalRemote = await updateDocumentStatus(
      services,
      pairing.documentId,
      remoteDocumentStatusMarkdown(pairing, status),
    );
    await writeTextAtomic(pairing.absolutePath, documentStatusMarkdown(pairing, status));
    const stat = await fs.stat(pairing.absolutePath);
    const state = await loadState();
    state.documents[stateKey(pairing)] = {
      localHash: await hashMarkdownWithAssets(
        pairing.absolutePath,
        stripGeneratedTableOfContents(markdown),
      ),
      localModifiedTime: stat.mtimeMs,
      remoteRevisionId: finalRemote.revisionId,
      remoteModifiedTime: finalRemote.modifiedTime,
      lastWriter: "google-docs",
      lastSuccessfulSync: new Date().toISOString(),
    };
    await saveState(state);
    console.log(`Paired ${pairing.documentUrl}`);
    console.log(`Created ${pairing.absolutePath}`);
    console.log(`Updated ${manifestPath}`);
  } catch (error) {
    if (previousManifest === undefined) {
      await fs.rm(manifestPath, { force: true });
    } else {
      await writeJsonAtomic(manifestPath, JSON.parse(previousManifest));
    }
    throw error;
  }
}

async function create(options) {
  if (!options.file || Array.isArray(options.file)) throw new Error("create requires exactly one --file.");
  const absolutePath = options.workspace
    ? path.resolve(options.workspace, options.file)
    : path.resolve(options.file);
  const workspace = options.workspace
    ? path.resolve(options.workspace)
    : path.dirname(absolutePath);
  if (
    absolutePath !== workspace &&
    !absolutePath.startsWith(`${workspace}${path.sep}`)
  ) {
    throw new Error("Markdown filename must stay inside the selected workspace.");
  }
  console.log("Reading Markdown…");
  const [markdown, stat, auth] = await Promise.all([
    fs.readFile(absolutePath, "utf8"),
    fs.stat(absolutePath),
    getAuthClient(),
  ]);
  if (!stat.isFile()) throw new Error(`${absolutePath} is not a file.`);
  const title = options.name ?? defaultDocumentTitle(absolutePath);
  const services = createGoogleServices(auth);
  console.log("Creating Google Doc…");
  const created = await createDocumentFromMarkdown(
    services,
    title,
    markdown,
    {
      onProgress(progress) {
        if (progress.type === "writing-content") {
          console.log("Writing content…");
        } else if (progress.type === "writing-table") {
          console.log(`Writing table ${progress.current} of ${progress.total}…`);
        }
      },
    },
  );
  console.log("Registering pairing…");
  const pairing = await registerPairing({
    workspace,
    documentUrl: created.documentUrl,
    markdownPath: path.relative(workspace, absolutePath),
    name: title,
  });
  const status = {
    content: markdown,
    lastWriter: "markdown",
    lastSuccessfulSync: new Date().toISOString(),
  };
  await writeTextAtomic(pairing.absolutePath, documentStatusMarkdown(pairing, status));
  const finalRemote = await updateDocumentStatus(
    services,
    pairing.documentId,
    remoteDocumentStatusMarkdown(pairing, status),
  );
  const refreshedStat = await fs.stat(pairing.absolutePath);
  const state = await loadState();
  state.documents[stateKey(pairing)] = {
    localHash: sha256(markdown),
    localModifiedTime: refreshedStat.mtimeMs,
    remoteRevisionId: finalRemote.revisionId,
    remoteModifiedTime: finalRemote.modifiedTime,
    lastWriter: "markdown",
    lastSuccessfulSync: new Date().toISOString(),
  };
  await saveState(state);
  console.log(`Created ${created.documentUrl}`);
  console.log(`Paired ${absolutePath}`);
  console.log(`Updated ${path.join(workspace, "google-docs-sync.json")}`);
  if (options.open && !await openUrl(created.documentUrl)) {
    console.error("Created the Google Doc, but could not open it in the browser.");
  }
}

async function createSheet(options) {
  const files = optionValues(options.file);
  if (!files.length) throw new Error("create-sheet requires at least one --file.");
  const title = options.name ?? path.basename(files[0], path.extname(files[0]));
  if (Array.isArray(title) || !String(title).trim()) throw new Error("create-sheet requires one non-empty --name.");

  const titles = files.map((file) => initialSheetTitle(file));
  const foldedTitles = new Set(titles.map((value) => value.toLocaleLowerCase()));
  if (foldedTitles.size !== titles.length) {
    throw new Error("Selected CSV filenames must produce unique Google Sheets tab names.");
  }

  console.log("Reading CSV files…");
  const values = (await Promise.all(files.map((file) => fs.readFile(path.resolve(file), "utf8"))))
    .map((text) => parseCsv(text));
  const auth = await getAuthClient();
  const organized = await organizeCsvFiles(files, title);
  console.log(`Moved CSV files into ${organized.directory}`);
  const local = {
    sheets: organized.files.map((file, index) => ({
      title: titles[index],
      file: path.basename(file),
      values: values[index],
    })),
  };
  const services = createGoogleServices(auth);
  console.log("Creating Google Sheet…");
  const created = await createSpreadsheet(services, String(title).trim(), local.sheets);
  const pairing = await registerSpreadsheetPairing({
    workspace: organized.workspace,
    spreadsheetUrl: created.spreadsheetUrl,
    directoryPath: path.relative(organized.workspace, organized.directory),
    name: String(title).trim(),
  });
  const before = await getSpreadsheetInfo(services, pairing.spreadsheetId);
  const createdIds = new Map(
    (before.spreadsheet.sheets ?? []).map((sheet) => [
      sheet.properties?.title,
      sheet.properties?.sheetId,
    ]),
  );
  for (const sheet of local.sheets) sheet.sheetId = createdIds.get(sheet.title);
  const remote = await pushSpreadsheet(services, pairing, local, before);
  const refreshed = await readLocalSpreadsheet(pairing.absolutePath);
  const status = {
    localHash: refreshed.hash,
    localModifiedTime: refreshed.modifiedTime,
    lastWriter: "csv",
    lastSuccessfulSync: new Date().toISOString(),
  };
  const finalRemote = await writeSpreadsheetStatus(services, pairing, status, remote);
  const state = await loadState();
  state.documents[stateKey(pairing)] = {
    ...status,
    remoteRevisionId: finalRemote.revisionId,
    remoteModifiedTime: finalRemote.modifiedTime,
  };
  await saveState(state);
  console.log(`Created ${created.spreadsheetUrl}`);
  console.log(`Paired ${organized.directory}`);
  console.log(`Updated ${path.join(organized.workspace, "google-docs-sync.json")}`);
  if (options.open && !await openUrl(created.spreadsheetUrl)) {
    console.error("Created the Google Sheet, but could not open it in the browser.");
  }
}

async function pairSheet(options) {
  for (const required of ["url", "workspace", "directory"]) {
    if (!options[required]) throw new Error(`pair-sheet requires --${required}.`);
  }
  const pairing = await registerSpreadsheetPairing({
    workspace: options.workspace,
    spreadsheetUrl: options.url,
    directoryPath: options.directory,
    name: options.name,
  });
  const auth = await getAuthClient();
  const services = createGoogleServices(auth);
  const remote = await getSpreadsheetInfo(services, pairing.spreadsheetId);
  const local = await pullSpreadsheet(services, pairing, remote);
  const status = {
    localHash: local.hash,
    localModifiedTime: local.modifiedTime,
    lastWriter: "google-sheets",
    lastSuccessfulSync: new Date().toISOString(),
  };
  const finalRemote = await writeSpreadsheetStatus(services, pairing, status, remote);
  const state = await loadState();
  state.documents[stateKey(pairing)] = {
    ...status,
    remoteRevisionId: finalRemote.revisionId,
    remoteModifiedTime: finalRemote.modifiedTime,
  };
  await saveState(state);
  console.log(`Paired ${pairing.spreadsheetUrl}`);
  console.log(`Created ${pairing.absolutePath}`);
  console.log(`Updated ${path.join(pairing.workspace, "google-docs-sync.json")}`);
}

async function plan(options) {
  if (!options["document-id"]) {
    throw new Error("plan requires --document-id.");
  }
  const pairings = await loadPairings();
  const pairing = pairings.find(
    (item) => item.documentId === options["document-id"],
  );
  if (!pairing) throw new Error("No pairing found for that document ID.");
  const auth = await getAuthClient();
  const services = createGoogleServices(auth);
  const [markdown, remote] = await Promise.all([
    fs.readFile(pairing.absolutePath, "utf8"),
    getRemoteInfo(services, pairing.documentId),
  ]);
  let localContent = refreshGeneratedTableOfContents(stripDocumentStatus(markdown));
  const remoteExport = documentHasNativeTableOfContents(remote.document)
    ? await exportMarkdown(services, pairing.documentId, { document: remote.document })
    : undefined;
  if (remoteExport) {
    localContent = representNativeTableOfContentsFromRemote(localContent, remoteExport);
  }
  const content = remoteExport
    ? restoreNativeTableOfContents(localContent, remoteExport)
    : localContent;
  const result = planIncrementalUpdate(
    remote.document,
    content,
    { ignoreManagedStatus: true },
  );
  const summarize = (block) => ({
    type: block.type,
    text:
      block.type === "table"
        ? `[table ${block.rows.length}x${block.rows[0]?.length ?? 0}]`
        : block.text.slice(0, 100),
    paragraphStyle: block.paragraphStyle,
    ordered: block.ordered,
    styles: block.styles,
  });
  console.log(
    JSON.stringify(
      {
        mode: result.mode,
        currentBlocks: result.current.length,
        desiredBlocks: result.desired.length,
        changedHunks: result.hunks.length,
        requests: result.requests.length,
        ...(options.verbose
          ? {
              changes: result.hunks.map((hunk) => ({
                current: result.current
                  .slice(hunk.currentStart, hunk.currentEnd)
                  .slice(0, 3)
                  .map(summarize),
                desired: result.desired
                  .slice(hunk.desiredStart, hunk.desiredEnd)
                  .slice(0, 3)
                  .map(summarize),
              })),
              listStyles: Object.values(remote.document.lists ?? {})
                .slice(0, 12)
                .map((list) => list.listProperties?.nestingLevels?.[0]),
            }
          : {}),
      },
      null,
      2,
    ),
  );
}

async function push(options) {
  const remoteId = options["document-id"] ?? options["spreadsheet-id"];
  if (!remoteId) {
    throw new Error("push requires --document-id or --spreadsheet-id.");
  }
  const pairings = await loadPairings();
  const pairing = pairings.find(
    (item) => (item.documentId ?? item.spreadsheetId) === remoteId,
  );
  if (!pairing) throw new Error("No pairing found for that remote ID.");
  if (pairing.type === "spreadsheet") {
    const auth = await getAuthClient();
    const services = createGoogleServices(auth);
    const [local, before] = await Promise.all([
      readLocalSpreadsheet(pairing.absolutePath),
      getSpreadsheetInfo(services, pairing.spreadsheetId),
    ]);
    const remote = await pushSpreadsheet(services, pairing, local, before);
    const refreshed = await readLocalSpreadsheet(pairing.absolutePath);
    const status = {
      localHash: refreshed.hash,
      localModifiedTime: refreshed.modifiedTime,
      lastWriter: "csv",
      lastSuccessfulSync: new Date().toISOString(),
    };
    const finalRemote = await writeSpreadsheetStatus(services, pairing, status, remote);
    const state = await loadState();
    state.documents[stateKey(pairing)] = {
      ...status,
      remoteRevisionId: finalRemote.revisionId,
      remoteModifiedTime: finalRemote.modifiedTime,
    };
    await saveState(state);
    console.log(`Pushed ${pairing.absolutePath}`);
    return;
  }
  const [markdown, auth] = await Promise.all([
    fs.readFile(pairing.absolutePath, "utf8"),
    getAuthClient(),
  ]);
  let localContent = refreshGeneratedTableOfContents(stripDocumentStatus(markdown));
  const services = createGoogleServices(auth);
  const before = await getRemoteInfo(services, pairing.documentId);
  const remoteExport = documentHasNativeTableOfContents(before.document)
    ? await exportMarkdown(services, pairing.documentId, { document: before.document })
    : undefined;
  if (remoteExport) {
    localContent = representNativeTableOfContentsFromRemote(localContent, remoteExport);
  }
  const status = {
    content: localContent,
    lastWriter: "markdown",
    lastSuccessfulSync: new Date().toISOString(),
  };
  await writeTextAtomic(pairing.absolutePath, documentStatusMarkdown(pairing, status));
  const content = remoteExport
    ? restoreNativeTableOfContents(localContent, remoteExport)
    : localContent;
  const imageSync = hasImagesForSync(before.document, content)
    ? await prepareImagePush(
        services,
        pairing.absolutePath,
        content,
        before.document,
        createR2Stager(loadR2Configuration()),
      )
    : undefined;
  try {
    await updateDocumentFromMarkdown(
      services,
      pairing.documentId,
      content,
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
  const refreshedStat = await fs.stat(pairing.absolutePath);
  const state = await loadState();
  state.documents[stateKey(pairing)] = {
    localHash: await hashMarkdownWithAssets(
      pairing.absolutePath,
      stripGeneratedTableOfContents(localContent),
    ),
    localModifiedTime: refreshedStat.mtimeMs,
    remoteRevisionId: remote.revisionId,
    remoteModifiedTime: remote.modifiedTime,
    lastWriter: "markdown",
    lastSuccessfulSync: new Date().toISOString(),
  };
  await saveState(state);
  console.log(`Pushed ${pairing.absolutePath}`);
}

async function cleanupSpacing(options) {
  if (!options["document-id"]) {
    throw new Error("cleanup-spacing requires --document-id.");
  }
  const pairings = await loadPairings();
  const pairing = pairings.find(
    (item) => item.documentId === options["document-id"],
  );
  if (!pairing) throw new Error("No pairing found for that document ID.");
  const [markdown, auth] = await Promise.all([
    fs.readFile(pairing.absolutePath, "utf8"),
    getAuthClient(),
  ]);
  const services = createGoogleServices(auth);
  const result = await cleanupDocumentSpacing(
    services,
    pairing.documentId,
    stripDocumentStatus(markdown),
  );
  const state = await loadState();
  const previous = state.documents[stateKey(pairing)] ?? {};
  state.documents[stateKey(pairing)] = {
    ...previous,
    remoteRevisionId: result.remote.revisionId,
    remoteModifiedTime: result.remote.modifiedTime,
  };
  await saveState(state);
  console.log(
    result.emptyParagraphs
      ? `Removed ${result.emptyParagraphs} generated empty paragraphs from ${pairing.documentUrl}`
      : `No generated empty paragraphs found in ${pairing.documentUrl}`,
  );
}

async function configureR2(options) {
  if (!options["account-id"] || !options.bucket || !options["gateway-url"]) {
    throw new Error("configure-r2 requires --account-id, --bucket, and --gateway-url.");
  }
  await writeJsonAtomic(R2_CONFIG_PATH, {
    accountId: options["account-id"],
    bucket: options.bucket,
    gatewayUrl: options["gateway-url"],
  });
  console.log(`Stored non-secret R2 settings in ${R2_CONFIG_PATH}`);
  console.log("Store the R2 access and secret keys in Keychain, then restart the service.");
}

async function configureDeletion(options) {
  if (options.disable) {
    await saveDeletionPolicy({ mode: "restore-local" });
    console.log(`Disabled automatic deletion globally in ${SETTINGS_PATH}`);
    return;
  }
  const gracePeriodMinutes = Number(options["grace-period-minutes"]);
  if (!Number.isInteger(gracePeriodMinutes) || gracePeriodMinutes < 1 || !options.to) {
    throw new Error(
      "configure-deletion requires --grace-period-minutes POSITIVE_INTEGER and --to EMAIL, or --disable.",
    );
  }
  const policy = await saveDeletionPolicy({
    mode: "trash-after-grace-period",
    gracePeriodMinutes,
    notificationEmail: options.to,
    ...(options.from ? { notificationSender: options.from } : {}),
  });
  console.log(`Enabled automatic deletion globally in ${SETTINGS_PATH}`);
  console.log(
    `All Markdown/Google Docs pairings will move Docs to trash after ${policy.gracePeriodMinutes} missing minute(s).`,
  );
  console.log("The running service will load this setting on its next sync pass.");
}

async function configureNotifications(options) {
  if (options["enable-error-email"] && options["disable-error-email"]) {
    throw new Error("Choose either --enable-error-email or --disable-error-email.");
  }
  if (
    options["enable-desktop-notifications"] &&
    options["disable-desktop-notifications"]
  ) {
    throw new Error(
      "Choose either --enable-desktop-notifications or --disable-desktop-notifications.",
    );
  }
  const current = (await loadSettings()).notifications;
  const delay = options["error-email-delay-minutes"] === undefined
    ? current.errorEmailDelayMinutes
    : Number(options["error-email-delay-minutes"]);
  const nextNotifications = {
    ...current,
    ...(options.to ? { recipient: options.to } : {}),
    ...(options.from ? { sender: options.from } : {}),
    errorEmailDelayMinutes: delay,
    errorEmailEnabled: options["disable-error-email"]
      ? false
      : options["enable-error-email"]
        ? true
        : current.errorEmailEnabled,
    desktopNotificationsEnabled: options["enable-desktop-notifications"]
      ? true
      : options["disable-desktop-notifications"]
        ? false
        : current.desktopNotificationsEnabled,
  };
  if (nextNotifications.errorEmailEnabled && !nextNotifications.recipient) {
    throw new Error("Enabling error email requires --to EMAIL or an existing health-email recipient.");
  }
  const notifications = await saveNotificationSettings(nextNotifications);
  await installLaunchAgent();
  console.log(`Stored shared email notification settings in ${SETTINGS_PATH}`);
  console.log(
    notifications.errorEmailEnabled
      ? `Persistent sync errors will email ${notifications.recipient} after ${notifications.errorEmailDelayMinutes} minute(s); temporary connectivity failures wait at least 30 minutes.`
      : "Persistent sync-error email is disabled; durable error logs remain enabled.",
  );
  console.log(
    notifications.desktopNotificationsEnabled
      ? "Desktop error and recovery notifications are enabled."
      : "Desktop notifications are disabled; durable logs and configured emails remain active.",
  );
}

async function deleteDocument(options) {
  if (!options.file && !options["document-id"]) {
    throw new Error("delete requires --file or --document-id.");
  }
  if (options.file && options["document-id"]) {
    throw new Error("delete accepts either --file or --document-id, not both.");
  }
  const pairings = await loadPairings();
  const settings = await loadSettings();
  const requestedPath = options.file ? path.resolve(options.file) : undefined;
  const pairing = pairings.find((item) =>
    item.type !== "spreadsheet" &&
    (requestedPath
      ? item.absolutePath === requestedPath
      : item.documentId === options["document-id"]),
  );
  if (!pairing) {
    throw new Error(
      "No Markdown/Google Docs pairing matched; deletion propagation does not yet apply to Sheets/CSV pairings.",
    );
  }
  if (!options.yes) {
    throw new Error(
      "delete moves the paired Google Doc to Drive trash and removes the local Markdown file; repeat with --yes.",
    );
  }
  const auth = await getAuthClient();
  const services = createGoogleServices(auth);
  const state = await loadState();
  state.deletions ??= {};
  const deletion = state.deletions[pairing.documentId] ?? {
    phase: "waiting",
    documentId: pairing.documentId,
    documentUrl: pairing.documentUrl,
    absolutePath: pairing.absolutePath,
    missingSince: new Date().toISOString(),
  };
  const result = await trashPairedDocument({
    services,
    pairing: { ...pairing, deletionPolicy: settings.deletionPolicy },
    state,
    deletion,
    explicit: true,
    deleteLocal: true,
    persistState: saveState,
  });
  console.log(`Moved ${pairing.documentUrl} to Google Drive trash.`);
  console.log(`Deleted ${pairing.absolutePath} and removed its pairing.`);
  console.log(`Sent deletion email ${result.email.id}.`);
}

async function recoverDocument(options) {
  for (const required of ["document-id", "workspace", "file"]) {
    if (!options[required]) throw new Error(`recover requires --${required}.`);
  }
  const documentId = options["document-id"];
  const workspace = path.resolve(options.workspace);
  const absolutePath = path.resolve(workspace, options.file);
  if (absolutePath !== workspace && !absolutePath.startsWith(`${workspace}${path.sep}`)) {
    throw new Error("Recovery Markdown filename must stay inside the selected workspace.");
  }
  const pairings = await loadPairings();
  assertRecoveryTargetAvailable(pairings, documentId, absolutePath);
  const auth = await getAuthClient();
  const services = createGoogleServices(auth);
  const restored = await restoreDriveDocument(services, documentId);
  const backup = await preserveRecoveryContent(absolutePath);
  const documentUrl = `https://docs.google.com/document/d/${documentId}/edit`;
  try {
    await pair({
      url: documentUrl,
      workspace,
      file: path.relative(workspace, absolutePath),
      name: restored.name,
    });
  } catch (error) {
    const partial = (await loadPairings()).find((item) => item.documentId === documentId);
    if (partial) await removeDocumentPairing(partial);
    throw error;
  }
  const state = await loadState();
  if (clearRecoveryDeletion(state, documentId)) await saveState(state);
  const [verifiedFile, verifiedPairings] = await Promise.all([
    services.drive.files.get({ fileId: documentId, fields: "id,name,trashed" }),
    loadPairings(),
    fs.access(absolutePath),
  ]);
  if (verifiedFile.data.trashed) throw new Error("Recovery verification found the Doc in trash.");
  if (!verifiedPairings.some((item) => item.documentId === documentId && item.absolutePath === absolutePath)) {
    throw new Error("Recovery verification did not find the expected pairing.");
  }
  console.log(restored.wasTrashed
    ? `Restored ${documentUrl} from Google Drive trash.`
    : `${documentUrl} was already outside Google Drive trash.`);
  if (backup?.markdownPath) console.log(`Preserved local Markdown at ${backup.markdownPath}`);
  if (backup?.assetDirectory) console.log(`Preserved local assets at ${backup.assetDirectory}`);
  console.log(`Verified pairing at ${absolutePath}`);
  if (backup) {
    console.log("Compare the recovered Markdown with the backup, merge local-only changes, then run:");
    console.log(`gdms push --document-id ${documentId}`);
  }
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === "--version" || command === "version") {
    const [version, state] = await Promise.all([readPackageVersion(), loadState()]);
    console.log(formatVersionReport(version, state.daemon));
  } else if (command === "--help" || command === "help" || !command) {
    console.log(helpText());
  } else if (command === "auth") {
    await authorize();
    console.log("Google authorization stored in the macOS Keychain.");
  } else if (command === "pair") {
    await pair(options);
  } else if (command === "create") {
    await create(options);
  } else if (command === "create-sheet") {
    await createSheet(options);
  } else if (command === "pair-sheet") {
    await pairSheet(options);
  } else if (command === "plan") {
    await plan(options);
  } else if (command === "push") {
    await push(options);
  } else if (command === "cleanup-spacing") {
    await cleanupSpacing(options);
  } else if (command === "migrate") {
    if (!options.all && !options["document-id"]) {
      throw new Error("migrate requires --all or --document-id.");
    }
    const results = await runDocumentMigrations({
      dryRun: Boolean(options["dry-run"]),
      documentId: options["document-id"],
    });
    const counts = results.reduce((summary, result) => {
      summary[result.status] = (summary[result.status] ?? 0) + 1;
      return summary;
    }, {});
    console.log(`Migration summary: ${Object.entries(counts).map(([status, count]) => `${status}=${count}`).join(" ") || "no documents"}`);
    if (counts.error) process.exitCode = 1;
  } else if (command === "configure-r2") {
    await configureR2(options);
  } else if (command === "configure-deletion") {
    await configureDeletion(options);
  } else if (command === "configure-notifications") {
    await configureNotifications(options);
  } else if (command === "delete") {
    await deleteDocument(options);
  } else if (command === "recover") {
    await recoverDocument(options);
  } else if (command === "sync-once") {
    let announced = false;
    const results = await runSyncPass({
      onProgress(event) {
        if (!announced) {
          console.log(`Syncing ${event.total} pairing(s)…`);
          announced = true;
        }
        const line = formatSyncProgress(event);
        if (process.stdout.isTTY) {
          process.stdout.write(
            event.type === "start" ? `${line}\r` : `\u001b[2K\r${line}\n`,
          );
        } else {
          console.log(line);
        }
      },
    });
    if (!results.length) {
      console.log("No pairing files found.");
    } else {
      console.log(`Complete: ${syncSummary(results)}`);
      if (results.some((result) => result.action === "error")) process.exitCode = 1;
    }
  } else if (command === "daemon") {
    await runDaemon();
  } else if (command === "install-service") {
    const installedPath = await installLaunchAgent();
    console.log(`Installed and started ${installedPath}`);
  } else if (command === "install-finder-action") {
    const installedPath = await installFinderQuickAction();
    console.log(`Installed Finder Quick Actions under ${path.dirname(installedPath)}`);
  } else if (command === "heartbeat") {
    await runHeartbeat({
      recipient: options.to ?? process.env.GOOGLE_DOCS_SYNC_HEARTBEAT_TO,
      sender: options.from ?? process.env.GOOGLE_DOCS_SYNC_HEARTBEAT_FROM,
    });
  } else if (command === "install-heartbeat") {
    const settings = await loadSettings();
    const installedPath = await installHeartbeatLaunchAgent({
      recipient:
        options.to ??
        process.env.GOOGLE_DOCS_SYNC_HEARTBEAT_TO ??
        settings.notifications.recipient,
      sender:
        options.from ??
        process.env.GOOGLE_DOCS_SYNC_HEARTBEAT_FROM ??
        settings.notifications.sender ??
        "Google Docs Sync <onboarding@resend.dev>",
    });
    await installLaunchAgent();
    console.log(`Installed weekly heartbeat ${installedPath}`);
    console.log("Persistent sync-error email is enabled for the same recipient.");
  } else {
    console.error(`Unknown command: ${command}\n\n${helpText()}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  if (process.argv[2] === "daemon") {
    createTimestampLogger(console).error(error.message);
  } else {
    console.error(error.message);
  }
  process.exitCode = 1;
});
