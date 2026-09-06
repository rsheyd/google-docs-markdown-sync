import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { archiveRemoteTrashedPairing, retryDeletionNotifications, cancelMissingDeletion, deletionDue, recordMissingDeletion, trashPairedDocument } from "../src/deletions.js";

function pairing(overrides = {}) {
  return {
    type: "document",
    documentId: "doc-1",
    documentUrl: "https://docs.google.com/document/d/doc-1/edit",
    absolutePath: "/workspace/note.md",
    deletionPolicy: {
      mode: "trash-after-grace-period",
      gracePeriodMinutes: 10,
      notificationEmail: "person@example.com",
    },
    ...overrides,
  };
}

test("records, evaluates, and cancels a missing-file grace period", async () => {
  const state = { version: 1, documents: { "doc-1": {} } };
  const missingAt = new Date("2026-08-14T12:00:00Z");
  const deletion = await recordMissingDeletion(pairing(), state, { now: missingAt });
  assert.equal(deletionDue(pairing(), deletion, missingAt.getTime() + 599_999), false);
  assert.equal(deletionDue(pairing(), deletion, missingAt.getTime() + 600_000), true);
  assert.equal(await cancelMissingDeletion(pairing(), state), true);
  assert.equal(state.deletions["doc-1"], undefined);
});

test("clears an old notified tombstone when the same Doc is paired again", async () => {
  const state = {
    version: 1,
    documents: { "doc-1": {} },
    deletions: { "doc-1": { phase: "notified" } },
  };
  assert.equal(await cancelMissingDeletion(pairing(), state), true);
  assert.equal(state.deletions["doc-1"], undefined);
});

test("trashes the Doc before removing local data and sends one notification", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gdms-delete-"));
  const markdownPath = path.join(directory, "note.md");
  const assetPath = path.join(directory, "note.assets");
  await fs.writeFile(markdownPath, "hello");
  await fs.mkdir(assetPath);
  await fs.writeFile(path.join(assetPath, "image.png"), "image");
  const events = [];
  const services = { drive: { files: {
    get: async () => ({ data: { id: "doc-1", name: "Note", trashed: false } }),
    update: async (request) => {
      events.push(["trash", request.requestBody]);
      return { data: { id: "doc-1", trashed: true } };
    },
  } } };
  const state = { version: 1, documents: { "doc-1": { localHash: "old" } } };
  const currentPairing = pairing({ absolutePath: markdownPath });
  const deletion = await recordMissingDeletion(currentPairing, state);
  const result = await trashPairedDocument({
    services,
    pairing: currentPairing,
    state,
    deletion,
    explicit: true,
    deleteLocal: true,
    persistState: async () => events.push(["persist", deletion.phase]),
    removePairing: async () => events.push(["unpair"]),
    sendEmail: async ({ recipient, deletion: sent }) => {
      events.push(["email", recipient, sent.name]);
      return { id: "email-1" };
    },
  });
  assert.deepEqual(events[1], ["trash", { trashed: true }]);
  assert.equal(await fs.stat(markdownPath).then(() => true, () => false), false);
  assert.equal(await fs.stat(assetPath).then(() => true, () => false), false);
  assert.equal(state.documents["doc-1"], undefined);
  assert.equal(result.deletion.phase, "notified");
  assert.equal(result.email.id, "email-1");
  await fs.rm(directory, { recursive: true, force: true });
});

test("refuses automatic trash without a notification recipient", async () => {
  const originalDeleteTo = process.env.GOOGLE_DOCS_SYNC_DELETE_TO;
  const originalHeartbeatTo = process.env.GOOGLE_DOCS_SYNC_HEARTBEAT_TO;
  delete process.env.GOOGLE_DOCS_SYNC_DELETE_TO;
  delete process.env.GOOGLE_DOCS_SYNC_HEARTBEAT_TO;
  try {
    await assert.rejects(
      trashPairedDocument({
        services: {},
        pairing: pairing({ deletionPolicy: { mode: "trash-after-grace-period", gracePeriodMinutes: 10 } }),
        state: { documents: {} },
        deletion: { missingSince: new Date().toISOString() },
        persistState: async () => {},
      }),
      /Refusing to trash/,
    );
  } finally {
    if (originalDeleteTo === undefined) delete process.env.GOOGLE_DOCS_SYNC_DELETE_TO;
    else process.env.GOOGLE_DOCS_SYNC_DELETE_TO = originalDeleteTo;
    if (originalHeartbeatTo === undefined) delete process.env.GOOGLE_DOCS_SYNC_HEARTBEAT_TO;
    else process.env.GOOGLE_DOCS_SYNC_HEARTBEAT_TO = originalHeartbeatTo;
  }
});


