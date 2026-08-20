import assert from "node:assert/strict";
import test from "node:test";
import { openUrl } from "../src/macos.js";

test("opens a URL with the macOS default browser", async () => {
  const calls = [];
  const opened = await openUrl("https://docs.google.com/document/d/example/edit", {
    execute(command, args, callback) {
      calls.push([command, args]);
      callback(null);
    },
  });
  assert.equal(opened, true);
  assert.deepEqual(calls, [[
    "/usr/bin/open",
    ["https://docs.google.com/document/d/example/edit"],
  ]]);
});

test("reports a browser launch failure without throwing", async () => {
  const opened = await openUrl("https://docs.google.com/spreadsheets/d/example/edit", {
    execute(_command, _args, callback) {
      callback(new Error("No browser"));
    },
  });
  assert.equal(opened, false);
});
