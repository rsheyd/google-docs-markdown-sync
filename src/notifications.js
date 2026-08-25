import { execFileSync } from "node:child_process";
import { readResendToken } from "./heartbeat.js";
import { readJson, writeJsonAtomic } from "./files.js";
import { NOTIFICATION_STATE_PATH } from "./paths.js";

const DEFAULT_ERROR_EMAIL_DELAY_MS = 15 * 60_000;
const DEFAULT_TEMPORARY_ERROR_EMAIL_DELAY_MS = 30 * 60_000;
let notificationWriteTail = Promise.resolve();

function pairingKey(pairing) {
  return pairing.type === "spreadsheet" || pairing.spreadsheetId
    ? `spreadsheet:${pairing.spreadsheetId}`
    : `document:${pairing.documentId}`;
}

function saveNotificationState(state) {
  const result = notificationWriteTail.then(
    () => writeJsonAtomic(NOTIFICATION_STATE_PATH, state),
    () => writeJsonAtomic(NOTIFICATION_STATE_PATH, state),
  );
  notificationWriteTail = result.catch(() => undefined);
  return result;
}

export function classifySyncError(error) {
  const code = String(error.code ?? error.cause?.code ?? "").toUpperCase();
  const status = Number(error.status ?? error.response?.status);
  const message = String(error.message ?? "").toLowerCase();
  if (
    ["ABORT_ERR", "ECONNRESET", "ENETDOWN", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT"].includes(code) ||
    status === 429 ||
    status >= 500 ||
    message.includes("operation was aborted") ||
    message.includes("getaddrinfo") ||
    message.includes("socket hang up")
  ) {
    return "temporary-connectivity";
  }
  return "needs-attention";
}

function errorDetails(error) {
  return {
    message: error.message,
    ...(error.code ?? error.cause?.code ? { code: error.code ?? error.cause.code } : {}),
    ...(error.gdmsOperation ? { operation: error.gdmsOperation } : {}),
    ...(Number.isFinite(error.gdmsElapsedMs) ? { elapsedMs: error.gdmsElapsedMs } : {}),
  };
}

function formattedError(error, kind) {
  return [
    `kind=${kind}`,
    error.operation ? `operation=${error.operation}` : undefined,
    Number.isFinite(error.elapsedMs) ? `elapsedMs=${error.elapsedMs}` : undefined,
    error.code ? `code=${error.code}` : undefined,
    `error=${error.message}`,
  ].filter(Boolean).join(" ");
}

export function displaySyncNotification({ title, message, exec = execFileSync }) {
  exec(
    "/usr/bin/osascript",
    [
      "-e",
      "on run argv",
      "-e",
      "display notification (item 2 of argv) with title (item 1 of argv)",
      "-e",
      "end run",
      title,
      message,
    ],
    { stdio: "ignore" },
  );
}

export async function sendSyncErrorEmail({
  token = readResendToken(),
  recipient = process.env.GOOGLE_DOCS_SYNC_ERROR_TO,
  sender =
    process.env.GOOGLE_DOCS_SYNC_ERROR_FROM ??
    process.env.GOOGLE_DOCS_SYNC_HEARTBEAT_FROM ??
    "Google Docs Sync <onboarding@resend.dev>",
  pairing,
  error,
  errorKind,
  firstSeenAt,
  fetchImplementation = fetch,
} = {}) {
  if (!recipient) return undefined;
  const response = await fetchImplementation("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `gdms-sync-error-${pairing.documentId ?? pairing.spreadsheetId}-${firstSeenAt}`,
    },
    body: JSON.stringify({
      from: sender,
      to: [recipient],
      subject: `GDMS sync error: ${pairing.name ?? pairing.markdownPath ?? pairing.directoryPath}`,
      text: [
        "A Google Docs Markdown Sync error has persisted and needs attention.",
        "",
        `Pairing: ${pairing.name ?? pairing.markdownPath ?? pairing.directoryPath}`,
        `Local path: ${pairing.absolutePath}`,
        pairing.documentUrl ? `Google Doc: ${pairing.documentUrl}` : undefined,
        pairing.spreadsheetUrl ? `Google Sheet: ${pairing.spreadsheetUrl}` : undefined,
        `First seen: ${firstSeenAt}`,
        errorKind ? `Kind: ${errorKind}` : undefined,
        error.operation ? `Operation: ${error.operation}` : undefined,
        `Error: ${error.message}`,
        "",
        "GDMS will keep retrying safely and will not overwrite a detected conflict.",
      ].filter(Boolean).join("\n"),
    }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      `Resend rejected the sync-error email (${response.status}): ${body.message ?? JSON.stringify(body)}`,
    );
  }
  return body;
}

