const PREFIX = "google-docs-image-staging/";
const MAX_FUTURE_SECONDS = 15 * 60 + 60;

function forbidden() {
  return new Response("Forbidden", {
    status: 403,
    headers: { "Cache-Control": "no-store" },
  });
}

function base64UrlBytes(value) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=";
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    const url = new URL(request.url);
    let key;
    try {
      key = decodeURIComponent(url.pathname.slice(1));
    } catch {
      return forbidden();
    }
    if (!key.startsWith(PREFIX) || !/^google-docs-image-staging\/[0-9a-f-]{36}$/.test(key)) {
      return forbidden();
    }
    const expiresAt = Number(url.searchParams.get("exp"));
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(expiresAt) || expiresAt < now || expiresAt > now + MAX_FUTURE_SECONDS) {
      return forbidden();
    }
    const signature = base64UrlBytes(url.searchParams.get("sig") ?? "");
    if (!signature) return forbidden();
    const secret = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.GATEWAY_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "HMAC",
      secret,
      signature,
      new TextEncoder().encode(`${key}\n${expiresAt}`),
    );
    if (!valid) return forbidden();

    const object = request.method === "HEAD"
      ? await env.IMAGE_BUCKET.head(key)
      : await env.IMAGE_BUCKET.get(key);
    if (!object) return new Response("Not Found", { status: 404 });
    const headers = new Headers({
      "Cache-Control": "private, no-store",
      "Content-Length": String(object.size),
      ETag: object.httpEtag,
    });
    object.writeHttpMetadata(headers);
    return new Response(request.method === "HEAD" ? null : object.body, {
      status: 200,
      headers,
    });
  },
};
