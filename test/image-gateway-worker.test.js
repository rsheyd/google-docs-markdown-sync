import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import worker from "../cloudflare/image-gateway-worker.js";

const secret = "test-gateway-secret";
const key = "google-docs-image-staging/00000000-0000-4000-8000-000000000000";

function signedRequest({ expiresAt = Math.floor(Date.now() / 1_000) + 60, signature } = {}) {
  const sig = signature ?? crypto
    .createHmac("sha256", secret)
    .update(`${key}\n${expiresAt}`)
    .digest("base64url");
  return new Request(`https://gateway.example/${key}?exp=${expiresAt}&sig=${sig}`);
}

const object = {
  body: Buffer.from("image"),
  size: 5,
  httpEtag: '"etag"',
  writeHttpMetadata(headers) {
    headers.set("Content-Type", "image/png");
  },
};

test("gateway returns a signed staging object and rejects an altered signature", async () => {
  const env = {
    GATEWAY_SECRET: secret,
    IMAGE_BUCKET: { get: async () => object },
  };
  const accepted = await worker.fetch(signedRequest(), env);
  assert.equal(accepted.status, 200);
  assert.equal(await accepted.text(), "image");
  assert.equal(accepted.headers.get("content-type"), "image/png");

  const rejected = await worker.fetch(signedRequest({ signature: "A".repeat(43) }), env);
  assert.equal(rejected.status, 403);
});

test("gateway rejects expired URLs and keys outside the staging prefix", async () => {
  const env = { GATEWAY_SECRET: secret, IMAGE_BUCKET: {} };
  const expired = await worker.fetch(
    signedRequest({ expiresAt: Math.floor(Date.now() / 1_000) - 1 }),
    env,
  );
  assert.equal(expired.status, 403);
  const wrongPath = new Request("https://gateway.example/not-staging?exp=1&sig=x");
  assert.equal((await worker.fetch(wrongPath, env)).status, 403);
});
