import test from "node:test";
import assert from "node:assert/strict";
import { formatVersionReport } from "../src/version.js";

test("reports matching CLI and live daemon versions", () => {
  assert.equal(
    formatVersionReport("0.7.0", { version: "0.7.0", pid: process.pid }),
    "GDMS CLI: 0.7.0\nGDMS daemon: 0.7.0",
  );
});

test("marks a live daemon version mismatch as restart pending", () => {
  assert.equal(
    formatVersionReport("0.7.0", { version: "0.6.3", pid: process.pid }),
    "GDMS CLI: 0.7.0\nGDMS daemon: 0.6.3 — restart pending",
  );
});

test("ignores stale daemon identity records", () => {
  assert.equal(
    formatVersionReport("0.7.0", { version: "0.6.3", pid: 999_999_999 }),
    "GDMS CLI: 0.7.0\nGDMS daemon: not running",
  );
});
