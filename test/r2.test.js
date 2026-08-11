import test from "node:test";
import assert from "node:assert/strict";
import {
  createR2Stager,
  loadR2Configuration,
  R2_ACCESS_KEY_SERVICE,
  R2_GATEWAY_SECRET_SERVICE,
  R2_SECRET_KEY_SERVICE,
} from "../src/r2.js";

test("loads non-secret R2 settings from the environment and credentials from Keychain", () => {
  const configuration = loadR2Configuration({
    env: {
      GOOGLE_DOCS_SYNC_R2_ACCOUNT_ID: "account",
      GOOGLE_DOCS_SYNC_R2_BUCKET: "bucket",
      GOOGLE_DOCS_SYNC_R2_GATEWAY_URL: "https://gateway.example",
    },
    readSecret(service) {
      return service === R2_ACCESS_KEY_SERVICE ? "access" :
        service === R2_SECRET_KEY_SERVICE ? "secret" :
        service === R2_GATEWAY_SECRET_SERVICE ? "gateway-secret" : "";
    },
  });
  assert.deepEqual(configuration, {
    accountId: "account",
    bucket: "bucket",
    gatewayUrl: "https://gateway.example",
    accessKeyId: "access",
    secretAccessKey: "secret",
    gatewaySecret: "gateway-secret",
    endpoint: "https://account.r2.cloudflarestorage.com",
  });
});

test("reports every missing R2 setting without exposing values", () => {
  assert.throws(
    () => loadR2Configuration({
      env: {
        GOOGLE_DOCS_SYNC_R2_ACCOUNT_ID: " ",
        GOOGLE_DOCS_SYNC_R2_BUCKET: " ",
        GOOGLE_DOCS_SYNC_R2_GATEWAY_URL: " ",
      },
      readSecret: () => "",
    }),
    /missing GOOGLE_DOCS_SYNC_R2_ACCOUNT_ID, GOOGLE_DOCS_SYNC_R2_BUCKET, GOOGLE_DOCS_SYNC_R2_GATEWAY_URL, R2 access key in Keychain, R2 secret key in Keychain, R2 gateway secret in Keychain/,
  );
});

test("uploads, signs, and idempotently deletes a staged image", async () => {
  const commands = [];
  const client = { send: async (command) => { commands.push(command.constructor.name); } };
  const stager = createR2Stager(
    {
      bucket: "bucket",
      gatewayUrl: "https://gateway.example",
      gatewaySecret: "gateway-secret",
    },
    {
      client,
      randomUUID: () => "random-key",
      now: () => 1_000_000,
    },
  );
  const staged = await stager.stage({
    bytes: Buffer.from("image"),
    contentType: "image/png",
  });
  assert.equal(staged.key, "google-docs-image-staging/random-key");
  const stagedUrl = new URL(staged.url);
  assert.equal(stagedUrl.origin, "https://gateway.example");
  assert.equal(stagedUrl.pathname, "/google-docs-image-staging/random-key");
  assert.equal(stagedUrl.searchParams.get("exp"), "1900");
  assert.match(stagedUrl.searchParams.get("sig"), /^[A-Za-z0-9_-]{43}$/);
  await staged.cleanup();
  await staged.cleanup();
  assert.deepEqual(commands, ["PutObjectCommand", "DeleteObjectCommand"]);
});

test("deletes a staged object when gateway URL generation fails", async () => {
  const commands = [];
  const client = { send: async (command) => { commands.push(command.constructor.name); } };
  const stager = createR2Stager(
    { bucket: "bucket", gatewayUrl: "not a URL", gatewaySecret: "secret" },
    {
      client,
      randomUUID: () => "random-key",
    },
  );
  await assert.rejects(
    stager.stage({ bytes: Buffer.from("image"), contentType: "image/png" }),
    /Invalid URL/,
  );
  assert.deepEqual(commands, ["PutObjectCommand", "DeleteObjectCommand"]);
});
