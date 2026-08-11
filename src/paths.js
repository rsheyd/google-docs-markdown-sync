import os from "node:os";
import path from "node:path";

export const DEFAULT_DEV_ROOT = "/Users/roman/dev";
export const MANIFEST_NAME = "google-docs-sync.json";
export const APP_SUPPORT_DIR = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "google-docs-markdown-sync",
);
export const STATE_PATH = path.join(APP_SUPPORT_DIR, "state.json");
export const R2_CONFIG_PATH = path.join(APP_SUPPORT_DIR, "r2.json");
export const INDEX_PATH = path.join(APP_SUPPORT_DIR, "workspaces.json");
export const LOG_PATH = path.join(APP_SUPPORT_DIR, "service.log");
export const ERROR_LOG_PATH = path.join(APP_SUPPORT_DIR, "service-error.log");
export const HEARTBEAT_LOG_PATH = path.join(APP_SUPPORT_DIR, "heartbeat.log");
export const HEARTBEAT_ERROR_LOG_PATH = path.join(
  APP_SUPPORT_DIR,
  "heartbeat-error.log",
);
export const LAUNCH_AGENT_PATH = path.join(
  os.homedir(),
  "Library",
  "LaunchAgents",
  "com.roman.google-docs-markdown-sync.plist",
);
export const HEARTBEAT_LAUNCH_AGENT_PATH = path.join(
  os.homedir(),
  "Library",
  "LaunchAgents",
  "com.roman.google-docs-markdown-sync.heartbeat.plist",
);
