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


test("compares image Markdown with the same asset-aware hash as local snapshots", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gdms-compare-image-"));
  const filePath = path.join(directory, "note.md");
  const assets = path.join(directory, "note.assets");
  await fs.mkdir(assets);
  await fs.writeFile(path.join(assets, "image.png"), "image bytes");
  const content = "![Screenshot](note.assets/image.png)\n";
  const document = {
    inlineObjects: {
      image: {
        inlineObjectProperties: {
          embeddedObject: { imageProperties: { contentUri: "https://image" } },
        },
      },
    },
    body: {
      content: [{
        startIndex: 1,
        endIndex: 3,
        paragraph: {
          elements: [
            {
              startIndex: 1,
              endIndex: 2,
              inlineObjectElement: { inlineObjectId: "image" },
            },
            {
              startIndex: 2,
              endIndex: 3,
              textRun: { content: "\n", textStyle: {} },
            },
          ],
        },
      }],
    },
  };

  const hash = await comparableMarkdownHash(filePath, content, document);
  assert.notEqual(hash, createHash("sha256").update(content).digest("hex"));
  assert.equal(hash, await comparableMarkdownHash(filePath, content, document));
  await fs.rm(directory, { recursive: true, force: true });
});

test("does not write a pulled local file before the remote status update succeeds", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gdocs-sync-pull-"));
  const filePath = path.join(directory, "paired.md");
  await fs.writeFile(filePath, "original\n");
  const services = {
    docs: { documents: {
      get: async () => ({ data: {
        revisionId: "remote-1",
        body: { content: [{ startIndex: 1, endIndex: 2, paragraph: { elements: [] } }] },
      } }),
      batchUpdate: async () => {
        throw new Error("required revision no longer matches");
      },
    } },
    drive: { files: {
      export: async () => {
        throw new Error("export must not run after a failed status update");
      },
    } },
  };
  const pairing = {
    documentId: "document",
    markdownPath: "paired.md",
    absolutePath: filePath,
  };

  await assert.rejects(
    pullDocument(services, pairing, { revisionId: "remote-1" }),
    /required revision no longer matches/,
  );
  assert.equal(await fs.readFile(filePath, "utf8"), "original\n");
  await fs.rm(directory, { recursive: true, force: true });
});

test("repairs formatting on an unchanged Markdown pairing and records the new revision", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gdms-spacing-"));
  const filePath = path.join(directory, "paired.md");
  await fs.writeFile(filePath, "**Paragraph**\n\nSecond");
  const document = {
    revisionId: "old-revision",
    body: {
      content: [{
        startIndex: 1,
        endIndex: 11,
        paragraph: {
          elements: [{
            startIndex: 1,
            endIndex: 11,
            textRun: { content: "Paragraph\n", textStyle: {} },
          }],
          paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
        },
      }, {
        startIndex: 11,
        endIndex: 18,
        paragraph: {
          elements: [{
            startIndex: 11,
            endIndex: 18,
            textRun: { content: "Second\n", textStyle: {} },
          }],
          paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
        },
      }],
    },
  };
  const updates = [];
  const services = {
    docs: { documents: {
      get: async () => ({ data: document }),
      batchUpdate: async (request) => {
        updates.push(request);
        document.revisionId = "styled-revision";
        document.body.content[0].paragraph.paragraphStyle.spaceBelow = {
          magnitude: 8,
          unit: "PT",
        };
      },
    } },
    drive: { files: {
      get: async () => ({ data: {
        id: "document",
        modifiedTime: "2026-08-11T15:00:00Z",
        name: "Paired",
      } }),
    } },
  };
  const pairing = {
    documentId: "document",
    documentUrl: "https://docs.google.com/document/d/document/edit",
    syncLocation: directory,
    markdownPath: "paired.md",
    absolutePath: filePath,
    name: "Paired",
  };
  const result = await syncPairing(services, pairing, {
    localHash: createHash("sha256").update("**Paragraph**\n\nSecond").digest("hex"),
    localModifiedTime: 1,
    remoteRevisionId: "old-revision",
    remoteModifiedTime: "2026-08-11T14:00:00Z",
    lastWriter: "markdown",
    lastSuccessfulSync: "2026-08-11T14:00:00Z",
  });

  assert.equal(result.action, "style");
  assert.equal(result.state.remoteRevisionId, "styled-revision");
  assert.equal(updates.length, 1);
  assert.deepEqual(
    updates[0].requestBody.requests[0].updateTextStyle.textStyle,
    { bold: true, italic: false, strikethrough: false, link: null },
  );
  assert.deepEqual(
    updates[0].requestBody.requests[1].updateParagraphStyle.paragraphStyle,
    { spaceBelow: { magnitude: 8, unit: "PT" } },
  );
  await fs.rm(directory, { recursive: true, force: true });
});
