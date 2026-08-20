import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(projectRoot, "src", "cli.js");

test("prints the package version through both version forms", async () => {
  const packageJson = JSON.parse(
    await import("node:fs/promises").then((fs) => fs.readFile(path.join(projectRoot, "package.json"), "utf8")),
  );
  const [flag, command] = await Promise.all([
    execute(process.execPath, [cliPath, "--version"]),
    execute(process.execPath, [cliPath, "version"]),
  ]);
  assert.match(flag.stdout, new RegExp(`GDMS CLI: ${packageJson.version}`));
  assert.match(command.stdout, new RegExp(`GDMS CLI: ${packageJson.version}`));
  assert.match(flag.stdout, /GDMS daemon:/);
});

test("prints gdms-oriented help without an error", async () => {
  const { stdout } = await execute(process.execPath, [cliPath, "--help"]);
  assert.match(stdout, /Usage: gdms COMMAND/);
  assert.match(stdout, /configure-deletion/);
  assert.match(stdout, /recover --document-id ID/);
  assert.match(stdout, /create .*--open/);
  assert.match(stdout, /create-sheet .*--open/);
  assert.match(stdout, /--version/);
});

test("exposes the CLI as the gdms package binary", async () => {
  const packageJson = JSON.parse(
    await import("node:fs/promises").then((fs) => fs.readFile(path.join(projectRoot, "package.json"), "utf8")),
  );
  assert.deepEqual(packageJson.bin, { gdms: "./src/cli.js" });
});
