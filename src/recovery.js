import fs from "node:fs/promises";
import path from "node:path";
import { assetDirectoryPath } from "./images.js";

async function exists(filePath) {
  return fs.access(filePath).then(() => true, (error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

function recoveryTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function availableBackupPath(filePath, now) {
  const extension = path.extname(filePath);
  const stem = filePath.slice(0, -extension.length);
  const base = `${stem}.recovery-backup-${recoveryTimestamp(now)}`;
  for (let index = 0; ; index += 1) {
    const candidate = `${base}${index ? `-${index}` : ""}${extension}`;
    if (!(await exists(candidate)) && !(await exists(assetDirectoryPath(candidate)))) return candidate;
  }
}

export async function preserveRecoveryContent(markdownPath, { now = new Date() } = {}) {
  const sourceAssets = assetDirectoryPath(markdownPath);
  const [hasMarkdown, hasAssets] = await Promise.all([exists(markdownPath), exists(sourceAssets)]);
  if (!hasMarkdown && !hasAssets) return null;
  const backupPath = await availableBackupPath(markdownPath, now);
  const backupAssets = assetDirectoryPath(backupPath);
  let movedMarkdown = false;
  try {
    if (hasMarkdown) {
      await fs.rename(markdownPath, backupPath);
      movedMarkdown = true;
    }
    if (hasAssets) await fs.rename(sourceAssets, backupAssets);
  } catch (error) {
    if (movedMarkdown) await fs.rename(backupPath, markdownPath).catch(() => {});
    throw error;
  }
  return {
    markdownPath: hasMarkdown ? backupPath : null,
    assetDirectory: hasAssets ? backupAssets : null,
  };
}

export async function restoreDriveDocument(services, documentId) {
  const before = await services.drive.files.get({ fileId: documentId, fields: "id,name,trashed" });
  if (before.data.trashed) {
    await services.drive.files.update({
      fileId: documentId,
      requestBody: { trashed: false },
      fields: "id,name,trashed",
    });
  }
  const after = await services.drive.files.get({ fileId: documentId, fields: "id,name,trashed" });
  if (after.data.trashed) throw new Error(`Google Drive still reports ${documentId} as trashed.`);
  return {
    documentId: after.data.id ?? documentId,
    name: after.data.name ?? before.data.name,
    wasTrashed: Boolean(before.data.trashed),
    trashed: false,
  };
}

export function clearRecoveryDeletion(state, documentId) {
  if (!state.deletions?.[documentId]) return false;
  delete state.deletions[documentId];
  return true;
}

export function assertRecoveryTargetAvailable(pairings, documentId, absolutePath) {
  if (pairings.some((item) => item.documentId === documentId)) {
    throw new Error("That Google Doc is already paired; recovery is not required.");
  }
  if (pairings.some((item) => item.absolutePath === absolutePath)) {
    throw new Error("The requested recovery path is already paired to another document.");
  }
}
