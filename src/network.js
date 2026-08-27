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

export function createWakeMonitor({
  intervalMs = 1_000,
  toleranceMs = 10_000,
  now = Date.now,
  onWake = () => {},
  setIntervalImplementation = setInterval,
  clearIntervalImplementation = clearInterval,
} = {}) {
  let generation = 0;
  let lastObservedAt = now();

  function observe() {
    const observedAt = now();
    const elapsedMs = observedAt - lastObservedAt;
    if (elapsedMs > intervalMs + toleranceMs) {
      generation += 1;
      onWake({ elapsedMs, generation });
    }
    lastObservedAt = observedAt;
    return generation;
  }

  const timer = setIntervalImplementation(observe, intervalMs);
  timer?.unref?.();

  function beginCycle() {
    const startingGeneration = observe();
    return {
      isCurrent() {
        return observe() === startingGeneration;
      },
    };
  }

  function close() {
    clearIntervalImplementation(timer);
  }

  return { beginCycle, close, observe };
}
