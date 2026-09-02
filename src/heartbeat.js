import { execFileSync } from "node:child_process";
import path from "node:path";
import { getAuthClient } from "./auth.js";
import { createGoogleServices, getRemoteInfo } from "./google.js";
import { loadPairings } from "./manifests.js";
import { getSpreadsheetInfo } from "./sheets.js";
import { loadSettings } from "./config.js";
import { loadState } from "./state.js";

export const RESEND_KEYCHAIN_SERVICE =
  "com.roman.google-docs-markdown-sync";
export const RESEND_KEYCHAIN_ACCOUNT = "resend-api";

export function readResendToken() {
  try {
    return execFileSync(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-s",
        RESEND_KEYCHAIN_SERVICE,
        "-a",
        RESEND_KEYCHAIN_ACCOUNT,
        "-w",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    throw new Error("No Resend API token found in macOS Keychain.");
  }
}

export function assertDaemonRunning({
  uid = process.getuid(),
  exec = execFileSync,
} = {}) {
  const output = exec(
    "/bin/launchctl",
    ["print", `gui/${uid}/com.roman.google-docs-markdown-sync`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (!/\bstate = running\b/.test(output)) {
    throw new Error("The synchronization daemon is not running.");
  }
}

export async function verifySyncHealth({
  assertRunning = assertDaemonRunning,
  getAuth = getAuthClient,
  getPairings = loadPairings,
  makeServices = createGoogleServices,
  readRemote = getRemoteInfo,
  readSpreadsheet = getSpreadsheetInfo,
  getState = loadState,
} = {}) {
  assertRunning();
  const pairings = await getPairings();
  if (!pairings.length) throw new Error("No Google Docs or Sheets pairings were found.");
  const services = makeServices(await getAuth());
  await Promise.all(
    pairings.map((pairing) => pairing.type === "spreadsheet"
      ? readSpreadsheet(services, pairing.spreadsheetId)
      : readRemote(services, pairing.documentId)),
  );
  const state = await getState();
  return {
    documents: pairings.filter((pairing) => pairing.type !== "spreadsheet").length,
    spreadsheets: pairings.filter((pairing) => pairing.type === "spreadsheet").length,
    lastRemotePollAt: state.remoteChanges?.lastPolledAt,
    lastReconciledAt: state.remoteChanges?.lastReconciledAt,
  };
}

export async function sendHeartbeatEmail({
  token = readResendToken(),
  recipient = process.env.GOOGLE_DOCS_SYNC_HEARTBEAT_TO,
  sender =
    process.env.GOOGLE_DOCS_SYNC_HEARTBEAT_FROM ??
    "Google Docs Sync <onboarding@resend.dev>",
  result,
  fetchImplementation = fetch,
} = {}) {
  if (!recipient) {
    throw new Error("GOOGLE_DOCS_SYNC_HEARTBEAT_TO is not configured.");
  }
  const checkedAt = new Date().toLocaleString("en-US", {
    dateStyle: "full",
    timeStyle: "long",
  });
  const response = await fetchImplementation("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: sender,
      to: [recipient],
      subject: "Google Docs Markdown Sync is healthy",
      text: [
        "The independent weekly health check passed.",
        "",
        `Synchronization daemon: running`,
        `Google documents checked: ${result.documents}`,
        `Google spreadsheets checked: ${result.spreadsheets ?? 0}`,
        `Last successful remote poll: ${result.lastRemotePollAt ?? "not recorded"}`,
        `Last complete reconciliation: ${result.lastReconciledAt ?? "not recorded"}`,
        `Checked: ${checkedAt}`,
        "",
        "If this weekly email does not arrive, check the sync service and heartbeat LaunchAgent.",
      ].join("\n"),
    }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      `Resend rejected the heartbeat email (${response.status}): ${body.message ?? JSON.stringify(body)}`,
    );
  }
  return body;
}

export async function sendDeletionEmail({
  token = readResendToken(),
  recipient =
    process.env.GOOGLE_DOCS_SYNC_DELETE_TO ??
    process.env.GOOGLE_DOCS_SYNC_HEARTBEAT_TO,
  sender =
    process.env.GOOGLE_DOCS_SYNC_DELETE_FROM ??
    process.env.GOOGLE_DOCS_SYNC_HEARTBEAT_FROM ??
    "Google Docs Sync <onboarding@resend.dev>",
  deletion,
  fetchImplementation = fetch,
} = {}) {
  if (!recipient) {
    throw new Error(
      "No deletion email recipient is configured. Set GOOGLE_DOCS_SYNC_DELETE_TO.",
    );
  }
  const recoveryLines = [
    "You can recover the same document from Google Drive trash. The GDMS pairing has been removed.",
  ];
  if (deletion.manifestPath && deletion.absolutePath) {
    const syncLocation = path.dirname(deletion.manifestPath);
    recoveryLines.push(
      "Preserve any local-only content, then restore and re-pair it with:",
      `gdms recover --document-id ${deletion.documentId} --sync-location ${JSON.stringify(syncLocation)} --file ${JSON.stringify(path.relative(syncLocation, deletion.absolutePath))}`,
    );
  } else {
    recoveryLines.push("Use `gdms recover --help` for the safe restoration workflow.");
  }
  const response = await fetchImplementation("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `gdms-delete-${deletion.documentId}-${deletion.trashedAt}`,
    },
    body: JSON.stringify({
      from: sender,
      to: [recipient],
      subject: `GDMS moved “${deletion.name ?? "Google Doc"}” to trash`,
      text: [
        "GDMS moved a paired Google Doc to Google Drive trash.",
        "",
        `Document: ${deletion.name ?? "Google Doc"}`,
        `Google Doc: ${deletion.documentUrl}`,
        `Local Markdown: ${deletion.absolutePath}`,
        `Deletion policy: ${deletion.policyDescription}`,
        `Moved to trash: ${deletion.trashedAt}`,
        "",
        ...recoveryLines,
      ].join("\n"),
    }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      `Resend rejected the deletion email (${response.status}): ${body.message ?? JSON.stringify(body)}`,
    );
  }
  return body;
}

export async function runHeartbeat({ recipient, sender } = {}) {
  const settings = await loadSettings();
  recipient ??= settings.notifications.recipient;
  sender ??= settings.notifications.sender;
  const result = await verifySyncHealth();
  const email = await sendHeartbeatEmail({ result, recipient, sender });
  console.log(
    `Heartbeat passed for ${result.documents} document(s) and ${result.spreadsheets} spreadsheet(s); email ${email.id} sent.`,
  );
  return { result, email };
}
