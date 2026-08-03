import { execFileSync } from "node:child_process";
import { getAuthClient } from "./auth.js";
import { createGoogleServices, getRemoteInfo } from "./google.js";
import { loadPairings } from "./manifests.js";
import { getSpreadsheetInfo } from "./sheets.js";

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
  return {
    documents: pairings.filter((pairing) => pairing.type !== "spreadsheet").length,
    spreadsheets: pairings.filter((pairing) => pairing.type === "spreadsheet").length,
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

export async function runHeartbeat({ recipient, sender } = {}) {
  const result = await verifySyncHealth();
  const email = await sendHeartbeatEmail({ result, recipient, sender });
  console.log(
    `Heartbeat passed for ${result.documents} document(s) and ${result.spreadsheets} spreadsheet(s); email ${email.id} sent.`,
  );
  return { result, email };
}
