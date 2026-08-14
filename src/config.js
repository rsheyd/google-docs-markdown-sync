import { readJson, writeJsonAtomic } from "./files.js";
import { SETTINGS_PATH } from "./paths.js";

const DEFAULT_GOOGLE_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_DELETION_POLICY = Object.freeze({ mode: "restore-local" });

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
