import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const FINDER_QUICK_ACTION_NAME = "Sync MDs with New Google Docs (GDMS)";
export const SYNC_PAIRED_FILE_QUICK_ACTION_NAME = "Sync Paired File Now (GDMS)";
export const CSV_FINDER_QUICK_ACTION_NAME = "Combine & Sync CSVs with New Google Sheet (GDMS)";
const LEGACY_FINDER_QUICK_ACTION_NAMES = ["Sync with Google Docs (GDMS)"];
const LEGACY_CSV_FINDER_QUICK_ACTION_NAMES = [
  "Sync with Google Sheets (GDMS)",
  "Combine CSVs into One Google Sheet (GDMS)",
];
export const FINDER_QUICK_ACTION_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.ExtensionsPreferences?extensionPointIdentifier=com.apple.finder-quick-actions";
export const MARKDOWN_UTI = "net.daringfireball.markdown";
export const CSV_UTI = "public.comma-separated-values-text";

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
if (( $# == 0 )); then
  echo "GDMS requires at least one Markdown file." >&2
  exit 64
fi
if (( $# == 1 )); then
  case "$1" in
    *.md) ${shellQuote(nodePath)} ${shellQuote(cliPath)} create --file "$1" --open ;;
    *) echo "GDMS only accepts Markdown (.md) files: $1" >&2; exit 64 ;;
  esac
  exit 0
fi
created_count=0
for markdown_file in "$@"; do
  case "$markdown_file" in
    *.md) ${shellQuote(nodePath)} ${shellQuote(cliPath)} create --file "$markdown_file" ;;
    *) echo "GDMS only accepts Markdown (.md) files: $markdown_file" >&2; exit 64 ;;
  esac
  (( created_count += 1 ))
done
/usr/bin/osascript \
  -e 'on run argv' \
  -e 'display notification ((item 1 of argv) & " new Google Docs created and synced.") with title "GDMS"' \
  -e 'end run' \
  "$created_count" >/dev/null 2>&1 || true`;
}

export function syncPairedFileQuickActionShellCommand({ nodePath, cliPath }) {
  return `set -e
if (( $# == 0 )); then
  echo "GDMS requires at least one paired Markdown file." >&2
  exit 64
fi
file_arguments=()
for markdown_file in "$@"; do
  case "$markdown_file" in
    *.md) file_arguments+=(--file "$markdown_file") ;;
    *) echo "GDMS only accepts Markdown (.md) files: $markdown_file" >&2; exit 64 ;;
  esac
done
if sync_result="$(${shellQuote(nodePath)} ${shellQuote(cliPath)} sync-once "${"${file_arguments[@]}"}" 2>&1)"; then
  /usr/bin/osascript \\
    -e 'on run argv' \\
    -e 'display dialog (item 1 of argv) with title "GDMS Sync Complete" buttons {"OK"} default button "OK"' \\
    -e 'end run' \\
    "$sync_result"
else
  /usr/bin/osascript \\
    -e 'on run argv' \\
    -e 'display alert "GDMS Sync Failed" message (item 1 of argv)' \\
    -e 'end run' \\
    "$sync_result"
  exit 1
fi`;
}

export function csvFinderQuickActionShellCommand({ nodePath, cliPath }) {
  return `set -e
if (( $# == 0 )); then
  echo "GDMS requires at least one CSV file." >&2
  exit 64
fi
csv_arguments=()
source_directory="$(/usr/bin/dirname "$1")"
for csv_file in "$@"; do
  case "$csv_file" in
    *.[cC][sS][vV]) ;;
    *) echo "GDMS only accepts CSV (.csv) files: $csv_file" >&2; exit 64 ;;
  esac
  if [[ "$(/usr/bin/dirname "$csv_file")" != "$source_directory" ]]; then
    echo "GDMS requires selected CSV files to share a directory." >&2
    exit 64
  fi
  csv_arguments+=(--file "$csv_file")
done
default_name="$(/usr/bin/basename "$1")"
default_name="${"${default_name%.*}"}"
spreadsheet_name="$(/usr/bin/osascript \
  -e 'on run argv' \
  -e 'display dialog "Name the new Google Sheet and local directory:" default answer (item 1 of argv) buttons {"Cancel", "Create"} default button "Create"' \
  -e 'text returned of result' \
  -e 'end run' \
  "$default_name")"
