import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { readLocalSpreadsheet } from "../src/sheets.js";
import { documentStatusMarkdown, spreadsheetStatusMarkdown } from "../src/status.js";
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
} from "../src/sync.js";

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
    workspace: directory,
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
    path.join(directory, "SYNC-STATUS.md"),
    spreadsheetStatusMarkdown(pairing, baseline),
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

test("polls only Drive for an unchanged Google Doc with a lightweight baseline", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gdocs-lightweight-poll-"));
  const filePath = path.join(directory, "paired.md");
  const pairing = {
    documentId: "document",
    documentUrl: "https://docs.google.com/document/d/document/edit",
    workspace: directory,
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

test("fetches Google Docs details when the lightweight Drive version changes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gdocs-detail-poll-"));
  const filePath = path.join(directory, "paired.md");
  const pairing = {
    documentId: "document",
    documentUrl: "https://docs.google.com/document/d/document/edit",
    workspace: directory,
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
    workspace: directory,
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
