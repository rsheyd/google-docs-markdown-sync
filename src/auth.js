import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { authenticate } from "@google-cloud/local-auth";
import { google } from "googleapis";
import { googleRequestTimeoutMs } from "./config.js";
import { APP_SUPPORT_DIR } from "./paths.js";

const KEYCHAIN_SERVICE = "com.roman.google-docs-markdown-sync";
const KEYCHAIN_ACCOUNT = "google-oauth";
const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
];

function clientPath() {
  return (
    process.env.GOOGLE_DOCS_SYNC_OAUTH_CLIENT ??
    path.join(APP_SUPPORT_DIR, "oauth-client.json")
  );
}

async function readClientConfiguration() {
  const raw = JSON.parse(await fs.readFile(clientPath(), "utf8"));
  const configuration = raw.installed ?? raw.web;
  if (!configuration?.client_id || !configuration?.client_secret) {
    throw new Error("OAuth JSON does not contain an installed or web client.");
  }
  return configuration;
}

function readKeychainCredentials() {
  try {
    const value = execFileSync(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        KEYCHAIN_ACCOUNT,
        "-w",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function writeKeychainCredentials(credentials) {
  execFileSync(
    "/usr/bin/security",
    [
      "add-generic-password",
      "-U",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      KEYCHAIN_ACCOUNT,
      "-w",
      JSON.stringify(credentials),
    ],
    { stdio: "ignore" },
  );
}

export async function authorize() {
  const client = await authenticate({
    keyfilePath: clientPath(),
    scopes: SCOPES,
  });
  writeKeychainCredentials(client.credentials);
  return client;
}

export async function getAuthClient({ interactive = false } = {}) {
  const configuration = await readClientConfiguration();
  const credentials = readKeychainCredentials();
  if (!credentials) {
    if (interactive) return authorize();
    throw new Error("No OAuth token found. Run `npm run auth` first.");
  }

  const client = new google.auth.OAuth2(
    configuration.client_id,
    configuration.client_secret,
    configuration.redirect_uris?.[0],
  );
  client.transporter.defaults.timeout = googleRequestTimeoutMs();
  client.setCredentials(credentials);
  client.on("tokens", (tokens) => {
    const merged = { ...client.credentials, ...tokens };
    writeKeychainCredentials(merged);
  });
  return client;
}

export { SCOPES };