${shellQuote(nodePath)} ${shellQuote(cliPath)} create-sheet "${"${csv_arguments[@]}"}" --name "$spreadsheet_name" --open`;
}

function quickActionWorkflow(command) {
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

export function finderQuickActionWorkflow({ nodePath, cliPath }) {
  return quickActionWorkflow(finderQuickActionShellCommand({ nodePath, cliPath }));
}

export function syncPairedFileQuickActionWorkflow({ nodePath, cliPath }) {
  return quickActionWorkflow(
    syncPairedFileQuickActionShellCommand({ nodePath, cliPath }),
  );
}

export function csvFinderQuickActionWorkflow({ nodePath, cliPath }) {
  return quickActionWorkflow(csvFinderQuickActionShellCommand({ nodePath, cliPath }));
}

function quickActionInfoPlist(name, uti) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSServices</key>
  <array>
    <dict>
      <key>NSBackgroundColorName</key><string>background</string>
      <key>NSIconName</key><string>NSActionTemplate</string>
      <key>NSMenuItem</key><dict><key>default</key><string>${xmlEscape(name)}</string></dict>
      <key>NSMessage</key><string>runWorkflowAsService</string>
      <key>NSRequiredContext</key><dict><key>NSApplicationIdentifier</key><string>com.apple.finder</string></dict>
      <key>NSSendFileTypes</key><array><string>${xmlEscape(uti)}</string></array>
    </dict>
  </array>
</dict>
</plist>
`;
}


export function finderQuickActionInfoPlist() {
  return quickActionInfoPlist(FINDER_QUICK_ACTION_NAME, MARKDOWN_UTI);
}

export function syncPairedFileQuickActionInfoPlist() {
  return quickActionInfoPlist(SYNC_PAIRED_FILE_QUICK_ACTION_NAME, MARKDOWN_UTI);
}

export function csvFinderQuickActionInfoPlist() {
  return quickActionInfoPlist(CSV_FINDER_QUICK_ACTION_NAME, CSV_UTI);
}

async function writeQuickAction(homeDirectory, name, workflow, info) {
  const workflowDirectory = path.join(
    homeDirectory,
    "Library",
    "Services",
    `${name}.workflow`,
    "Contents",
  );
  await fs.mkdir(workflowDirectory, { recursive: true });
  await fs.writeFile(path.join(workflowDirectory, "document.wflow"), workflow, { mode: 0o644 });
  await fs.writeFile(path.join(workflowDirectory, "Info.plist"), info, { mode: 0o644 });
  return path.dirname(workflowDirectory);
}

export async function installFinderQuickAction({
  homeDirectory = os.homedir(),
  refreshServices = homeDirectory === os.homedir(),
} = {}) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const cliPath = path.join(projectRoot, "src", "cli.js");
  const markdownPath = await writeQuickAction(
    homeDirectory,
    FINDER_QUICK_ACTION_NAME,
    finderQuickActionWorkflow({ nodePath: process.execPath, cliPath }),
    finderQuickActionInfoPlist(),
  );
  await Promise.all(LEGACY_FINDER_QUICK_ACTION_NAMES.map((name) => fs.rm(path.join(
    homeDirectory,
    "Library",
    "Services",
    `${name}.workflow`,
  ), { recursive: true, force: true })));
  await writeQuickAction(
    homeDirectory,
    SYNC_PAIRED_FILE_QUICK_ACTION_NAME,
    syncPairedFileQuickActionWorkflow({ nodePath: process.execPath, cliPath }),
    syncPairedFileQuickActionInfoPlist(),
  );
  await writeQuickAction(
    homeDirectory,
    CSV_FINDER_QUICK_ACTION_NAME,
    csvFinderQuickActionWorkflow({ nodePath: process.execPath, cliPath }),
    csvFinderQuickActionInfoPlist(),
  );
  await Promise.all(LEGACY_CSV_FINDER_QUICK_ACTION_NAMES.map((name) => fs.rm(path.join(
    homeDirectory,
    "Library",
    "Services",
    `${name}.workflow`,
  ), { recursive: true, force: true })));
  if (refreshServices) {
    execFileSync("/System/Library/CoreServices/pbs", ["-update"]);
    try {
      execFileSync("/usr/bin/open", [FINDER_QUICK_ACTION_SETTINGS_URL]);
    } catch {
      // The workflows are installed even if System Settings cannot be opened.
    }
  }
  return markdownPath;
}
