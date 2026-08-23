import test from "node:test";
import assert from "node:assert/strict";
import {
  createSyncErrorReporter,
  displaySyncNotification,
  sendSyncErrorEmail,
  sendSyncRecoveryEmail,
} from "../src/notifications.js";

test("passes notification text as argv instead of interpolating AppleScript", () => {
  let invocation;
  displaySyncNotification({
    title: "GDMS",
    message: "A quote: ' and \"",
    exec: (...args) => { invocation = args; },
  });
  assert.equal(invocation[0], "/usr/bin/osascript");
  assert.deepEqual(invocation[1].slice(-2), ["GDMS", "A quote: ' and \""]);
});

test("deduplicates errors, escalates persistent errors, and reports recovery", async () => {
  const logs = [];
  const notifications = [];
  const emails = [];
  const recoveries = [];
  let current = new Date("2026-08-23T12:00:00.000Z");
  const reporter = createSyncErrorReporter({
    logger: {
      log: (message) => logs.push(message),
      error: (message) => logs.push(message),
    },
    notify: (notification) => notifications.push(notification),
    desktopNotificationsEnabled: true,
    sendEmail: async (options) => {
      emails.push(options);
      return { id: "email-1" };
    },
    sendRecoveryEmail: async (options) => {
      recoveries.push(options);
      return { id: "email-recovery" };
    },
    emailRecipient: "person@example.com",
    emailDelayMs: 1_000,
    now: () => current,
  });
  const pairing = { documentId: "doc", name: "Guide", absolutePath: "/guide.md" };
  const error = new Error("conflict");

  await reporter.report(pairing, error);
  await reporter.report(pairing, error);
  assert.equal(logs.filter((line) => line.includes("conflict")).length, 1);
  assert.equal(notifications.length, 1);
  assert.equal(emails.length, 0);

  current = new Date("2026-08-23T12:00:02.000Z");
  await reporter.report(pairing, error);
  await reporter.report(pairing, error);
  assert.equal(emails.length, 1);

  await reporter.reconcile([{ pairing, action: "none" }]);
  assert.equal(notifications.length, 2);
  assert.match(notifications[1].title, /recovered/);
  assert.equal(recoveries.length, 1);
});

test("keeps desktop notifications off by default", async () => {
  const notifications = [];
  const reporter = createSyncErrorReporter({
    logger: { log() {}, error() {} },
    notify: (notification) => notifications.push(notification),
  });
  const pairing = { documentId: "doc", name: "Guide", absolutePath: "/guide.md" };
  await reporter.report(pairing, new Error("conflict"));
  await reporter.reconcile([{ pairing, action: "none" }]);
  assert.deepEqual(notifications, []);
});

test("sends an idempotent persistent sync-error email", async () => {
  let request;
  const result = await sendSyncErrorEmail({
    token: "secret",
    recipient: "person@example.com",
    sender: "Sync <sync@example.com>",
    pairing: {
      documentId: "doc-1",
      name: "Guide",
      absolutePath: "/workspace/guide.md",
      documentUrl: "https://docs.google.com/document/d/doc-1/edit",
    },
    error: new Error("image conflict"),
    firstSeenAt: "2026-08-23T12:00:00.000Z",
    fetchImplementation: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ id: "email-error" }) };
    },
  });
  const body = JSON.parse(request.options.body);
  assert.match(request.options.headers["Idempotency-Key"], /gdms-sync-error-doc-1/);
  assert.match(body.text, /image conflict/);
  assert.deepEqual(result, { id: "email-error" });
});

test("sends an idempotent recovery email for a previously emailed error", async () => {
  let request;
  const result = await sendSyncRecoveryEmail({
    token: "secret",
    recipient: "person@example.com",
    sender: "Sync <sync@example.com>",
    pairing: { documentId: "doc-1", name: "Guide", absolutePath: "/guide.md" },
    error: new Error("image conflict"),
    firstSeenAt: "2026-08-23T12:00:00.000Z",
    recoveredAt: "2026-08-23T12:20:00.000Z",
    fetchImplementation: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ id: "email-recovery" }) };
    },
  });
  const body = JSON.parse(request.options.body);
  assert.match(request.options.headers["Idempotency-Key"], /gdms-sync-recovery-doc-1/);
  assert.match(body.text, /image conflict/);
  assert.deepEqual(result, { id: "email-recovery" });
});
