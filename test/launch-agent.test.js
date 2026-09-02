import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { migrateLogFile } from "../src/launch-agent.js";

test("moves a legacy log only when the standard destination is absent", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gdms-log-migration-"));
  const source = path.join(directory, "Application Support", "service.log");
  const destination = path.join(directory, "Logs", "service.log");
  try {
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(source, "legacy\n");
    assert.equal(await migrateLogFile(source, destination), true);
    assert.equal(await fs.readFile(destination, "utf8"), "legacy\n");
    await assert.rejects(fs.access(source), { code: "ENOENT" });

    await fs.writeFile(source, "older\n");
    await fs.writeFile(destination, "current\n");
    assert.equal(await migrateLogFile(source, destination), false);
    assert.equal(await fs.readFile(source, "utf8"), "older\n");
    assert.equal(await fs.readFile(destination, "utf8"), "current\n");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
