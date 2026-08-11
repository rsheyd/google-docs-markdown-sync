import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const FINDER_QUICK_ACTION_NAME = "Sync with Google Docs (GDMS)";
export const MARKDOWN_UTI = "net.daringfireball.markdown";

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function finderQuickActionShellCommand({ nodePath, cliPath }) {
  return `set -e
for markdown_file in "$@"; do
  case "$markdown_file" in
    *.md) ${shellQuote(nodePath)} ${shellQuote(cliPath)} create --file "$markdown_file" ;;
    *) echo "GDMS only accepts Markdown (.md) files: $markdown_file" >&2; exit 64 ;;
  esac
done`;
}

export function finderQuickActionWorkflow({ nodePath, cliPath }) {
  const command = finderQuickActionShellCommand({ nodePath, cliPath });
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>AMApplicationBuild</key><string>534</string>
  <key>AMApplicationVersion</key><string>2.10</string>
  <key>AMDocumentVersion</key><string>2</string>
  <key>actions</key>
  <array>
    <dict>
      <key>action</key>
      <dict>
        <key>AMAccepts</key><dict><key>Container</key><string>List</string><key>Optional</key><true/><key>Types</key><array><string>com.apple.cocoa.string</string></array></dict>
        <key>AMActionVersion</key><string>2.0.3</string>
        <key>AMApplication</key><array><string>Automator</string></array>
        <key>AMParameterProperties</key>
        <dict>
          <key>CheckedForUserDefaultShell</key><dict/>
          <key>COMMAND_STRING</key><dict/>
          <key>inputMethod</key><dict/>
          <key>shell</key><dict/>
          <key>source</key><dict/>
        </dict>
        <key>AMProvides</key><dict><key>Container</key><string>List</string><key>Types</key><array><string>com.apple.cocoa.string</string></array></dict>
        <key>ActionBundlePath</key><string>/System/Library/Automator/Run Shell Script.action</string>
        <key>ActionName</key><string>Run Shell Script</string>
        <key>ActionParameters</key>
        <dict>
          <key>COMMAND_STRING</key><string>${xmlEscape(command)}</string>
          <key>CheckedForUserDefaultShell</key><true/>
          <key>inputMethod</key><integer>1</integer>
          <key>shell</key><string>/bin/zsh</string>
          <key>source</key><string></string>
        </dict>
        <key>BundleIdentifier</key><string>com.apple.RunShellScript</string>
        <key>CFBundleVersion</key><string>2.0.3</string>
        <key>CanShowSelectedItemsWhenRun</key><false/>
        <key>CanShowWhenRun</key><true/>
        <key>Category</key><array><string>AMCategoryUtilities</string></array>
        <key>Class Name</key><string>RunShellScriptAction</string>
        <key>arguments</key>
        <dict>
          <key>0</key><dict><key>default value</key><integer>0</integer><key>name</key><string>inputMethod</string><key>required</key><string>0</string><key>type</key><string>0</string><key>uuid</key><string>0</string></dict>
          <key>1</key><dict><key>default value</key><false/><key>name</key><string>CheckedForUserDefaultShell</string><key>required</key><string>0</string><key>type</key><string>0</string><key>uuid</key><string>1</string></dict>
          <key>2</key><dict><key>default value</key><string></string><key>name</key><string>source</string><key>required</key><string>0</string><key>type</key><string>0</string><key>uuid</key><string>2</string></dict>
          <key>3</key><dict><key>default value</key><string></string><key>name</key><string>COMMAND_STRING</string><key>required</key><string>0</string><key>type</key><string>0</string><key>uuid</key><string>3</string></dict>
          <key>4</key><dict><key>default value</key><string>/bin/sh</string><key>name</key><string>shell</string><key>required</key><string>0</string><key>type</key><string>0</string><key>uuid</key><string>4</string></dict>
        </dict>
        <key>conversionLabel</key><integer>0</integer>
        <key>isViewVisible</key><integer>1</integer>
        <key>InputUUID</key><string>9EFC9DB0-6D4D-4D17-A904-17C8E2A7A260</string>
        <key>Keywords</key><array><string>Shell</string><string>Script</string><string>Command</string></array>
        <key>location</key><string>309.000000:305.000000</string>
        <key>nibPath</key><string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/Base.lproj/main.nib</string>
        <key>OutputUUID</key><string>1B6CEBEC-4BB7-4FE5-B52E-BDA54A3BC26B</string>
        <key>UUID</key><string>A76AB10C-A17D-4D98-8873-B3D19C80A950</string>
        <key>UnlocalizedApplications</key><array><string>Automator</string></array>
      </dict>
      <key>isViewVisible</key><integer>1</integer>
    </dict>
  </array>
  <key>connectors</key><dict/>
  <key>workflowMetaData</key>
  <dict>
    <key>applicationBundleID</key><string>com.apple.finder</string>
    <key>applicationBundleIDsByPath</key><dict><key>/System/Library/CoreServices/Finder.app</key><string>com.apple.finder</string></dict>
    <key>applicationPath</key><string>/System/Library/CoreServices/Finder.app</string>
    <key>applicationPaths</key><array><string>/System/Library/CoreServices/Finder.app</string></array>
    <key>inputTypeIdentifier</key><string>com.apple.Automator.fileSystemObject</string>
    <key>outputTypeIdentifier</key><string>com.apple.Automator.nothing</string>
    <key>presentationMode</key><integer>15</integer>
    <key>processesInput</key><false/>
    <key>serviceApplicationBundleID</key><string>com.apple.finder</string>
    <key>serviceApplicationPath</key><string>/System/Library/CoreServices/Finder.app</string>
    <key>serviceInputTypeIdentifier</key><string>com.apple.Automator.fileSystemObject</string>
    <key>serviceOutputTypeIdentifier</key><string>com.apple.Automator.nothing</string>
    <key>serviceProcessesInput</key><false/>
    <key>systemImageName</key><string>NSActionTemplate</string>
    <key>useAutomaticInputType</key><false/>
    <key>workflowTypeIdentifier</key><string>com.apple.Automator.servicesMenu</string>
  </dict>
</dict>
</plist>
`;
}

export function finderQuickActionInfoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSServices</key>
  <array>
    <dict>
      <key>NSBackgroundColorName</key><string>background</string>
      <key>NSIconName</key><string>NSActionTemplate</string>
      <key>NSMenuItem</key><dict><key>default</key><string>${FINDER_QUICK_ACTION_NAME}</string></dict>
      <key>NSMessage</key><string>runWorkflowAsService</string>
      <key>NSRequiredContext</key><dict><key>NSApplicationIdentifier</key><string>com.apple.finder</string></dict>
      <key>NSSendFileTypes</key><array><string>${MARKDOWN_UTI}</string></array>
    </dict>
  </array>
</dict>
</plist>
`;
}

export async function installFinderQuickAction({
  homeDirectory = os.homedir(),
  refreshServices = homeDirectory === os.homedir(),
} = {}) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const cliPath = path.join(projectRoot, "src", "cli.js");
  const workflowDirectory = path.join(
    homeDirectory,
    "Library",
    "Services",
    `${FINDER_QUICK_ACTION_NAME}.workflow`,
    "Contents",
  );
  await fs.mkdir(workflowDirectory, { recursive: true });
  await fs.writeFile(
    path.join(workflowDirectory, "document.wflow"),
    finderQuickActionWorkflow({ nodePath: process.execPath, cliPath }),
    { mode: 0o644 },
  );
  await fs.writeFile(
    path.join(workflowDirectory, "Info.plist"),
    finderQuickActionInfoPlist(),
    { mode: 0o644 },
  );
  if (refreshServices) {
    execFileSync("/System/Library/CoreServices/pbs", ["-update"]);
  }
  return path.dirname(workflowDirectory);
}
