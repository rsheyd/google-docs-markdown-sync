import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CSV_FINDER_QUICK_ACTION_NAME,
  CSV_UTI,
  FINDER_QUICK_ACTION_SETTINGS_URL,
  FINDER_QUICK_ACTION_NAME,
  MARKDOWN_UTI,
  SYNC_PAIRED_FILE_QUICK_ACTION_NAME,
  csvFinderQuickActionInfoPlist,
  csvFinderQuickActionShellCommand,
  csvFinderQuickActionWorkflow,
  finderQuickActionInfoPlist,
  finderQuickActionShellCommand,
  finderQuickActionWorkflow,
  installFinderQuickAction,
  syncPairedFileQuickActionInfoPlist,
  syncPairedFileQuickActionShellCommand,
  syncPairedFileQuickActionWorkflow,
} from "../src/finder-quick-action.js";

test("CSV Finder Quick Action groups selected files into one create-sheet command", () => {
  const command = csvFinderQuickActionShellCommand({
    nodePath: "/path with spaces/node",
    cliPath: "/project/src/cli.js",
  });
  assert.match(command, /for csv_file in "\$@"/);
  assert.match(command, /csv_arguments\+=\(--file "\$csv_file"\)/);
  assert.match(command, /create-sheet/);
  assert.match(command, /--name "\$spreadsheet_name" --open/);
  assert.match(command, /osascript/);
  assert.match(command, /-e 'end run'/);
  assert.match(command, /--name "\$spreadsheet_name"/);
});

test("CSV Finder Quick Action is restricted to CSV files", () => {
  const workflow = csvFinderQuickActionWorkflow({ nodePath: "/node", cliPath: "/cli" });
  assert.match(workflow, /create-sheet/);
  const info = csvFinderQuickActionInfoPlist();
  assert.match(info, /Combine &amp; Sync CSVs with New Google Sheet \(GDMS\)/);
  assert.match(info, new RegExp(CSV_UTI.replaceAll(".", "\\.")));
  assert.equal(
    CSV_FINDER_QUICK_ACTION_NAME,
    "Combine & Sync CSVs with New Google Sheet (GDMS)",
  );
  assert.match(FINDER_QUICK_ACTION_SETTINGS_URL, /com\.apple\.finder-quick-actions/);
});

test("Finder Quick Action passes selected Markdown paths to GDMS create", () => {
  const command = finderQuickActionShellCommand({
    nodePath: "/path with spaces/node",
    cliPath: "/project's/src/cli.js",
  });
  assert.match(command, /for markdown_file in "\$@"/);
  assert.match(command, /create --file "\$markdown_file"/);
  assert.match(command, /create --file "\$1" --open/);
  assert.match(command, /created_count/);
  assert.match(command, /display notification/);
  assert.match(command, /'\/path with spaces\/node'/);
  assert.match(command, /'\/project'"'"'s\/src\/cli\.js'/);
  assert.match(command, /\*\.md\)/);
});

test("paired-file Finder Quick Action requests an immediate targeted sync", () => {
  const command = syncPairedFileQuickActionShellCommand({
    nodePath: "/path with spaces/node",
    cliPath: "/project/src/cli.js",
  });
  assert.match(command, /for paired_file in "\$@"/);
  assert.match(command, /file_arguments\+=\(--file "\$paired_file"\)/);
  assert.match(command, /sync-once/);
  assert.match(command, /"\$\{file_arguments\[@\]\}"/);
  assert.match(command, /display dialog/);
  assert.match(command, /GDMS Sync Complete/);
  assert.match(command, /display alert/);
  assert.match(command, /GDMS Sync Failed/);
  assert.match(command, /\*\.md\|\*\.csv\)/);
});

test("Finder Quick Action workflow is a Finder service with escaped XML", () => {
  const workflow = finderQuickActionWorkflow({
    nodePath: "/opt/node&node",
    cliPath: "/tmp/<gdms>/cli.js",
  });
  assert.match(workflow, /com\.apple\.finder/);
  assert.match(workflow, /com\.apple\.Automator\.fileSystemObject/);
  assert.match(workflow, /com\.apple\.Automator\.servicesMenu/);
  assert.match(workflow, /inputMethod<\/key><integer>1/);
  assert.match(workflow, /useAutomaticInputType<\/key><false\/>/);
  assert.match(workflow, /<key>arguments<\/key>/);
  assert.match(workflow, /node&amp;node/);
  assert.match(workflow, /&lt;gdms&gt;/);
});

