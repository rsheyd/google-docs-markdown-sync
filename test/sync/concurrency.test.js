import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { readLocalSpreadsheet } from "../../src/sheets.js";
import { documentStatusMarkdown, spreadsheetStatusMarkdown } from "../../src/status.js";
import {
  backoffDelay,
  chooseSyncAction,
  commitSyncPass,
  comparableMarkdownHash,
  createSingleFlight,
  createWatcherManager,
  hasImageConflict,
  pullDocument,
  refineTwoSidedAction,
  runDaemon,
  shouldRaiseImageConflict,
  shouldDeferMissingPath,
  syncPairing,
  runSyncBatch,
  runSyncPass,
  assertCurrentSyncPass,
} from "../../src/sync.js";
import { computeSyncBatch, guardSyncServices, isPressureError, syncConcurrency } from "../../src/sync-scheduler.js";
import { createGoogleServices } from "../../src/google.js";


test("serializes overlapping sync operations", async () => {
  const enqueue = createSingleFlight();
  const events = [];
  let releaseFirst;
  const first = enqueue(async () => {
    events.push("first:start");
    await new Promise((resolve) => {
      releaseFirst = resolve;
    });
    events.push("first:end");
  });
  const second = enqueue(async () => {
    events.push("second:start");
    events.push("second:end");
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, [
    "first:start",
    "first:end",
    "second:start",
    "second:end",
  ]);
});

test("does not persist or reconcile an interrupted sync pass", async () => {
  const events = [];
  await assert.rejects(
    commitSyncPass({
      results: [{
        action: "error",
        pairing: { absolutePath: "/paired.md" },
        error: new Error("request aborted"),
      }],
      state: { version: 1, documents: {} },
      isCurrent: () => false,
      errorReporter: {
        report: async () => events.push("report"),
        reconcile: async () => events.push("reconcile"),
      },
      retryNotifications: async () => events.push("retry"),
      persistState: async () => events.push("persist"),
    }),
    { name: "SyncPassInterruptedError" },
  );
  assert.deepEqual(events, []);
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("bounds admission at eight and returns registry order after reverse completions", async () => {
  const pairings = Array.from({ length: 25 }, (_, i) => ({ documentId: String(i) }));
  const releases = [];
  let active = 0;
  let peak = 0;
  const operation = computeSyncBatch({ pairings, work: async (pairing) => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => releases.push(resolve));
    active -= 1;
    return { pairing, action: "none" };
  } });
  for (const size of [8, 8, 8, 1]) {
    await tick();
    assert.equal(active, size);
    releases.splice(0).reverse().forEach((resolve) => resolve());
  }
  assert.deepEqual((await operation).map((result) => result.pairing), pairings);
  assert.equal(peak, 8);
});

test("serializes repeated identities and overlapping local paths", async () => {
  const pairings = [
    { documentId: "a", absolutePath: "/a" },
    { documentId: "a", absolutePath: "/b" },
    { documentId: "c", absolutePath: "/b/nested" },
  ];
  let active = 0;
  await computeSyncBatch({ pairings, work: async (pairing) => {
    assert.equal(active++, 0);
    await tick();
    active -= 1;
    return { pairing, action: "none" };
  } });
});

test("drains admitted workers on wake interruption without starting remaining targets", async () => {
  let current = true;
  let release;
  let finished = false;
  let starts = 0;
  const operation = computeSyncBatch({
    pairings: Array.from({ length: 12 }, (_, i) => ({ documentId: String(i) })),
    assertCurrent: () => assertCurrentSyncPass(() => current),
    work: async (pairing) => {
      starts += 1;
      if (pairing.documentId === "0") await new Promise((resolve) => { release = resolve; });
      return { pairing, action: "none" };
    },
  }).finally(() => { finished = true; });
  const rejected = assert.rejects(operation, { name: "SyncPassInterruptedError" });
  await tick();
  current = false;
  await tick();
  assert.equal(finished, false);
  release();
  await rejected;
  assert.equal(starts, 8);
});

test("pressure reduces admission and uses capped exponential backoff; ordinary failures remain isolated", async () => {
  const waits = [];
  let launched = 0;
  const results = await computeSyncBatch({
    pairings: Array.from({ length: 20 }, (_, i) => ({ documentId: String(i) })),
    work: async () => { launched += 1; throw Object.assign(new Error("rate limited"), { code: 429 }); },
    pressureDelay: (failures) => backoffDelay(5_000, failures, () => 0.5),
    wait: async (ms) => { waits.push({ ms, launched }); },
  });
  assert.deepEqual(waits.slice(0, 4), [
    { ms: 10500, launched: 8 }, { ms: 20500, launched: 12 },
    { ms: 40500, launched: 14 }, { ms: 60000, launched: 15 },
  ]);
  assert.ok(waits.every(({ ms }) => ms <= 60_000));
  assert.equal(results.filter((result) => result.action === "error").length, 20);
  const isolated = await computeSyncBatch({
    pairings: [{ documentId: "bad" }, { documentId: "good" }],
    work: async (pairing) => {
      if (pairing.documentId === "bad") throw new Error("unsupported content");
      return { pairing, action: "none" };
    },
    wait: () => assert.fail("ordinary failures must not throttle independent work"),
  });
  assert.deepEqual(isolated.map((result) => result.action), ["error", "none"]);
});

test("accepts only a one-to-eight worker limit", () => {
  for (const value of [0, 9, -1, 1.5, "invalid"]) assert.throws(() => syncConcurrency(value));
  assert.equal(syncConcurrency("1"), 1);
  assert.equal(syncConcurrency(8), 8);
});

test("identifies rate-limit 403 and server pressure without throttling permission failures", () => {
  assert.equal(Boolean(isPressureError({ code: 403 })), false);
  assert.equal(Boolean(isPressureError({ response: { status: 503 } })), true);
  assert.equal(Boolean(isPressureError({ response: { status: 403, data: { error: { errors: [{ reason: "userRateLimitExceeded" }] } } } })), true);
});

test("workers defer remote renames before reading or writing shared manifests", async () => {
  const pairing = { documentId: "doc", name: "Old title", absolutePath: "/never-accessed.md" };
  const result = await syncPairing({ drive: { files: { get: async () => ({ data: { name: "New title", version: "2" } }) } } }, pairing, {}, { deferRemoteTitle: true });
  assert.equal(result.action, "coordinator-sync");
  assert.equal(result.pairing, pairing);
});

test("wake guards reject responses and prevent subsequent API calls", async () => {
  let current = true;
  let calls = 0;
  const services = guardSyncServices({ drive: { files: { get: async () => {
    calls += 1;
    current = false;
    return { data: {} };
  } } } }, () => assertCurrentSyncPass(() => current));
  await assert.rejects(services.drive.files.get({}), { name: "SyncPassInterruptedError" });
  await assert.rejects(services.drive.files.get({}), { name: "SyncPassInterruptedError" });
  assert.equal(calls, 1);
});

test("API guards support frozen Google resource properties and preserve their receiver", async () => {
  const realServices = createGoogleServices({});
  const guarded = guardSyncServices(realServices, () => {});
  assert.equal(typeof guarded.drive.files.get, "function");
  assert.equal(typeof guarded.docs.documents.batchUpdate, "function");
  assert.equal(typeof guarded.sheets.spreadsheets.values.get, "function");
  const resource = Object.freeze({ value: 42, async get() { return this.value; } });
  const frozen = guardSyncServices({ drive: Object.freeze({ files: resource }) }, () => {});
  assert.equal(await frozen.drive.files.get(), 42);
});

async function batchFixture(t, count = 3) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gdms-batch-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const pairings = Array.from({ length: count }, (_, i) => ({ documentId: String(i), absolutePath: path.join(directory, `${i}.md`) }));
  await Promise.all(pairings.map((pairing) => fs.writeFile(pairing.absolutePath, "content")));
  return { pairings, services: {}, settings: {}, state: { version: 1, documents: {} }, logger: { log() {}, error() {} }, retryNotifications: async () => {} };
}

