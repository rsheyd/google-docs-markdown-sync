import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GOOGLE_REQUEST_TIMEOUT_MS,
  googleRequestTimeoutMs,
  notificationSettingsFromHeartbeatPlist,
  validateNotificationSettings,
  validateDeletionPolicy,
} from "../src/config.js";

test("defaults persistent error email on when a shared recipient is configured", () => {
  assert.deepEqual(
    validateNotificationSettings({ recipient: "person@example.com" }),
    {
      recipient: "person@example.com",
      desktopNotificationsEnabled: false,
      errorEmailEnabled: true,
      errorEmailDelayMinutes: 15,
    },
  );
});

test("migrates the shared recipient and sender from a legacy heartbeat plist", () => {
  assert.deepEqual(
    notificationSettingsFromHeartbeatPlist(`
      <key>GOOGLE_DOCS_SYNC_HEARTBEAT_TO</key>
      <string>person@example.com</string>
      <key>GOOGLE_DOCS_SYNC_HEARTBEAT_FROM</key>
      <string>Sync &lt;sync@example.com&gt;</string>
    `),
    {
      recipient: "person@example.com",
      sender: "Sync <sync@example.com>",
      desktopNotificationsEnabled: false,
      errorEmailEnabled: true,
      errorEmailDelayMinutes: 15,
    },
  );
});

test("validates the persistent error email delay", () => {
  assert.throws(
    () => validateNotificationSettings({ errorEmailDelayMinutes: -1 }),
    /zero or greater/,
  );
});

test("uses a 30-second Google request timeout by default", () => {
  assert.equal(googleRequestTimeoutMs(undefined), DEFAULT_GOOGLE_REQUEST_TIMEOUT_MS);
});

test("validates the global automatic deletion policy", () => {
  assert.deepEqual(
    validateDeletionPolicy({
      mode: "trash-after-grace-period",
      gracePeriodMinutes: 60,
      notificationEmail: "person@example.com",
    }),
    {
      mode: "trash-after-grace-period",
      gracePeriodMinutes: 60,
      notificationEmail: "person@example.com",
    },
  );
  assert.throws(
    () => validateDeletionPolicy({
      mode: "trash-after-grace-period",
      gracePeriodMinutes: 0,
      notificationEmail: "person@example.com",
    }),
    /positive integer/,
  );
  assert.throws(
    () => validateDeletionPolicy({
      mode: "trash-after-grace-period",
      gracePeriodMinutes: 60,
    }),
    /notificationEmail is required/,
  );
});

test("accepts a positive Google request timeout override", () => {
  assert.equal(googleRequestTimeoutMs("45000"), 45_000);
});

test("rejects invalid Google request timeout overrides", () => {
  assert.throws(() => googleRequestTimeoutMs("0"), /must be a positive number/);
  assert.throws(() => googleRequestTimeoutMs("later"), /must be a positive number/);
});
