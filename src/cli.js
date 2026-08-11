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
import { R2_CONFIG_PATH } from "./paths.js";
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
import {
  defaultDocumentTitle,
  loadPairings,
  registerPairing,
} from "./manifests.js";
import { registerSpreadsheetPairing } from "./manifests.js";
import { loadState, saveState, stateKey } from "./state.js";
import { runDaemon, runSyncPass } from "./sync.js";
import { installFinderQuickAction } from "./finder-quick-action.js";
import {
  getSpreadsheetInfo,
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

function parseArguments(values) {
  const [command, ...rest] = values;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith("--")) continue;
    options[value.slice(2)] = rest[index + 1];
    index += 1;
  }
  return { command, options };
}

async function pair(options) {
  for (const required of ["url", "workspace", "file"]) {
    if (!options[required]) throw new Error(`pair requires --${required}.`);
  }
  const pairing = await registerPairing({
    workspace: options.workspace,
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
  const markdown = await materializeRemoteImages(
    services,
    pairing,
    remote.document,
    exportedMarkdown,
  );
  const status = {
    content: markdown,
    lastWriter: "google-docs",
    lastSuccessfulSync: new Date().toISOString(),
  };
  await writeTextAtomic(pairing.absolutePath, documentStatusMarkdown(pairing, status));
  const finalRemote = await updateDocumentStatus(
    services,
    pairing.documentId,
    remoteDocumentStatusMarkdown(pairing, status),
  );
  const stat = await import("node:fs/promises").then((fs) =>
    fs.stat(pairing.absolutePath),
  );
  const state = await loadState();
  state.documents[stateKey(pairing)] = {
    localHash: await hashMarkdownWithAssets(pairing.absolutePath, markdown),
    localModifiedTime: stat.mtimeMs,
    remoteRevisionId: finalRemote.revisionId,
    remoteModifiedTime: finalRemote.modifiedTime,
    lastWriter: "google-docs",
    lastSuccessfulSync: new Date().toISOString(),
  };
  await saveState(state);
  console.log(`Paired ${pairing.documentUrl}`);
  console.log(`Created ${pairing.absolutePath}`);
  console.log(`Updated ${path.join(pairing.workspace, "google-docs-sync.json")}`);
}

async function create(options) {
  if (!options.file) throw new Error("create requires --file.");
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
  const content = stripDocumentStatus(markdown);
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
  const content = stripDocumentStatus(markdown);
  const status = {
    content,
    lastWriter: "markdown",
    lastSuccessfulSync: new Date().toISOString(),
  };
  await writeTextAtomic(pairing.absolutePath, documentStatusMarkdown(pairing, status));
  const services = createGoogleServices(auth);
  const before = await getRemoteInfo(services, pairing.documentId);
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
    localHash: await hashMarkdownWithAssets(pairing.absolutePath, content),
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

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === "auth") {
    await authorize();
    console.log("Google authorization stored in the macOS Keychain.");
  } else if (command === "pair") {
    await pair(options);
  } else if (command === "create") {
    await create(options);
  } else if (command === "pair-sheet") {
    await pairSheet(options);
  } else if (command === "plan") {
    await plan(options);
  } else if (command === "push") {
    await push(options);
  } else if (command === "cleanup-spacing") {
    await cleanupSpacing(options);
  } else if (command === "configure-r2") {
    await configureR2(options);
  } else if (command === "sync-once") {
    const results = await runSyncPass();
    if (!results.length) console.log("No pairing files found.");
  } else if (command === "daemon") {
    await runDaemon();
  } else if (command === "install-service") {
    const installedPath = await installLaunchAgent();
    console.log(`Installed and started ${installedPath}`);
  } else if (command === "install-finder-action") {
    const installedPath = await installFinderQuickAction();
    console.log(`Installed Finder Quick Action ${installedPath}`);
  } else if (command === "heartbeat") {
    await runHeartbeat({
      recipient: options.to ?? process.env.GOOGLE_DOCS_SYNC_HEARTBEAT_TO,
      sender: options.from ?? process.env.GOOGLE_DOCS_SYNC_HEARTBEAT_FROM,
    });
  } else if (command === "install-heartbeat") {
    const installedPath = await installHeartbeatLaunchAgent({
      recipient: options.to ?? "s.roman@gmail.com",
      sender:
        options.from ?? "Google Docs Sync <onboarding@resend.dev>",
    });
    console.log(`Installed weekly heartbeat ${installedPath}`);
  } else {
    console.log(`Usage:
  node src/cli.js auth
  node src/cli.js create --file RELATIVE.md [--workspace PATH] [--name NAME]
  node src/cli.js pair --url URL --workspace PATH --file RELATIVE.md [--name NAME]
  node src/cli.js pair-sheet --url URL --workspace PATH --directory RELATIVE_DIRECTORY [--name NAME]
  node src/cli.js plan --document-id ID
  node src/cli.js push (--document-id ID | --spreadsheet-id ID)
  node src/cli.js cleanup-spacing --document-id ID
  node src/cli.js configure-r2 --account-id ID --bucket NAME --gateway-url URL
  node src/cli.js sync-once
  node src/cli.js daemon
  node src/cli.js install-service
  node src/cli.js install-finder-action
  node src/cli.js heartbeat --to EMAIL [--from SENDER]
  node src/cli.js install-heartbeat [--to EMAIL] [--from SENDER]`);
    process.exitCode = command ? 1 : 0;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