test("coordinator commits successful proposals and notifications in stable order after all workers settle", async (t) => {
  const options = await batchFixture(t);
  const events = [];
  let release;
  const operation = runSyncBatch({
    ...options,
    synchronize: async (_services, pairing) => {
      if (pairing.documentId === "0") await new Promise((resolve) => { release = resolve; });
      events.push(`work:${pairing.documentId}`);
      if (pairing.documentId === "1") throw new Error("isolated failure");
      return { pairing, action: "none", state: { value: pairing.documentId } };
    },
    persistState: async (state) => { events.push(`persist:${Object.keys(state.documents)}`); },
    retryNotifications: async () => { events.push("deletion-retry"); },
    errorReporter: {
      report: async (pairing) => { events.push(`report:${pairing.documentId}`); },
      reconcile: async (results) => { events.push(`reconcile:${results.map((r) => r.pairing.documentId)}`); },
    },
  });
  while (!release) await tick();
  await tick();
  assert.deepEqual(options.state.documents, {});
  assert.ok(events.every((event) => event.startsWith("work:")));
  release();
  const results = await operation;
  assert.deepEqual(results.map((result) => result.action), ["none", "error", "none"]);
  assert.deepEqual(events.slice(-4), ["report:1", "deletion-retry", "persist:0,2", "reconcile:0,1,2"]);
});

