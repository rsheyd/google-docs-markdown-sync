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


test("polls only Drive for an unchanged Google Doc with a lightweight baseline", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gdocs-lightweight-poll-"));
  const filePath = path.join(directory, "paired.md");
  const pairing = {
    documentId: "document",
    documentUrl: "https://docs.google.com/document/d/document/edit",
    syncLocation: directory,
    markdownPath: "paired.md",
    absolutePath: filePath,
    name: "Paired",
  };
  const content = "Unchanged content\n";
  const baseline = {
    localHash: createHash("sha256").update(content).digest("hex"),
    localModifiedTime: 1,
    remoteRevisionId: "docs-revision-7",
    remoteDriveRevisionId: "drive-version-7",
    remoteModifiedTime: "2026-08-27T12:00:00.000Z",
    lastWriter: "google-docs",
    lastSuccessfulSync: "2026-08-27T12:00:00.000Z",
  };
  await fs.writeFile(filePath, documentStatusMarkdown(pairing, { ...baseline, content }));
  let driveRequests = 0;
  let docsRequests = 0;
  const services = {
    drive: { files: { get: async () => {
      driveRequests += 1;
      return { data: {
        modifiedTime: baseline.remoteModifiedTime,
        name: pairing.name,
        version: baseline.remoteDriveRevisionId,
      } };
    } } },
    docs: { documents: { get: async () => {
      docsRequests += 1;
      throw new Error("Docs details should not be requested");
    } } },
  };
  try {
    const result = await syncPairing(services, pairing, baseline);
    assert.equal(result.action, "none");
    assert.equal(driveRequests, 1);
    assert.equal(docsRequests, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("refreshes status after an explicit unchanged Google Doc check", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gdocs-manual-check-"));
  const filePath = path.join(directory, "paired.md");
  const pairing = {
    documentId: "document",
    documentUrl: "https://docs.google.com/document/d/document/edit",
    syncLocation: directory,
    markdownPath: "paired.md",
    absolutePath: filePath,
    name: "Paired",
  };
  const content = "Unchanged content\n";
  const baseline = {
    localHash: createHash("sha256").update(content).digest("hex"),
    localModifiedTime: 1,
    remoteRevisionId: "docs-revision-7",
    remoteDriveRevisionId: "drive-version-7",
    remoteModifiedTime: "2026-08-27T12:00:00.000Z",
    lastWriter: "markdown",
    lastSuccessfulSync: "2026-08-27T12:00:00.000Z",
  };
  await fs.writeFile(filePath, documentStatusMarkdown(pairing, { ...baseline, content }));
  let index = 1;
  const paragraph = (text) => {
    const startIndex = index;
    index += text.length;
    return {
      startIndex,
      endIndex: index,
      paragraph: {
        paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
        elements: [{ startIndex, endIndex: index, textRun: { content: text } }],
      },
    };
  };
  const document = {
    revisionId: baseline.remoteRevisionId,
    body: { content: [
      paragraph(content),
      paragraph("---\n"),
      paragraph("↔ Markdown sync status\n"),
      paragraph("Last successful sync: old\n"),
      paragraph("Local file: paired.md\n"),
    ] },
  };
  let writes = 0;
  const services = {
    drive: { files: { get: async () => ({ data: {
      modifiedTime: baseline.remoteModifiedTime,
      name: pairing.name,
      version: baseline.remoteDriveRevisionId,
    } }) } },
    docs: { documents: {
      get: async () => ({ data: document }),
      batchUpdate: async () => { writes += 1; },
    } },
  };
  try {
    const result = await syncPairing(services, pairing, baseline, {
      refreshStatus: true,
    });
    const refreshed = await fs.readFile(filePath, "utf8");
    assert.equal(result.action, "checked");
    assert.ok(result.state.lastSuccessfulSync > baseline.lastSuccessfulSync);
    assert.doesNotMatch(refreshed, /Aug 27, 2026/);
    assert.ok(writes >= 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("fetches Google Docs details when the lightweight Drive version changes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gdocs-detail-poll-"));
  const filePath = path.join(directory, "paired.md");
  const pairing = {
    documentId: "document",
    documentUrl: "https://docs.google.com/document/d/document/edit",
    syncLocation: directory,
    markdownPath: "paired.md",
    absolutePath: filePath,
    name: "Paired",
  };
  const content = "Unchanged content\n";
  const baseline = {
    localHash: createHash("sha256").update(content).digest("hex"),
    localModifiedTime: 1,
    remoteRevisionId: "docs-revision-7",
    remoteDriveRevisionId: "drive-version-7",
    remoteModifiedTime: "2026-08-27T12:00:00.000Z",
    lastWriter: "google-docs",
    lastSuccessfulSync: "2026-08-27T12:00:00.000Z",
  };
  await fs.writeFile(filePath, documentStatusMarkdown(pairing, { ...baseline, content }));
  let docsRequests = 0;
  const services = {
    drive: { files: { get: async () => ({ data: {
      modifiedTime: "2026-08-27T12:01:00.000Z",
      name: pairing.name,
      version: "drive-version-8",
    } }) } },
    docs: { documents: { get: async () => {
      docsRequests += 1;
      throw new Error("detail fetch observed");
    } } },
  };
  try {
    await assert.rejects(syncPairing(services, pairing, baseline), /detail fetch observed/);
    assert.equal(docsRequests, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("fetches Google Docs details when local Markdown changes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gdocs-local-detail-"));
  const filePath = path.join(directory, "paired.md");
  const pairing = {
    documentId: "document",
    documentUrl: "https://docs.google.com/document/d/document/edit",
    syncLocation: directory,
    markdownPath: "paired.md",
    absolutePath: filePath,
    name: "Paired",
  };
  const baseline = {
    localHash: createHash("sha256").update("Original content\n").digest("hex"),
    localModifiedTime: 1,
    remoteRevisionId: "docs-revision-7",
    remoteDriveRevisionId: "drive-version-7",
    remoteModifiedTime: "2026-08-27T12:00:00.000Z",
    lastWriter: "google-docs",
    lastSuccessfulSync: "2026-08-27T12:00:00.000Z",
  };
  await fs.writeFile(
    filePath,
    documentStatusMarkdown(pairing, { ...baseline, content: "Changed content\n" }),
  );
  let docsRequests = 0;
  const services = {
    drive: { files: { get: async () => ({ data: {
      modifiedTime: baseline.remoteModifiedTime,
      name: pairing.name,
      version: baseline.remoteDriveRevisionId,
    } }) } },
    docs: { documents: { get: async () => {
      docsRequests += 1;
      throw new Error("local detail fetch observed");
    } } },
  };
  try {
    await assert.rejects(syncPairing(services, pairing, baseline), /local detail fetch observed/);
    assert.equal(docsRequests, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
