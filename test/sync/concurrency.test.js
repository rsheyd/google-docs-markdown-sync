import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { readLocalSpreadsheet } from "../../src/sheets.js";
import { documentStatusMarkdown, spreadsheetStatusMarkdown } from "../../src/status.js";
import {
  backoffDelay,
  chooseSyncAction,
  commitSyncPass,
  comparableMarkdownHash,
  createSingleFlight,
  createWatcherManager,
  hasImageConflict,
  pullDocument,
  refineTwoSidedAction,
  runDaemon,
  shouldRaiseImageConflict,
  shouldDeferMissingPath,
  syncPairing,
} from "../../src/sync.js";


test("serializes overlapping sync operations", async () => {
  const enqueue = createSingleFlight();
  const events = [];
  let releaseFirst;
  const first = enqueue(async () => {
    events.push("first:start");
    await new Promise((resolve) => {
      releaseFirst = resolve;
    });
    events.push("first:end");
  });
  const second = enqueue(async () => {
    events.push("second:start");
    events.push("second:end");
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, [
    "first:start",
    "first:end",
    "second:start",
    "second:end",
  ]);
});

test("does not persist or reconcile an interrupted sync pass", async () => {
  const events = [];
  await assert.rejects(
    commitSyncPass({
      results: [{
        action: "error",
        pairing: { absolutePath: "/paired.md" },
        error: new Error("request aborted"),
      }],
      state: { version: 1, documents: {} },
      isCurrent: () => false,
      errorReporter: {
        report: async () => events.push("report"),
        reconcile: async () => events.push("reconcile"),
      },
      retryNotifications: async () => events.push("retry"),
      persistState: async () => events.push("persist"),
    }),
    { name: "SyncPassInterruptedError" },
  );
  assert.deepEqual(events, []);
});
