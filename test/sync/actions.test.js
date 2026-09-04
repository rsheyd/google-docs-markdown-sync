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


const previous = {
  localHash: "old",
  remoteRevisionId: "old-revision",
  remoteModifiedTime: "2026-08-22T12:00:00.000Z",
};

test("initializes missing and untracked local files from Google Docs", () => {
  assert.equal(
    chooseSyncAction({
      local: { exists: false },
      remote: { revisionId: "remote" },
      previous,
    }),
    "pull",
  );
  assert.equal(
    chooseSyncAction({
      local: { exists: true, hash: "local" },
      remote: { revisionId: "remote" },
    }),
    "pull",
  );
});

test("selects one-sided changes", () => {
  assert.equal(
    chooseSyncAction({
      local: { exists: true, hash: "new-local" },
      remote: { revisionId: "old-revision" },
      previous,
    }),
    "push",
  );
  assert.equal(
    chooseSyncAction({
      local: { exists: true, hash: "old" },
      remote: { revisionId: "new-remote" },
      previous,
    }),
    "pull",
  );
});

test("uses modification timestamps when both sides changed", () => {
  assert.equal(
    chooseSyncAction({
      local: { exists: true, hash: "new-local", modifiedTime: 2_000 },
      remote: {
        revisionId: "new-remote",
        modifiedTime: "1970-01-01T00:00:01.000Z",
      },
      previous,
    }),
    "push",
  );
  assert.equal(
    chooseSyncAction({
      local: { exists: true, hash: "new-local", modifiedTime: 1_000 },
      remote: {
        revisionId: "new-remote",
        modifiedTime: "1970-01-01T00:00:02.000Z",
      },
      previous,
    }),
    "pull",
  );
});

test("treats two-sided changes to an image document as a conflict", () => {
  const remote = {
    revisionId: "new-remote",
    modifiedTime: "2026-08-23T12:00:00.000Z",
    document: {
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
    },
  };
  assert.equal(
    hasImageConflict({
      local: {
        exists: true,
        hash: "new-local",
        content: "![Screenshot](note.assets/image.png)",
      },
      remote,
      previous,
    }),
    true,
  );
});

test("does not treat a revision-only change as an image conflict", () => {
  assert.equal(
    hasImageConflict({
      local: {
        exists: true,
        hash: "new-local",
        content: "![Screenshot](note.assets/image.png)",
      },
      remote: {
        revisionId: "normalized-remote",
        modifiedTime: previous.remoteModifiedTime,
        document: {
          inlineObjects: {
            image: {
              inlineObjectProperties: {
                embeddedObject: { imageProperties: { contentUri: "https://image" } },
              },
            },
          },
        },
      },
      previous,
    }),
    false,
  );
});

test("refines metadata-only remote churn into a local push", () => {
  assert.equal(
    refineTwoSidedAction({
      localHash: "new-local",
      previousHash: "baseline",
      remoteHash: "baseline",
    }),
    "push",
  );
  assert.equal(
    refineTwoSidedAction({
      localHash: "new-local",
      previousHash: "baseline",
      remoteHash: "new-local",
    }),
    "repair-status",
  );
  assert.equal(
    refineTwoSidedAction({
      localHash: "new-local",
      previousHash: "baseline",
      remoteHash: "different-remote",
    }),
    undefined,
  );
  assert.equal(
    shouldRaiseImageConflict({
      remoteContentVerifiedUnchanged: true,
      local: {
        exists: true,
        hash: "new-local",
        content: "![Screenshot](note.assets/image.png)",
      },
      remote: {
        revisionId: "new-remote",
        modifiedTime: "2026-08-23T12:00:00.000Z",
        document: {
          body: { content: [] },
          inlineObjects: {
            image: {
              inlineObjectProperties: {
                embeddedObject: { imageProperties: { contentUri: "https://image" } },
              },
            },
          },
        },
      },
      previous,
    }),
    false,
  );
});
