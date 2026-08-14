import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const PACKAGE_PATH = path.join(PROJECT_ROOT, "package.json");

export async function readPackageVersion() {
  return JSON.parse(await fs.readFile(PACKAGE_PATH, "utf8")).version;
}

export function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function formatVersionReport(cliVersion, daemon) {
  const lines = [`GDMS CLI: ${cliVersion}`];
  if (daemon?.version && isProcessRunning(daemon.pid)) {
    const mismatch = daemon.version === cliVersion ? "" : " — restart pending";
    lines.push(`GDMS daemon: ${daemon.version}${mismatch}`);
  } else {
    lines.push("GDMS daemon: not running");
  }
  return lines.join("\n");
}
