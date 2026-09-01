import test from "node:test";
import assert from "node:assert/strict";
import {
  createTimestampLogger,
  formatSyncProgress,
  localIsoTimestamp,
  syncSummary,
} from "../src/progress.js";

const pairing = { markdownPath: "notes/meeting.md" };

test("formats stable sync-once progress lines", () => {
  assert.equal(
    formatSyncProgress({ type: "start", current: 1, total: 3, pairing }),
    "[1/3] notes/meeting.md … syncing",
  );
  assert.equal(
    formatSyncProgress({
      type: "complete",
      current: 2,
      total: 3,
      pairing: {
        ...pairing,
        deletionPolicy: {
          mode: "trash-after-grace-period",
          gracePeriodMinutes: 1,
        },
      },
      action: "defer",
      moveDetectionSeconds: 10,
    }),
    "[2/3] notes/meeting.md … missing locally; waiting up to 10 second(s) to detect a move before starting the 1-minute deletion grace period",
  );
  assert.equal(
    formatSyncProgress({
      type: "complete",
      current: 2,
      total: 3,
      pairing,
      action: "pending-trash",
      remainingSeconds: 42,
    }),
    "[2/3] notes/meeting.md … deletion grace period active; 42 second(s) remaining",
  );
  assert.equal(
    formatSyncProgress({ type: "complete", current: 1, total: 3, pairing, action: "pull" }),
    "[1/3] notes/meeting.md … pulled",
  );
  assert.equal(
    formatSyncProgress({
      type: "complete",
      current: 3,
      total: 3,
      pairing,
      action: "error",
      error: new Error("permission denied"),
    }),
    "[3/3] notes/meeting.md … error: permission denied",
  );
});

test("summarizes sync results by user-facing action", () => {
  assert.equal(
    syncSummary([
      { action: "pull" },
      { action: "push" },
      { action: "checked" },
      { action: "none" },
      { action: "error" },
    ]),
    "1 pulled, 1 pushed, 1 checked and refreshed status, 1 unchanged, 1 error",
  );
});

test("prefixes daemon logs and errors with local-offset ISO timestamps", () => {
  const date = new Date("2026-08-14T15:42:08.000Z");
  const messages = [];
  const logger = createTimestampLogger({
    log: (...values) => messages.push(["log", ...values]),
    error: (...values) => messages.push(["error", ...values]),
  }, () => date);
  logger.log("started");
  logger.error("failed");
  const timestamp = localIsoTimestamp(date);
  assert.match(timestamp, /^2026-08-14T\d{2}:42:08[+-]\d{2}:\d{2}$/);
  assert.deepEqual(messages, [
    ["log", timestamp, "started"],
    ["error", timestamp, "failed"],
  ]);
});
