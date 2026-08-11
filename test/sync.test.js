import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  backoffDelay,
  chooseSyncAction,
  createSingleFlight,
  createWatcherManager,
  hasImageConflict,
  pullDocument,
  syncPairing,
} from "../src/sync.js";

const previous = { localHash: "old", remoteRevisionId: "old-revision" };

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

test("styles an unchanged Markdown pairing and records the new revision", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gdms-spacing-"));
  const filePath = path.join(directory, "paired.md");
  await fs.writeFile(filePath, "Paragraph");
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
    workspace: directory,
    markdownPath: "paired.md",
    absolutePath: filePath,
    name: "Paired",
  };
  const result = await syncPairing(services, pairing, {
    localHash: createHash("sha256").update("Paragraph").digest("hex"),
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
    updates[0].requestBody.requests[0].updateParagraphStyle.paragraphStyle,
    { spaceBelow: { magnitude: 8, unit: "PT" } },
  );
  await fs.rm(directory, { recursive: true, force: true });
});

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

test("backs off failed remote polls with bounded jitter", () => {
  assert.equal(backoffDelay(5_000, 0, () => 0.5), 5_000);
  assert.equal(backoffDelay(5_000, 1, () => 0.5), 10_500);
  assert.equal(backoffDelay(5_000, 10, () => 0.5), 60_000);
});

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
