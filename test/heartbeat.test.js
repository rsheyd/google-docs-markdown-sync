import test from "node:test";
import assert from "node:assert/strict";
import {
  assertDaemonRunning,
  sendDeletionEmail,
  sendHeartbeatEmail,
  verifySyncHealth,
} from "../src/heartbeat.js";

test("accepts a running synchronization daemon", () => {
  assert.doesNotThrow(() =>
    assertDaemonRunning({ exec: () => "state = running\n" }),
  );
});

test("sends an idempotent deletion email with recovery context", async () => {
  let request;
  const result = await sendDeletionEmail({
    token: "secret",
    recipient: "person@example.com",
    sender: "Sync <sync@example.com>",
    deletion: {
      documentId: "doc-1",
      name: "Note",
      documentUrl: "https://docs.google.com/document/d/doc-1/edit",
      absolutePath: "/workspace/note.md",
      policyDescription: "automatic after 60 minute(s) missing",
      trashedAt: "2026-08-14T12:00:00.000Z",
    },
    fetchImplementation: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ id: "email-delete" }) };
    },
  });
  const body = JSON.parse(request.options.body);
  assert.equal(request.options.headers["Idempotency-Key"], "gdms-delete-doc-1-2026-08-14T12:00:00.000Z");
  assert.match(body.text, /Google Drive trash/);
  assert.match(body.text, /\/workspace\/note.md/);
  assert.deepEqual(result, { id: "email-delete" });
});

test("rejects a stopped synchronization daemon", () => {
  assert.throws(
    () => assertDaemonRunning({ exec: () => "state = waiting\n" }),
    /not running/,
  );
});

test("checks every paired document without synchronizing content", async () => {
  const checked = [];
  const result = await verifySyncHealth({
    assertRunning() {},
    getAuth: async () => "auth",
    getPairings: async () => [
      { documentId: "one" },
      { documentId: "two" },
    ],
    makeServices: () => "services",
    readRemote: async (_services, id) => checked.push(id),
  });
  assert.deepEqual(checked.sort(), ["one", "two"]);
  assert.deepEqual(result, { documents: 2, spreadsheets: 0 });
});

test("checks paired spreadsheets through the Sheets API", async () => {
  const checked = [];
  const result = await verifySyncHealth({
    assertRunning() {},
    getAuth: async () => "auth",
    getPairings: async () => [{ type: "spreadsheet", spreadsheetId: "sheet-one" }],
    makeServices: () => "services",
    readSpreadsheet: async (_services, id) => checked.push(id),
  });
  assert.deepEqual(checked, ["sheet-one"]);
  assert.deepEqual(result, { documents: 0, spreadsheets: 1 });
});

test("sends the success heartbeat to the configured recipient", async () => {
  let request;
  const result = await sendHeartbeatEmail({
    token: "secret",
    recipient: "person@example.com",
    sender: "Sync <sync@example.com>",
    result: { documents: 2 },
    fetchImplementation: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ id: "email-1" }) };
    },
  });
  const body = JSON.parse(request.options.body);
  assert.equal(request.url, "https://api.resend.com/emails");
  assert.deepEqual(body.to, ["person@example.com"]);
  assert.match(body.text, /Google documents checked: 2/);
  assert.deepEqual(result, { id: "email-1" });
});
