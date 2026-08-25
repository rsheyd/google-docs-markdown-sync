import test from "node:test";
import assert from "node:assert/strict";
import {
  createNetworkGate,
  googleApiHostAvailable,
  timerLikelyCrossedSleep,
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

test("detects timers delayed substantially beyond their scheduled wake", () => {
  assert.equal(timerLikelyCrossedSleep({ startedAt: 1_000, delayMs: 5_000, finishedAt: 12_000 }), false);
  assert.equal(timerLikelyCrossedSleep({ startedAt: 1_000, delayMs: 5_000, finishedAt: 17_000 }), true);
});
