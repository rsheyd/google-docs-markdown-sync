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


test("backs off failed remote polls with bounded jitter", () => {
  assert.equal(backoffDelay(5_000, 0, () => 0.5), 5_000);
  assert.equal(backoffDelay(5_000, 1, () => 0.5), 10_500);
  assert.equal(backoffDelay(5_000, 10, () => 0.5), 60_000);
});

test("move detection proceeds after its deadline even when a sync pass runs long", () => {
  const missing = new Map();
  assert.equal(shouldDeferMissingPath(missing, "/note.md", 10_000, 1_000), true);
  assert.equal(shouldDeferMissingPath(missing, "/note.md", 10_000, 10_999), true);
  assert.equal(shouldDeferMissingPath(missing, "/note.md", 10_000, 15_000), false);
  assert.equal(missing.has("/note.md"), false);
});

test("records daemon identity and exits when the package version changes", async () => {
  const versions = ["0.6.3", "0.7.0"];
  const saved = [];
  const logs = [];
  await runDaemon({
    getVersion: async () => versions.shift(),
    getState: async () => ({ version: 1, documents: {} }),
    persistState: async (state) => saved.push(structuredClone(state)),
    logger: {
      log: (...values) => logs.push(values.join(" ")),
      error: (...values) => logs.push(values.join(" ")),
    },
  });
  assert.equal(saved[0].daemon.version, "0.6.3");
  assert.equal(saved[0].daemon.pid, process.pid);
  assert.match(saved[0].daemon.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(logs.join("\n"), /version-change: 0\.6\.3 -> 0\.7\.0/);
});
