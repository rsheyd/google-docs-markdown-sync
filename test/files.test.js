import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "../src/files.js";

test("concurrent atomic writes use independent temporary files", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gdms-atomic-"));
  const filePath = path.join(directory, "state.json");
  try {
    await Promise.all(
      Array.from({ length: 20 }, (_, value) => writeJsonAtomic(filePath, { value })),
    );
    const stored = JSON.parse(await fs.readFile(filePath, "utf8"));
    assert.equal(stored.value, 19);
    assert.deepEqual(
      (await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
