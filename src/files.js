import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const jsonWriteTails = new Map();

function temporaryPath(filePath) {
  return `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
}

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
  const previous = jsonWriteTails.get(filePath) ?? Promise.resolve();
  const operation = async () => {
    await ensureDirectory(path.dirname(filePath));
    const temporary = temporaryPath(filePath);
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
    await fs.rename(temporary, filePath);
  };
  const result = previous.then(operation, operation);
  jsonWriteTails.set(filePath, result.catch(() => undefined));
  await result;
}

export async function writeTextAtomic(filePath, value) {
  await ensureDirectory(path.dirname(filePath));
  const temporary = temporaryPath(filePath);
  await fs.writeFile(temporary, value, "utf8");
  await fs.rename(temporary, filePath);
}

export async function writeFileAtomic(filePath, value) {
  await ensureDirectory(path.dirname(filePath));
  const temporary = temporaryPath(filePath);
  await fs.writeFile(temporary, value);
  await fs.rename(temporary, filePath);
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