test("a failed document sync surfaces a compact local status and recovery clears it", async (t) => {
  const options = await batchFixture(t, 1);
  const pairing = {
    ...options.pairings[0],
    markdownPath: "0.md",
    name: "Guide",
  };
  options.pairings = [pairing];
  options.persistState = async () => {};
  const remoteWrites = [];
  const remoteDocument = {
    revisionId: "remote-1",
    body: { content: [{ startIndex: 1, endIndex: 1, sectionBreak: {} }] },
  };
  options.services = {
    docs: { documents: {
      get: async () => ({ data: remoteDocument }),
      batchUpdate: async (request) => { remoteWrites.push(request); },
    } },
    drive: { files: { get: async () => ({ data: {
      modifiedTime: "2026-09-22T15:23:47.000Z",
      name: "Guide",
      version: "drive-2",
    } }) } },
  };
  options.state.documents["0"] = {
    lastWriter: "markdown",
    lastSuccessfulSync: "2026-09-22T15:23:47.000Z",
  };
  await runSyncBatch({
    ...options,
    synchronize: async () => {
      throw new Error("Google Docs contains a native table of contents, but its Markdown position could not be identified.");
    },
  });
  assert.match(
    await fs.readFile(pairing.absolutePath, "utf8"),
    /Markdown sync status · Needs attention: Native table of contents could not be matched/,
  );
  assert.deepEqual(options.state.documents["0"].syncIssue, {
    kind: "needs-attention",
    message: "Native table of contents could not be matched",
  });
  assert.match(
    remoteWrites[0].requestBody.requests.find((request) => request.insertText)?.insertText.text,
    /Markdown sync status · Needs attention: Native table of contents could not be matched/,
  );

  await runSyncBatch({
    ...options,
    synchronize: async () => ({
      pairing,
      action: "none",
      state: {
        ...options.state.documents["0"],
        syncIssue: undefined,
      },
    }),
  });
  const recovered = await fs.readFile(pairing.absolutePath, "utf8");
  assert.match(recovered, /\*\u2194 Markdown sync status\*/);
  assert.doesNotMatch(recovered, /Needs attention/);
});

test("interrupted proposals produce no persistence or notifications and replay cleanly", async (t) => {
  const options = await batchFixture(t);
  let current = true;
  const committed = [];
  let calls = 0;
  const base = {
    ...options,
    isCurrent: () => current,
    persistState: async (state) => { committed.push(structuredClone(state)); },
    synchronize: async (_services, pairing) => {
      calls += 1;
      if (calls === 3) current = false;
      return { pairing, action: "none", state: { synced: true } };
    },
    errorReporter: { report: () => assert.fail("stale incident"), reconcile: () => assert.fail("stale recovery") },
  };
  await assert.rejects(runSyncBatch(base), { name: "SyncPassInterruptedError" });
  assert.deepEqual(committed, []);
  assert.deepEqual(options.state.documents, {});
  current = true;
  await runSyncBatch({ ...base, errorReporter: undefined });
  assert.equal(committed.length, 1);
  assert.equal(Object.keys(committed[0].documents).length, 3);
});

test("renames and remote deletion progress stay with the coordinator, after workers drain", async (t) => {
  const options = await batchFixture(t);
  const events = [];
  let active = 0;
  await runSyncBatch({
    ...options,
    synchronize: async (_services, pairing, _previous, { deferRemoteTitle }) => {
      if (!deferRemoteTitle) {
        assert.equal(active, 0);
        events.push(`rename:${pairing.documentId}`);
        return { pairing, action: "none", state: {} };
      }
      active += 1;
      await tick();
      active -= 1;
      return { pairing, action: pairing.documentId === "1" ? "coordinator-sync" : "remote-trash" };
    },
    archiveTrashed: async ({ pairing, state, persistState }) => {
      assert.equal(active, 0);
      events.push(`archive:${pairing.documentId}`);
      await persistState(state);
      return { recoveryDirectory: "/recovery" };
    },
    persistState: async () => { events.push("persist"); },
    retryNotifications: async () => { events.push("deletion-notifications"); },
  });
  assert.deepEqual(events, ["archive:0", "persist", "rename:1", "archive:2", "persist", "deletion-notifications", "persist"]);
});

test("whole passes are single-flight and duplicate pairing targets are coalesced", async (t) => {
  const options = await batchFixture(t, 1);
  let active = 0;
  let calls = 0;
  const run = () => runSyncPass({
    ...options, pairings: [options.pairings[0], options.pairings[0]],
    synchronize: async (_services, pairing) => {
      assert.equal(active++, 0);
      calls += 1;
      await tick();
      active -= 1;
      return { pairing, action: "none", state: {} };
    },
    persistState: async () => {},
  });
  const results = await Promise.all([run(), run()]);
  assert.equal(calls, 2);
  assert.deepEqual(results.map((result) => result.length), [1, 1]);
});

test("a later batch does not resync a pairing removed by an earlier deletion retry", async (t) => {
  const options = await batchFixture(t, 21);
  let current = options.pairings;
  const synced = [];
  await runSyncPass({
    ...options,
    reloadPairings: async () => current,
    synchronize: async (_services, pairing) => {
      synced.push(pairing.documentId);
      return { pairing, action: "none", state: {} };
    },
    retryNotifications: async () => { current = current.filter((pairing) => pairing.documentId !== "20"); },
    persistState: async () => {},
  });
  assert.equal(synced.length, 20);
  assert.equal(synced.includes("20"), false);
});
