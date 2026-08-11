import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { R2_CONFIG_PATH } from "./paths.js";

export const R2_ACCESS_KEY_SERVICE =
  "com.roman.google-docs-markdown-sync.r2-access-key";
export const R2_SECRET_KEY_SERVICE =
  "com.roman.google-docs-markdown-sync.r2-secret-key";
export const R2_GATEWAY_SECRET_SERVICE =
  "com.roman.google-docs-markdown-sync.r2-gateway-secret";
const R2_KEYCHAIN_ACCOUNT = "r2";
const DEFAULT_SIGNED_URL_SECONDS = 15 * 60;

function readKeychainValue(service) {
  try {
    return execFileSync(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-s",
        service,
        "-a",
        R2_KEYCHAIN_ACCOUNT,
        "-w",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return "";
  }
}

export function loadR2Configuration({ env = process.env, readSecret = readKeychainValue } = {}) {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(R2_CONFIG_PATH, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const accountId = env.GOOGLE_DOCS_SYNC_R2_ACCOUNT_ID?.trim() ?? stored.accountId;
  const bucket = env.GOOGLE_DOCS_SYNC_R2_BUCKET?.trim() ?? stored.bucket;
  const gatewayUrl = env.GOOGLE_DOCS_SYNC_R2_GATEWAY_URL?.trim() ?? stored.gatewayUrl;
  const accessKeyId = readSecret(R2_ACCESS_KEY_SERVICE);
  const secretAccessKey = readSecret(R2_SECRET_KEY_SERVICE);
  const gatewaySecret = readSecret(R2_GATEWAY_SECRET_SERVICE);
  const missing = [
    ...(!accountId ? ["GOOGLE_DOCS_SYNC_R2_ACCOUNT_ID"] : []),
    ...(!bucket ? ["GOOGLE_DOCS_SYNC_R2_BUCKET"] : []),
    ...(!gatewayUrl ? ["GOOGLE_DOCS_SYNC_R2_GATEWAY_URL"] : []),
    ...(!accessKeyId ? ["R2 access key in Keychain"] : []),
    ...(!secretAccessKey ? ["R2 secret key in Keychain"] : []),
    ...(!gatewaySecret ? ["R2 gateway secret in Keychain"] : []),
  ];
  if (missing.length) {
    throw new Error(`Cloudflare R2 is not configured: missing ${missing.join(", ")}.`);
  }
  return {
    accountId,
    bucket,
    gatewayUrl,
    accessKeyId,
    secretAccessKey,
    gatewaySecret,
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  };
}

export function createR2Stager(
  configuration,
  {
    client = new S3Client({
      region: "auto",
      endpoint: configuration.endpoint,
      credentials: {
        accessKeyId: configuration.accessKeyId,
        secretAccessKey: configuration.secretAccessKey,
      },
    }),
    randomUUID = crypto.randomUUID,
    expiresIn = DEFAULT_SIGNED_URL_SECONDS,
    now = () => Date.now(),
  } = {},
) {
  return {
    async stage({ bytes, contentType }) {
      const key = `google-docs-image-staging/${randomUUID()}`;
      await client.send(new PutObjectCommand({
        Bucket: configuration.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
      }));
      let cleaned = false;
      const cleanup = async () => {
        if (cleaned) return;
        await client.send(new DeleteObjectCommand({
          Bucket: configuration.bucket,
          Key: key,
        }));
        cleaned = true;
      };
      try {
        const expiresAt = Math.floor(now() / 1_000) + expiresIn;
        const signature = crypto
          .createHmac("sha256", configuration.gatewaySecret)
          .update(`${key}\n${expiresAt}`)
          .digest("base64url");
        const urlObject = new URL(`${configuration.gatewayUrl.replace(/\/$/, "")}/${key}`);
        urlObject.searchParams.set("exp", String(expiresAt));
        urlObject.searchParams.set("sig", signature);
        const url = urlObject.toString();
        if (url.length > 2_000) {
          throw new Error("The R2 signed image URL exceeds Google Docs' 2 kB limit.");
        }
        return { url, key, cleanup };
      } catch (error) {
        await cleanup().catch(() => {});
        throw error;
      }
    },
  };
}
