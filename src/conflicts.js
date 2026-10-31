import fs from "node:fs/promises";
import path from "node:path";
import { APP_SUPPORT_DIR } from "./paths.js";
import { sha256 } from "./files.js";
import { localImagePaths } from "./images.js";

export async function backupImageConflict(pairing, { local, remote, remoteContent, assets, action }, root = path.join(APP_SUPPORT_DIR, "conflict-backups")) {
  const id = sha256(`${pairing.documentId}\0${local.hash}\0${remote.revisionId}`);
  const directory = path.join(root, id);
  const filename = path.basename(pairing.absolutePath);
  for (const [side, content, virtualAssets] of [["local", local.content, new Map()], ["google-docs", remoteContent, assets]]) {
    const target = path.join(directory, side);
    await fs.mkdir(target, { recursive: true });
    for (const imagePath of localImagePaths(pairing.absolutePath, content)) {
      const bytes = virtualAssets.get(imagePath) ?? await fs.readFile(imagePath);
      const destination = path.join(target, path.relative(path.dirname(pairing.absolutePath), imagePath));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, bytes);
    }
    await fs.writeFile(path.join(target, filename), content);
  }
  const resolution = {
    backupPath: directory,
    chosenSide: action === "push" ? "local" : "Google Docs",
    reason: "The newer modification time won; equal timestamps prefer Google Docs.",
    localModifiedTime: new Date(local.modifiedTime).toISOString(),
    remoteModifiedTime: remote.modifiedTime,
  };
  await fs.writeFile(path.join(directory, "decision.json"), JSON.stringify(resolution, null, 2) + "\n");
  return resolution;
}
