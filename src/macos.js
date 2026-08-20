import { execFile } from "node:child_process";

export async function openUrl(url, { execute = execFile } = {}) {
  try {
    await new Promise((resolve, reject) => {
      execute("/usr/bin/open", [url], (error) => error ? reject(error) : resolve());
    });
    return true;
  } catch {
    return false;
  }
}
