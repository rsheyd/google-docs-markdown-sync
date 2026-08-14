import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertRecoveryTargetAvailable,
  clearRecoveryDeletion,
  preserveRecoveryContent,
  restoreDriveDocument,
} from "../src/recovery.js";

test("preserves existing Markdown and assets under matching recovery names", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gdms-recovery-"));
  const markdownPath = path.join(directory, "note.md");
  const assets = path.join(directory, "note.assets");
  await fs.writeFile(markdownPath, "local-only change\n");
  await fs.mkdir(assets);
  await fs.writeFile(path.join(assets, "image.png"), "image");
  try {
    const backup = await preserveRecoveryContent(markdownPath, { now: new Date("2026-08-14T17:30:45.000Z") });
    assert.equal(backup.markdownPath, path.join(directory, "note.recovery-backup-20260814T173045Z.md"));
    assert.equal(backup.assetDirectory, path.join(directory, "note.recovery-backup-20260814T173045Z.assets"));
    assert.equal(await fs.readFile(backup.markdownPath, "utf8"), "local-only change\n");
    assert.equal(await fs.readFile(path.join(backup.assetDirectory, "image.png"), "utf8"), "image");
    await assert.rejects(fs.access(markdownPath));
    await assert.rejects(fs.access(assets));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("uses a collision-safe recovery suffix", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gdms-recovery-collision-"));
  const markdownPath = path.join(directory, "note.md");
  await fs.writeFile(markdownPath, "new\n");
  await fs.writeFile(path.join(directory, "note.recovery-backup-20260814T173045Z.md"), "old\n");
  try {
    const backup = await preserveRecoveryContent(markdownPath, { now: new Date("2026-08-14T17:30:45.000Z") });
    assert.equal(backup.markdownPath, path.join(directory, "note.recovery-backup-20260814T173045Z-1.md"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("restores a trashed Drive document and verifies it", async () => {
  const updates = [];
  let trashed = true;
  const services = { drive: { files: {
    get: async () => ({ data: { id: "doc-1", name: "Note", trashed } }),
    update: async ({ requestBody }) => {
      updates.push(requestBody);
      trashed = requestBody.trashed;
      return { data: { id: "doc-1", name: "Note", trashed } };
    },
  } } };
  const result = await restoreDriveDocument(services, "doc-1");
  assert.deepEqual(updates, [{ trashed: false }]);
  assert.deepEqual(result, { documentId: "doc-1", name: "Note", wasTrashed: true, trashed: false });
});

test("does not update a Drive document already outside trash", async () => {
  let updates = 0;
  const services = { drive: { files: {
    get: async () => ({ data: { id: "doc-1", name: "Note", trashed: false } }),
    update: async () => { updates += 1; },
  } } };
  const result = await restoreDriveDocument(services, "doc-1");
  assert.equal(updates, 0);
  assert.equal(result.wasTrashed, false);
});

test("clears only the recovered document deletion tombstone", () => {
  const state = {
    deletions: {
      "doc-1": { phase: "notified" },
      "doc-2": { phase: "waiting" },
    },
  };
  assert.equal(clearRecoveryDeletion(state, "doc-1"), true);
  assert.equal(state.deletions["doc-1"], undefined);
  assert.deepEqual(state.deletions["doc-2"], { phase: "waiting" });
  assert.equal(clearRecoveryDeletion(state, "missing"), false);
});

test("refuses an already paired document or occupied recovery path", () => {
  const pairings = [{
    documentId: "doc-1",
    absolutePath: "/workspace/one.md",
  }];
  assert.throws(
    () => assertRecoveryTargetAvailable(pairings, "doc-1", "/workspace/two.md"),
    /already paired/,
  );
  assert.throws(
    () => assertRecoveryTargetAvailable(pairings, "doc-2", "/workspace/one.md"),
    /already paired to another document/,
  );
  assert.doesNotThrow(
    () => assertRecoveryTargetAvailable(pairings, "doc-2", "/workspace/two.md"),
  );
});
