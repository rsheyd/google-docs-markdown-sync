import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  APP_SUPPORT_DIR,
  LEGACY_DEFAULT_DISCOVERY_ROOT,
  LOG_DIR,
  LOG_PATH,
  ERROR_LOG_PATH,
  MANIFEST_INDEX_PATH,
  SYNC_LOCATIONS_PATH,
} from "../src/paths.js";

test("keeps shared sync-location configuration in Application Support", () => {
  assert.equal(SYNC_LOCATIONS_PATH, path.join(APP_SUPPORT_DIR, "sync-locations.json"));
  assert.equal(MANIFEST_INDEX_PATH, path.join(APP_SUPPORT_DIR, "manifest-index.json"));
});

test("retains the former development root only for legacy migration", () => {
  assert.equal(LEGACY_DEFAULT_DISCOVERY_ROOT, path.join(os.homedir(), "dev"));
});

test("stores service logs in the standard macOS Logs directory", () => {
  assert.equal(LOG_DIR, path.join(os.homedir(), "Library", "Logs", "google-docs-markdown-sync"));
  assert.equal(LOG_PATH, path.join(LOG_DIR, "service.log"));
  assert.equal(ERROR_LOG_PATH, path.join(LOG_DIR, "service-error.log"));
});