test("Finder Quick Action registers only for Markdown files", () => {
  const info = finderQuickActionInfoPlist();
  assert.match(info, new RegExp(FINDER_QUICK_ACTION_NAME.replace(/[()]/g, "\\$&")));
  assert.match(info, new RegExp(MARKDOWN_UTI.replaceAll(".", "\\.")));
  assert.match(info, /runWorkflowAsService/);
  assert.equal(FINDER_QUICK_ACTION_NAME, "Sync MDs with New Google Docs (GDMS)");
});

test("paired-file Finder Quick Action registers for Markdown and CSV files", () => {
  const workflow = syncPairedFileQuickActionWorkflow({
    nodePath: "/node",
    cliPath: "/cli",
  });
  assert.match(workflow, /sync-once/);
  const info = syncPairedFileQuickActionInfoPlist();
  assert.match(info, new RegExp(CSV_UTI.replaceAll(".", "\\.")));
  assert.match(
    info,
    new RegExp(SYNC_PAIRED_FILE_QUICK_ACTION_NAME.replace(/[()]/g, "\\$&")),
  );
  assert.match(info, new RegExp(MARKDOWN_UTI.replaceAll(".", "\\.")));
  assert.equal(
    SYNC_PAIRED_FILE_QUICK_ACTION_NAME,
    "Sync Paired File Now (GDMS)",
  );
});

test("installer writes the named workflow under Library Services", async () => {
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "gdms-home-"));
  const legacyCsvInstalled = [
    "Sync with Google Sheets (GDMS).workflow",
    "Combine CSVs into One Google Sheet (GDMS).workflow",
  ].map((name) => path.join(homeDirectory, "Library", "Services", name));
  const legacyMarkdownInstalled = path.join(
    homeDirectory,
    "Library",
    "Services",
    "Sync with Google Docs (GDMS).workflow",
  );
  await Promise.all([
    ...legacyCsvInstalled.map((directory) => fs.mkdir(directory, { recursive: true })),
    fs.mkdir(legacyMarkdownInstalled, { recursive: true }),
  ]);
  const installed = await installFinderQuickAction({ homeDirectory });
  assert.equal(
    installed,
    path.join(homeDirectory, "Library", "Services", `${FINDER_QUICK_ACTION_NAME}.workflow`),
  );
  const workflow = await fs.readFile(path.join(installed, "Contents", "document.wflow"), "utf8");
  assert.match(workflow, /src\/cli\.js/);
  const info = await fs.readFile(path.join(installed, "Contents", "Info.plist"), "utf8");
  assert.match(info, /net\.daringfireball\.markdown/);
  const csvInstalled = path.join(
    homeDirectory,
    "Library",
    "Services",
    `${CSV_FINDER_QUICK_ACTION_NAME}.workflow`,
  );
  const csvInfo = await fs.readFile(path.join(csvInstalled, "Contents", "Info.plist"), "utf8");
  assert.match(csvInfo, /public\.comma-separated-values-text/);
  const pairedFileInstalled = path.join(
    homeDirectory,
    "Library",
    "Services",
    `${SYNC_PAIRED_FILE_QUICK_ACTION_NAME}.workflow`,
  );
  const pairedFileWorkflow = await fs.readFile(
    path.join(pairedFileInstalled, "Contents", "document.wflow"),
    "utf8",
  );
  assert.match(pairedFileWorkflow, /sync-once/);
  const pairedFileInfo = await fs.readFile(
    path.join(pairedFileInstalled, "Contents", "Info.plist"),
    "utf8",
  );
  assert.match(pairedFileInfo, /net\.daringfireball\.markdown/);
  assert.match(pairedFileInfo, /public\.comma-separated-values-text/);
  await Promise.all(legacyCsvInstalled.map((directory) => assert.rejects(fs.access(directory))));
  await assert.rejects(fs.access(legacyMarkdownInstalled));
});


test("paired-file action passes mixed Markdown and CSV paths intact and rejects other files", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gdms-action-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cliPath = path.join(directory, "fake cli.js");
  await fs.writeFile(cliPath, "console.log(JSON.stringify(process.argv.slice(2)));\n");
  const command = syncPairedFileQuickActionShellCommand({ nodePath: process.execPath, cliPath })
    .replaceAll("/usr/bin/osascript", "/bin/echo");
  const files = ["/tmp/paired notes.md", "/tmp/paired data.csv"];
  const output = execFileSync("/bin/zsh", ["-c", command, "gdms-action", ...files], { encoding: "utf8" });
  assert.ok(output.includes(JSON.stringify(["sync-once", "--file", files[0], "--file", files[1]])));
  assert.throws(() => execFileSync("/bin/zsh", ["-c", command, "gdms-action", "/tmp/unsupported.txt"], { stdio: "pipe" }), (error) => error.status === 64);
});
