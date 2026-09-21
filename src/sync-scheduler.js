import path from "node:path";

export const SYNC_BATCH_SIZE = 20;
export const MAX_SYNC_CONCURRENCY = 8;

export function syncConcurrency(value = process.env.GOOGLE_DOCS_SYNC_CONCURRENCY ?? 8) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_SYNC_CONCURRENCY) {
    throw new Error("GOOGLE_DOCS_SYNC_CONCURRENCY must be an integer from 1 to 8.");
  }
  return number;
}

export function isPressureError(error) {
  const status = Number(error?.response?.status ?? error?.code);
  return status === 429 || status >= 500 && status <= 599 ||
    error?.response?.data?.error?.errors?.some(({ reason }) =>
      ["rateLimitExceeded", "userRateLimitExceeded"].includes(reason));
}

export function guardSyncServices(services, assertCurrent) {
  const proxies = new WeakMap();
  function wrap(value) {
    if (!value || typeof value !== "object") return value;
    if (proxies.has(value)) return proxies.get(value);
    // Google resource properties can be frozen. A facade avoids violating Proxy
    // invariants while preserving each method's original receiver/context.
    const proxy = new Proxy({}, {
      get(_target, key) {
        const member = Reflect.get(value, key);
        if (typeof member !== "function") return wrap(member);
        return async (...args) => {
          assertCurrent();
          const result = await member.apply(value, args);
          assertCurrent();
          return result;
        };
      },
    });
    proxies.set(value, proxy);
    return proxy;
  }
  return { ...services, drive: wrap(services.drive), docs: wrap(services.docs), sheets: wrap(services.sheets) };
}

function conflicts(a, b) {
  const remoteA = a.documentId ?? a.spreadsheetId;
  const remoteB = b.documentId ?? b.spreadsheetId;
  if (remoteA && remoteA === remoteB) return true;
  if (!a.absolutePath || !b.absolutePath) return false;
  const first = path.resolve(a.absolutePath);
  const second = path.resolve(b.absolutePath);
  return first === second || first.startsWith(second + path.sep) || second.startsWith(first + path.sep);
}

// Workers never own shared state. Drain every admitted operation before returning,
// even on interruption, so the next single-flight pass cannot overlap old work.
export async function computeSyncBatch({
  pairings, work, concurrency = 8, assertCurrent = () => {},
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pressureDelay = (failures) => Math.min(60_000, 5_000 * 2 ** failures),
}) {
  concurrency = syncConcurrency(concurrency);
  const results = [];
  let pressureFailures = 0;
  for (let offset = 0; offset < pairings.length;) {
    assertCurrent();
    const wave = [];
    while (offset < pairings.length && wave.length < concurrency) {
      const pairing = pairings[offset];
      if (wave.some((other) => conflicts(pairing, other))) break;
      wave.push(pairing);
      offset += 1;
    }
    const settled = await Promise.allSettled(wave.map((pairing) => Promise.resolve().then(() => work(pairing))));
    assertCurrent();
    const outcomes = settled.map((entry, index) => entry.status === "fulfilled"
      ? entry.value
      : { pairing: wave[index], action: "error", error: entry.reason });
    const interrupted = outcomes.find((result) => result.error?.name === "SyncPassInterruptedError");
    if (interrupted) throw interrupted.error;
    results.push(...outcomes);
    if (outcomes.some((result) => isPressureError(result.error))) {
      pressureFailures += 1;
      concurrency = Math.max(1, Math.floor(concurrency / 2));
      // Cool down even after the final wave before the coordinator starts more work.
      await wait(pressureDelay(pressureFailures));
      assertCurrent();
    } else {
      pressureFailures = 0;
    }
  }
  return results;
}
