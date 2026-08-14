import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GOOGLE_REQUEST_TIMEOUT_MS,
  googleRequestTimeoutMs,
  validateDeletionPolicy,
} from "../src/config.js";

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
