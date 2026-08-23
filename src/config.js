import { readJson, writeJsonAtomic } from "./files.js";
import fs from "node:fs/promises";
import { HEARTBEAT_LAUNCH_AGENT_PATH, SETTINGS_PATH } from "./paths.js";

const DEFAULT_GOOGLE_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_DELETION_POLICY = Object.freeze({ mode: "restore-local" });
export const DEFAULT_NOTIFICATION_SETTINGS = Object.freeze({
  desktopNotificationsEnabled: false,
  errorEmailEnabled: true,
  errorEmailDelayMinutes: 15,
});

export function validateNotificationSettings(value = {}, source = SETTINGS_PATH) {
  const settings = { ...DEFAULT_NOTIFICATION_SETTINGS, ...value };
  if (settings.recipient !== undefined && !String(settings.recipient).trim()) {
    throw new Error(`${source} notifications.recipient must be a non-empty email address.`);
  }
  if (
    !Number.isFinite(settings.errorEmailDelayMinutes) ||
    settings.errorEmailDelayMinutes < 0
  ) {
    throw new Error(`${source} notifications.errorEmailDelayMinutes must be zero or greater.`);
  }
  return settings;
}

function xmlUnescape(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

export function notificationSettingsFromHeartbeatPlist(plist) {
  const valueFor = (name) => {
    const match = plist.match(
      new RegExp(`<key>${name}</key>\\s*<string>([^<]*)</string>`),
    );
    return match ? xmlUnescape(match[1]) : undefined;
  };
  const recipient = valueFor("GOOGLE_DOCS_SYNC_HEARTBEAT_TO");
  if (!recipient) return undefined;
  const sender = valueFor("GOOGLE_DOCS_SYNC_HEARTBEAT_FROM");
  return validateNotificationSettings({
    recipient,
    ...(sender ? { sender } : {}),
  });
}

export function googleRequestTimeoutMs(
  value = process.env.GOOGLE_DOCS_SYNC_REQUEST_TIMEOUT_MS,
) {
  if (value === undefined || value === "") {
    return DEFAULT_GOOGLE_REQUEST_TIMEOUT_MS;
  }
  const timeout = Number(value);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(
      "GOOGLE_DOCS_SYNC_REQUEST_TIMEOUT_MS must be a positive number.",
    );
  }
  return timeout;
}

export { DEFAULT_GOOGLE_REQUEST_TIMEOUT_MS };

export function validateDeletionPolicy(policy, source = SETTINGS_PATH) {
  const value = policy ?? DEFAULT_DELETION_POLICY;
  if (!["restore-local", "trash-after-grace-period"].includes(value.mode)) {
    throw new Error(`${source} has an unsupported deletionPolicy mode.`);
  }
  if (value.mode === "trash-after-grace-period") {
    if (!Number.isInteger(value.gracePeriodMinutes) || value.gracePeriodMinutes < 1) {
      throw new Error(`${source} deletionPolicy.gracePeriodMinutes must be a positive integer.`);
    }
    if (!String(value.notificationEmail ?? "").trim()) {
      throw new Error(`${source} deletionPolicy.notificationEmail is required.`);
    }
  }
  return value;
}

export async function loadSettings() {
  const settings = await readJson(SETTINGS_PATH, { version: 1 });
  if (settings.version !== 1) {
    throw new Error(`${SETTINGS_PATH} must have version 1.`);
  }
  return {
    ...settings,
    deletionPolicy: validateDeletionPolicy(settings.deletionPolicy),
    notifications: validateNotificationSettings(settings.notifications),
  };
}

export async function saveDeletionPolicy(deletionPolicy) {
  const policy = validateDeletionPolicy(deletionPolicy);
  const settings = await readJson(SETTINGS_PATH, { version: 1 });
  await writeJsonAtomic(SETTINGS_PATH, {
    ...settings,
    version: 1,
    deletionPolicy: policy,
  });
  return policy;
}

export async function saveNotificationSettings(notifications) {
  const value = validateNotificationSettings(notifications);
  const settings = await readJson(SETTINGS_PATH, { version: 1 });
  await writeJsonAtomic(SETTINGS_PATH, {
    ...settings,
    version: 1,
    notifications: value,
  });
  return value;
}

export async function migrateHeartbeatNotificationSettings({
  readFile = fs.readFile,
} = {}) {
  const settings = await readJson(SETTINGS_PATH, { version: 1 });
  if (settings.notifications?.recipient) {
    return saveNotificationSettings(settings.notifications);
  }
  const plist = await readFile(HEARTBEAT_LAUNCH_AGENT_PATH, "utf8").catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!plist) return undefined;
  const notifications = notificationSettingsFromHeartbeatPlist(plist);
  if (!notifications) return undefined;
  return saveNotificationSettings(notifications);
}
