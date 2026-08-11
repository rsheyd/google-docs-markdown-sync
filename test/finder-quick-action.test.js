import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FINDER_QUICK_ACTION_NAME,
  MARKDOWN_UTI,
  finderQuickActionInfoPlist,
  finderQuickActionShellCommand,
  finderQuickActionWorkflow,
  installFinderQuickAction,
} from "../src/finder-quick-action.js";

test("Finder Quick Action passes selected Markdown paths to GDMS create", () => {
  const command = finderQuickActionShellCommand({
    nodePath: "/path with spaces/node",
    cliPath: "/project's/src/cli.js",
  });
  assert.match(command, /for markdown_file in "\$@"/);
  assert.match(command, /create --file "\$markdown_file"/);
  assert.match(command, /'\/path with spaces\/node'/);
  assert.match(command, /'\/project'"'"'s\/src\/cli\.js'/);
  assert.match(command, /\*\.md\)/);
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
});

test("installer writes the named workflow under Library Services", async () => {
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "gdms-home-"));
  const installed = await installFinderQuickAction({ homeDirectory });
  assert.equal(
    installed,
    path.join(homeDirectory, "Library", "Services", `${FINDER_QUICK_ACTION_NAME}.workflow`),
  );
  const workflow = await fs.readFile(path.join(installed, "Contents", "document.wflow"), "utf8");
  assert.match(workflow, /src\/cli\.js/);
  const info = await fs.readFile(path.join(installed, "Contents", "Info.plist"), "utf8");
  assert.match(info, /net\.daringfireball\.markdown/);
});