test("archives unsynced Markdown and assets, resumes after unpair failure, and retries one notification", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gdms-remote-trash-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "note.md");
  const assets = path.join(directory, "note.assets");
  const manifestPath = path.join(directory, "google-docs-sync.json");
  await fs.writeFile(file, "unsynced ![image](note.assets/image.png)");
  await fs.mkdir(assets);
  await fs.writeFile(path.join(assets, "image.png"), "image");
  await fs.writeFile(manifestPath, JSON.stringify({ pairings: [{ documentId: "doc-1" }, { documentId: "other" }] }));
  const current = pairing({ absolutePath: file, manifestPath });
  let saved;
  const persistState = async (state) => { saved = structuredClone(state); };
  const state = { documents: { "doc-1": { localHash: "older" } } };
  await assert.rejects(archiveRemoteTrashedPairing({
    pairing: current, state, persistState,
    removePairing: async () => { throw new Error("manifest busy"); },
  }), /manifest busy/);
  assert.equal(saved.deletions["doc-1"].phase, "archived");
  const recovery = saved.deletions["doc-1"].recoveryDirectory;
  assert.equal(await fs.readFile(path.join(recovery, "note.md"), "utf8"), "unsynced ![image](note.assets/image.png)");
  assert.equal(await fs.readFile(path.join(recovery, "note.assets/image.png"), "utf8"), "image");
  await assert.rejects(fs.access(file));
  await assert.rejects(fs.access(assets));
  const resumed = structuredClone(saved);
  let attempts = 0;
  const sendEmail = async () => {
    if (++attempts === 1) throw new Error("email offline");
    return { id: "sent" };
  };
  const options = { persistState, sendEmail, logger: { error() {} } };
  await retryDeletionNotifications(resumed, options);
  assert.equal(resumed.deletions["doc-1"].phase, "unpaired");
  assert.equal(resumed.documents["doc-1"], undefined);
  assert.deepEqual(JSON.parse(await fs.readFile(manifestPath, "utf8")).pairings, [{ documentId: "other" }]);
  await retryDeletionNotifications(resumed, options);
  await retryDeletionNotifications(resumed, options);
  assert.equal(attempts, 2);
  assert.equal(resumed.deletions["doc-1"].phase, "notified");
  assert.equal(resumed.deletions["doc-1"].recoveryDirectory, recovery);
});

test("resumes a partially moved archive without overwriting a recreated local file", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gdms-remote-resume-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "note.md");
  const recoveryDirectory = path.join(directory, "recovery");
  await fs.mkdir(recoveryDirectory);
  await fs.writeFile(path.join(recoveryDirectory, "note.md"), "original");
  await fs.mkdir(path.join(directory, "note.assets"));
  await fs.writeFile(file, "recreated");
  const current = pairing({ absolutePath: file });
  const state = { documents: {}, deletions: { "doc-1": {
    ...current, origin: "remote", phase: "archiving", recoveryDirectory,
  } } };
  let unpaired = false;
  const options = { pairing: current, state, persistState: async () => {}, removePairing: async () => { unpaired = true; } };
  await assert.rejects(archiveRemoteTrashedPairing(options), /preserving both copies/);
  assert.equal(unpaired, false);
  assert.equal(await fs.readFile(file, "utf8"), "recreated");
  assert.equal(await fs.readFile(path.join(recoveryDirectory, "note.md"), "utf8"), "original");
  await fs.unlink(file);
  await archiveRemoteTrashedPairing(options);
  assert.equal(unpaired, true);
  assert.ok((await fs.stat(path.join(recoveryDirectory, "note.assets"))).isDirectory());
});

test("does not move files if the archive intent cannot be saved", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gdms-remote-persist-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "note.md");
  await fs.writeFile(file, "keep");
  await assert.rejects(archiveRemoteTrashedPairing({
    pairing: pairing({ absolutePath: file }), state: { documents: {} },
    persistState: async () => { throw new Error("disk full"); },
  }), /disk full/);
  assert.equal(await fs.readFile(file, "utf8"), "keep");
});