export async function sendSyncRecoveryEmail({
  token = readResendToken(),
  recipient,
  sender =
    process.env.GOOGLE_DOCS_SYNC_ERROR_FROM ??
    process.env.GOOGLE_DOCS_SYNC_HEARTBEAT_FROM ??
    "Google Docs Sync <onboarding@resend.dev>",
  pairing,
  error,
  firstSeenAt,
  recoveredAt,
  fetchImplementation = fetch,
} = {}) {
  if (!recipient) return undefined;
  const response = await fetchImplementation("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `gdms-sync-recovery-${pairing.documentId ?? pairing.spreadsheetId}-${firstSeenAt}`,
    },
    body: JSON.stringify({
      from: sender,
      to: [recipient],
      subject: `GDMS sync recovered: ${pairing.name ?? pairing.markdownPath ?? pairing.directoryPath}`,
      text: [
        "Google Docs Markdown Sync recovered from a previously emailed error.",
        "",
        `Pairing: ${pairing.name ?? pairing.markdownPath ?? pairing.directoryPath}`,
        `Local path: ${pairing.absolutePath}`,
        `Original error: ${error.message}`,
        `First seen: ${firstSeenAt}`,
        `Recovered: ${recoveredAt}`,
      ].join("\n"),
    }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      `Resend rejected the sync-recovery email (${response.status}): ${body.message ?? JSON.stringify(body)}`,
    );
  }
  return body;
}

export function createSyncErrorReporter({
  logger = console,
  notify = displaySyncNotification,
  sendEmail = sendSyncErrorEmail,
  sendRecoveryEmail = sendSyncRecoveryEmail,
  desktopNotificationsEnabled = false,
  emailDelayMs = Number(
    process.env.GOOGLE_DOCS_SYNC_ERROR_EMAIL_DELAY_MS ?? DEFAULT_ERROR_EMAIL_DELAY_MS,
  ),
  temporaryEmailDelayMs = Math.max(
    DEFAULT_TEMPORARY_ERROR_EMAIL_DELAY_MS,
    emailDelayMs,
  ),
  emailRecipient = process.env.GOOGLE_DOCS_SYNC_ERROR_TO,
  emailSender = process.env.GOOGLE_DOCS_SYNC_ERROR_FROM,
  now = () => new Date(),
  loadIncidents = () => readJson(
    NOTIFICATION_STATE_PATH,
    { version: 1, incidents: {} },
  ),
  persistIncidents = saveNotificationState,
} = {}) {
  const active = new Map();
  let loaded;

  async function ensureLoaded() {
    loaded ??= (async () => {
      try {
        const state = await loadIncidents();
        for (const [key, record] of Object.entries(state.incidents ?? {})) {
          active.set(key, record);
        }
      } catch (error) {
        logger.error(`notification state: ${error.message}`);
      }
    })();
    await loaded;
  }

  async function persist() {
    try {
      await persistIncidents({
        version: 1,
        incidents: Object.fromEntries(active),
      });
    } catch (error) {
      logger.error(`notification state: ${error.message}`);
    }
  }

  async function report(pairing, error) {
    await ensureLoaded();
    const key = pairingKey(pairing);
    const kind = classifySyncError(error);
    let record = active.get(key);
    if (!record || record.kind !== kind) {
      record = {
        kind,
        error: errorDetails(error),
        firstSeenAt: now().toISOString(),
      };
      active.set(key, record);
      await persist();
      logger.error(`${pairing.absolutePath}: ${formattedError(record.error, kind)}`);
      if (desktopNotificationsEnabled) {
        try {
          notify({
            title: "GDMS sync needs attention",
            message: `${pairing.name ?? pairing.markdownPath}: ${error.message}`,
          });
        } catch (notificationError) {
          logger.error(`notification: ${notificationError.message}`);
        }
      }
    }
    const ageMs = now().getTime() - Date.parse(record.firstSeenAt);
    const delayMs = kind === "temporary-connectivity"
      ? temporaryEmailDelayMs
      : emailDelayMs;
    if (emailRecipient && !record.emailSentAt && ageMs >= delayMs) {
      try {
        const email = await sendEmail({
          recipient: emailRecipient,
          sender: emailSender,
          pairing,
          error: record.error,
          errorKind: record.kind,
          firstSeenAt: record.firstSeenAt,
        });
        record.emailSentAt = now().toISOString();
        await persist();
        logger.log(`sync-error email sent for ${pairing.absolutePath}: ${email.id}`);
      } catch (emailError) {
        logger.error(`sync-error email: ${emailError.message}`);
      }
    }
  }

  async function reconcile(results) {
    await ensureLoaded();
    for (const result of results) {
      if (result.action === "error") continue;
      const key = pairingKey(result.pairing);
      const record = active.get(key);
      if (!record) continue;
      active.delete(key);
      await persist();
      logger.log(`recovered: ${result.pairing.absolutePath}`);
      if (record.emailSentAt && emailRecipient) {
        try {
          await sendRecoveryEmail({
            recipient: emailRecipient,
            sender: emailSender,
            pairing: result.pairing,
            error: record.error,
            firstSeenAt: record.firstSeenAt,
            recoveredAt: now().toISOString(),
          });
          logger.log(`sync-recovery email sent for ${result.pairing.absolutePath}`);
        } catch (emailError) {
          logger.error(`sync-recovery email: ${emailError.message}`);
        }
      }
      if (desktopNotificationsEnabled) {
        try {
          notify({
            title: "GDMS sync recovered",
            message: `${result.pairing.name ?? result.pairing.markdownPath} is syncing normally again.`,
          });
        } catch (notificationError) {
          logger.error(`notification: ${notificationError.message}`);
        }
      }
    }
  }

  return { report, reconcile };
}

export { DEFAULT_ERROR_EMAIL_DELAY_MS };
