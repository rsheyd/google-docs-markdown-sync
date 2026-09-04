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


test("detects writes to a paired Markdown file", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gdocs-sync-watch-"));
  const filePath = path.join(directory, "paired.md");
  await fs.writeFile(filePath, "before\n");
  let watcherManager;
  try {
    const detected = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for fs.watch")),
        2_000,
      );
      watcherManager = createWatcherManager({
        logger: { error: reject },
        onChange(changedPath) {
          clearTimeout(timer);
          resolve(changedPath);
        },
      });
    });
    watcherManager.refresh([{ absolutePath: filePath }]);
    await fs.writeFile(filePath, "after\n");
    assert.equal(await detected, filePath);
  } finally {
    watcherManager?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("detects writes to a paired Markdown asset", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gdocs-sync-watch-"));
  const filePath = path.join(directory, "paired.md");
  const assetDirectory = path.join(directory, "paired.assets");
  const assetPath = path.join(assetDirectory, "image.png");
  await fs.writeFile(filePath, "![Screenshot](paired.assets/image.png)\n");
  await fs.mkdir(assetDirectory);
  await fs.writeFile(assetPath, "before");
  let watcherManager;
  try {
    const detected = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for asset change")),
        2_000,
      );
      watcherManager = createWatcherManager({
        logger: { error: reject },
        onChange(changedPath) {
          clearTimeout(timer);
          resolve(changedPath);
        },
      });
    });
    await watcherManager.refresh([{ absolutePath: filePath }]);
    await fs.writeFile(assetPath, "after");
    assert.equal(await detected, filePath);
  } finally {
    watcherManager?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
