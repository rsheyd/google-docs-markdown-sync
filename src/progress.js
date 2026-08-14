const ACTION_LABELS = {
  none: "unchanged",
  pull: "pulled",
  push: "pushed",
  style: "styled",
  "repair-status": "repaired status",
  trash: "Google Doc moved to Drive trash and pairing removed",
};

function pad(value, width = 2) {
  return String(value).padStart(width, "0");
}

export function localIsoTimestamp(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    `${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`,
  ].join("");
}

export function createTimestampLogger(logger = console, now = () => new Date()) {
  return {
    log(...values) {
      logger.log(localIsoTimestamp(now()), ...values);
    },
    error(...values) {
      logger.error(localIsoTimestamp(now()), ...values);
    },
  };
}

export function pairingDisplayPath(pairing) {
  return pairing.markdownPath ?? pairing.directoryPath ?? pairing.absolutePath;
}

export function formatSyncProgress(event) {
  const prefix = `[${event.current}/${event.total}] ${pairingDisplayPath(event.pairing)}`;
  if (event.type === "start") return `${prefix} … syncing`;
  if (event.action === "error") return `${prefix} … error: ${event.error.message}`;
  if (event.action === "defer") {
    const reason = event.pairing.deletionPolicy?.mode === "trash-after-grace-period"
      ? `waiting up to ${event.moveDetectionSeconds} second(s) to detect a move before starting the ${event.pairing.deletionPolicy.gracePeriodMinutes}-minute deletion grace period`
      : `waiting up to ${event.moveDetectionSeconds} second(s) to detect a move before restoring from Google Docs`;
    return `${prefix} … missing locally; ${reason}`;
  }
  if (event.action === "pending-trash") {
    return `${prefix} … deletion grace period active; ${event.remainingSeconds} second(s) remaining`;
  }
  return `${prefix} … ${ACTION_LABELS[event.action] ?? event.action}`;
}

export function syncSummary(results) {
  const counts = new Map();
  for (const result of results) {
    const label = result.action === "error"
      ? "error"
      : ACTION_LABELS[result.action] ?? result.action;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => `${count} ${label}`)
    .join(", ");
}
