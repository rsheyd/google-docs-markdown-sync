import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { backupImageConflict } from "../src/conflicts.js";

test("backs up both versions and colliding bytes into independent restorable trees", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gdms-conflict-backup-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const absolutePath = path.join(directory, "terms.md");
  const image = path.join(directory, "terms.assets", "image.png");
  await fs.mkdir(path.dirname(image));
  await fs.writeFile(image, "local bytes");
  const content = "![](terms.assets/image.png)\n";
  const snapshots = { local: { content, hash: "local", modifiedTime: 1000 }, remote: { revisionId: "r2", modifiedTime: new Date(2000).toISOString() }, remoteContent: content, assets: new Map([[image, Buffer.from("remote bytes")]]), action: "pull" };
  const pairing = { absolutePath, documentId: "doc" };
  const resolution = await backupImageConflict(pairing, snapshots, path.join(directory, "backups"));
  for (const [side, bytes] of [["local", "local bytes"], ["google-docs", "remote bytes"]]) {
    assert.equal(await fs.readFile(path.join(resolution.backupPath, side, "terms.md"), "utf8"), content);
    assert.equal(await fs.readFile(path.join(resolution.backupPath, side, "terms.assets", "image.png"), "utf8"), bytes);
  }
  assert.equal(resolution.chosenSide, "Google Docs");
  assert.equal((await backupImageConflict(pairing, snapshots, path.join(directory, "backups"))).backupPath, resolution.backupPath);
  assert.equal(await fs.readFile(image, "utf8"), "local bytes");
  await assert.rejects(backupImageConflict(pairing, snapshots, image), /ENOTDIR/);
});
