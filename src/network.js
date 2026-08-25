import { lookup as dnsLookup } from "node:dns";

const GOOGLE_API_HOST = "www.googleapis.com";

export function googleApiHostAvailable({ lookup = dnsLookup } = {}) {
  return new Promise((resolve) => {
    lookup(GOOGLE_API_HOST, (error) => resolve(!error));
  });
}

export function createNetworkGate({
  isAvailable = googleApiHostAvailable,
  logger = console,
  settleMs = 5_000,
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
} = {}) {
  let paused = false;
  let wakeDetected = false;
  let checkTail = Promise.resolve();

  function markWake() {
    wakeDetected = true;
  }

  async function check() {
    if (wakeDetected) {
      wakeDetected = false;
      logger.log(`wake: waiting ${settleMs}ms for network connectivity to settle.`);
      await wait(settleMs);
    }
    if (!(await isAvailable())) {
      if (!paused) {
        paused = true;
        logger.log("sync paused: Google API hostname is not reachable; waiting for network connectivity.");
      }
      return false;
    }
    if (paused) {
      paused = false;
      logger.log("sync resumed: network connectivity is available.");
    }
    return true;
  }

  function run(operation) {
    const result = checkTail.then(async () => {
      if (!(await check())) return undefined;
      return operation();
    });
    checkTail = result.catch(() => undefined);
    return result;
  }

  return { markWake, run };
}

export function timerLikelyCrossedSleep({
  startedAt,
  delayMs,
  finishedAt = Date.now(),
  toleranceMs = Math.max(10_000, delayMs * 2),
}) {
  return finishedAt - startedAt > delayMs + toleranceMs;
}
