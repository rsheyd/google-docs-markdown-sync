import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cancelMissingDeletion, deletionDue, recordMissingDeletion, trashPairedDocument } from "../src/deletions.js";

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
