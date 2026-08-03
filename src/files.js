import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export async function ensureDirectory(directory) {
  await fs.mkdir(directory, { recursive: true });
}

export async function readJson(filePath, fallback = undefined) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(filePath, value) {
  await ensureDirectory(path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(temporaryPath, filePath);
}

export async function writeTextAtomic(filePath, value) {
  await ensureDirectory(path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, value, "utf8");
  await fs.rename(temporaryPath, filePath);
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
