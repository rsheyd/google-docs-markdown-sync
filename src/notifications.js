import { execFileSync } from "node:child_process";
import { readResendToken } from "./heartbeat.js";

const DEFAULT_ERROR_EMAIL_DELAY_MS = 15 * 60_000;

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
        `First seen: ${firstSeenAt}`,
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
  emailRecipient = process.env.GOOGLE_DOCS_SYNC_ERROR_TO,
  emailSender = process.env.GOOGLE_DOCS_SYNC_ERROR_FROM,
  now = () => new Date(),
} = {}) {
  const active = new Map();

  async function report(pairing, error) {
    const key = pairing.absolutePath;
    const fingerprint = error.message;
    let record = active.get(key);
    if (!record || record.fingerprint !== fingerprint) {
      record = {
        fingerprint,
        error,
        firstSeenAt: now().toISOString(),
        emailSent: false,
      };
      active.set(key, record);
      logger.error(`${pairing.absolutePath}: ${error.message}`);
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
    if (emailRecipient && !record.emailSent && ageMs >= emailDelayMs) {
      try {
        const email = await sendEmail({
          recipient: emailRecipient,
          sender: emailSender,
          pairing,
          error: record.error,
          firstSeenAt: record.firstSeenAt,
        });
        record.emailSent = true;
        logger.log(`sync-error email sent for ${pairing.absolutePath}: ${email.id}`);
      } catch (emailError) {
        logger.error(`sync-error email: ${emailError.message}`);
      }
    }
  }

  async function reconcile(results) {
    for (const result of results) {
      if (result.action === "error") continue;
      const record = active.get(result.pairing.absolutePath);
      if (!record) continue;
      active.delete(result.pairing.absolutePath);
      logger.log(`recovered: ${result.pairing.absolutePath}`);
      if (record.emailSent && emailRecipient) {
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
