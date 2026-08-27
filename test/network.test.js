import test from "node:test";
import assert from "node:assert/strict";
import {
  createNetworkGate,
  createWakeMonitor,
  googleApiHostAvailable,
} from "../src/network.js";

test("checks Google API DNS reachability", async () => {
  assert.equal(await googleApiHostAvailable({ lookup: (_host, callback) => callback() }), true);
  assert.equal(
    await googleApiHostAvailable({
      lookup: (_host, callback) => callback(Object.assign(new Error("offline"), { code: "ENOTFOUND" })),
    }),
    false,
  );
});

test("pauses offline work once and resumes automatically", async () => {
  const logs = [];
  const availability = [false, false, true];
  const gate = createNetworkGate({
    isAvailable: async () => availability.shift(),
    logger: { log: (message) => logs.push(message) },
  });
  let runs = 0;
  assert.equal(await gate.run(() => ++runs), undefined);
  assert.equal(await gate.run(() => ++runs), undefined);
  assert.equal(await gate.run(() => ++runs), 1);
  assert.equal(logs.filter((line) => line.startsWith("sync paused:")).length, 1);
  assert.equal(logs.filter((line) => line.startsWith("sync resumed:")).length, 1);
});

test("allows connectivity to settle after a likely wake", async () => {
  const events = [];
  const gate = createNetworkGate({
    isAvailable: async () => {
      events.push("check");
      return true;
    },
    logger: { log: (message) => events.push(message) },
    settleMs: 5_000,
    wait: async (delayMs) => events.push(`wait:${delayMs}`),
  });
  gate.markWake();
  await gate.run(() => events.push("sync"));
  assert.deepEqual(events, [
    "wake: waiting 5000ms for network connectivity to settle.",
    "wait:5000",
    "check",
    "sync",
  ]);
});

test("increments the wake generation after a delayed liveness tick", () => {
  let currentTime = 1_000;
  let tick;
  let cleared;
  const wakes = [];
  const monitor = createWakeMonitor({
    intervalMs: 1_000,
    toleranceMs: 10_000,
    now: () => currentTime,
    onWake: (event) => wakes.push(event),
    setIntervalImplementation: (callback) => {
      tick = callback;
      return 42;
    },
    clearIntervalImplementation: (timer) => {
      cleared = timer;
    },
  });
  const cycle = monitor.beginCycle();
  currentTime = 3_000;
  tick();
  assert.equal(cycle.isCurrent(), true);
  currentTime = 20_000;
  assert.equal(cycle.isCurrent(), false);
  assert.deepEqual(wakes, [{ elapsedMs: 17_000, generation: 1 }]);
  monitor.close();
  assert.equal(cleared, 42);
});

test("settles once after wake and stays paused until connectivity returns", async () => {
  const events = [];
  const availability = [false, true];
  const gate = createNetworkGate({
    isAvailable: async () => availability.shift(),
    logger: { log: (message) => events.push(message) },
    settleMs: 15_000,
    wait: async (delayMs) => events.push(`wait:${delayMs}`),
  });
  gate.markWake();
  assert.equal(await gate.run(() => events.push("first sync")), undefined);
  await gate.run(() => events.push("second sync"));
  assert.deepEqual(events, [
    "wake: waiting 15000ms for network connectivity to settle.",
    "wait:15000",
    "sync paused: Google API hostname is not reachable; waiting for network connectivity.",
    "sync resumed: network connectivity is available.",
    "second sync",
  ]);
});
