import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  APP_SUPPORT_DIR,
  ERROR_LOG_PATH,
  HEARTBEAT_ERROR_LOG_PATH,
  HEARTBEAT_LAUNCH_AGENT_PATH,
  HEARTBEAT_LOG_PATH,
  LAUNCH_AGENT_PATH,
  LOG_PATH,
} from "./paths.js";
import { ensureDirectory } from "./files.js";

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function installLaunchAgent() {
  const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const nodePath = process.execPath;
  const oauthClient =
    process.env.GOOGLE_DOCS_SYNC_OAUTH_CLIENT ??
    path.join(APP_SUPPORT_DIR, "oauth-client.json");
  await ensureDirectory(path.dirname(LAUNCH_AGENT_PATH));
  await ensureDirectory(APP_SUPPORT_DIR);

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.roman.google-docs-markdown-sync</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(path.join(projectRoot, "src", "cli.js"))}</string>
    <string>daemon</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(projectRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GOOGLE_DOCS_SYNC_OAUTH_CLIENT</key>
    <string>${xmlEscape(oauthClient)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(LOG_PATH)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(ERROR_LOG_PATH)}</string>
</dict>
</plist>
`;
  await fs.writeFile(LAUNCH_AGENT_PATH, plist, { mode: 0o600 });
  execFileSync("/usr/bin/plutil", ["-lint", LAUNCH_AGENT_PATH], {
    stdio: "inherit",
  });
  const domain = `gui/${process.getuid()}`;
  try {
    execFileSync("/bin/launchctl", [
      "bootout",
      domain,
      LAUNCH_AGENT_PATH,
    ]);
  } catch {
    // It is normal for a first installation not to have an existing service.
  }
  execFileSync("/bin/launchctl", [
    "bootstrap",
    domain,
    LAUNCH_AGENT_PATH,
  ]);
  execFileSync("/bin/launchctl", [
    "kickstart",
    "-k",
    `${domain}/com.roman.google-docs-markdown-sync`,
  ]);
  return LAUNCH_AGENT_PATH;
}

export async function installHeartbeatLaunchAgent({
  recipient = "s.roman@gmail.com",
  sender = "Google Docs Sync <onboarding@resend.dev>",
} = {}) {
  const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  await ensureDirectory(path.dirname(HEARTBEAT_LAUNCH_AGENT_PATH));
  await ensureDirectory(APP_SUPPORT_DIR);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.roman.google-docs-markdown-sync.heartbeat</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(path.join(projectRoot, "src", "cli.js"))}</string>
    <string>heartbeat</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(projectRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GOOGLE_DOCS_SYNC_HEARTBEAT_TO</key>
    <string>${xmlEscape(recipient)}</string>
    <key>GOOGLE_DOCS_SYNC_HEARTBEAT_FROM</key>
    <string>${xmlEscape(sender)}</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key>
    <integer>2</integer>
    <key>Hour</key>
    <integer>9</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(HEARTBEAT_LOG_PATH)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(HEARTBEAT_ERROR_LOG_PATH)}</string>
</dict>
</plist>
`;
  await fs.writeFile(HEARTBEAT_LAUNCH_AGENT_PATH, plist, { mode: 0o600 });
  execFileSync("/usr/bin/plutil", ["-lint", HEARTBEAT_LAUNCH_AGENT_PATH], {
    stdio: "inherit",
  });
  const domain = `gui/${process.getuid()}`;
  try {
    execFileSync("/bin/launchctl", [
      "bootout",
      domain,
      HEARTBEAT_LAUNCH_AGENT_PATH,
    ]);
  } catch {
    // It is normal for a first installation not to have an existing service.
  }
  execFileSync("/bin/launchctl", [
    "bootstrap",
    domain,
    HEARTBEAT_LAUNCH_AGENT_PATH,
  ]);
  return HEARTBEAT_LAUNCH_AGENT_PATH;
}
