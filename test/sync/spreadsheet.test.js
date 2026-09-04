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


test("polls only Drive for an unchanged spreadsheet", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gsheets-poll-"));
  const pairing = {
    type: "spreadsheet",
    spreadsheetId: "spreadsheet",
    absolutePath: directory,
    name: "Jobs",
  };
  await fs.writeFile(path.join(directory, "Jobs.csv"), "Role,Status\nEngineer,Applied\n");
  await fs.writeFile(path.join(directory, ".google-sheets-sync.json"), JSON.stringify({
    version: 1,
    spreadsheetId: "spreadsheet",
    sheets: [{ sheetId: 1, title: "Jobs", file: "Jobs.csv" }],
  }));
  const local = await readLocalSpreadsheet(directory);
  const baseline = {
    localHash: local.hash,
    remoteRevisionId: "7",
    remoteModifiedTime: "2026-08-23T12:00:00.000Z",
    lastWriter: "google-sheets",
    lastSuccessfulSync: "2026-08-23T12:00:00.000Z",
  };
  await fs.writeFile(
    path.join(directory, "GDMS.md"),
    spreadsheetStatusMarkdown(pairing, baseline, {
      version: 2,
      spreadsheetId: pairing.spreadsheetId,
      sheets: local.metadata.sheets,
    }),
  );
  let sheetsRequests = 0;
  const services = {
    drive: { files: { get: async () => ({ data: {
      modifiedTime: baseline.remoteModifiedTime,
      name: "Jobs",
      version: baseline.remoteRevisionId,
    } }) } },
    sheets: { spreadsheets: { get: async () => {
      sheetsRequests += 1;
      throw new Error("Sheets metadata should not be requested");
    } } },
  };
  try {
    const result = await syncPairing(services, pairing, baseline);
    assert.equal(result.action, "none");
    assert.equal(sheetsRequests, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
