import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_WORKSPACE_ROOT,
  workspaceRoot,
} from "../src/paths.js";

test("uses the conventional local development root", () => {
  assert.equal(
    DEFAULT_WORKSPACE_ROOT,
    path.join(os.homedir(), "dev"),
  );
  assert.equal(workspaceRoot({}), DEFAULT_WORKSPACE_ROOT);
});

test("accepts an explicit workspace root", () => {
  assert.equal(
    workspaceRoot({ GOOGLE_DOCS_SYNC_ROOT: "/Volumes/workspaces" }),
    "/Volumes/workspaces",
  );
});
