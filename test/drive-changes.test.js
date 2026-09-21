import test from "node:test";
import assert from "node:assert/strict";
import { createSingleFlight, SyncPassInterruptedError } from "../src/sync.js";
import {
  getDriveStartPageToken,
  isInvalidDriveChangeToken,
  pairingsForDriveChanges,
  readDriveChanges,
  reconciliationDue,
  runDriveChangeCycle,
  createReconciliationPriorityDrain,
} from "../src/drive-changes.js";

test("priority discovery is bounded, deduplicated, refreshes moved paths, and keeps its cursor transient", async () => {
  const pairings = Array.from({ length: 25 }, (_, i) => ({ documentId: String(i), absolutePath: `/old/${i}` }));
  const batches = [];
  const tokens = [];
  let first = true;
  const drain = createReconciliationPriorityDrain({
    services: {}, runExclusive: createSingleFlight(), assertCurrent() {},
    loadPairings: async () => pairings,
    isPendingMove: (pairing) => pairing.documentId === "0" && first,
    readChanges: async (_services, token) => {
      tokens.push(token);
      return { fileIds: first ? [...pairings.map((p) => p.documentId), "unpaired", "1"] : [], newStartPageToken: first ? "priority-1" : "priority-2" };
    },
    syncPairings: async (targets) => { batches.push(targets); },
  });
  await drain({ pageToken: "original" });
  first = false;
  pairings[0] = { ...pairings[0], absolutePath: "/moved/0" };
  pairings.pop(); // A previously queued target was unpaired between batches.
  await drain({ pageToken: "original" });
  assert.deepEqual(tokens, ["original", "priority-1"]);
  assert.deepEqual(batches.map((batch) => batch.length), [20, 4]);
  assert.equal(batches[1][0].absolutePath, "/moved/0");
  assert.ok(!batches.flat().some((pairing) => pairing.documentId === "24"));
});

for (const count of [100, 1_000, 10_000]) {
  test(`full reconciliation retains bounded batch size at ${count} pairings`, async () => {
    let largest = 0;
    let processed = 0;
    await runDriveChangeCycle({
      services: {}, pairings: Array.from({ length: count }, (_, i) => ({ documentId: String(i) })), state: {},
      getStartPageToken: async () => "cursor",
      syncPairings: async (targets) => {
        largest = Math.max(largest, targets.length);
        processed += targets.length;
        return targets.map((pairing) => ({ pairing, action: "none" }));
      },
      persistCursor: async () => { assert.equal(processed, count); },
    });
    assert.equal(largest, 20);
  });
}

test("reconciliation yields to queued local work at batch boundaries and saves the cursor last", async () => {
  const enqueue = createSingleFlight();
  const events = [];
  const pairings = Array.from({ length: 45 }, (_, i) => ({ documentId: String(i) }));
  let queuedLocal;
  await runDriveChangeCycle({
    services: {}, pairings, state: {}, runExclusive: enqueue,
    getStartPageToken: async () => "initial",
    syncPairings: async (targets) => {
      events.push(`sync:${targets[0].documentId}:${targets.length}`);
      if (!queuedLocal) queuedLocal = enqueue(async () => { events.push("local"); });
      events.push("batch-state-saved");
      return targets.map((pairing) => ({ pairing, action: "none" }));
    },
    betweenBatches: async ({ pageToken }) => {
      assert.equal(pageToken, "initial");
      await enqueue(async () => { events.push("priority-remote"); });
    },
    persistCursor: async () => { events.push("cursor"); },
  });
  await queuedLocal;
  assert.deepEqual(events, [
    "sync:0:20", "batch-state-saved", "local", "priority-remote",
    "sync:20:20", "batch-state-saved", "priority-remote",
    "sync:40:5", "batch-state-saved", "cursor",
  ]);
});

test("interruption retains committed batches but no completion cursor; restart replays safely", async () => {
  const pairings = Array.from({ length: 45 }, (_, i) => ({ documentId: String(i) }));
  const committed = new Set();
  let current = true;
  let cursor;
  let batches = 0;
  const options = {
    services: {}, pairings, state: {},
    getStartPageToken: async () => "start",
    assertCurrent: () => { if (!current) throw new SyncPassInterruptedError(); },
    syncPairings: async (targets) => {
      batches += 1;
      if (batches === 2) { current = false; throw new SyncPassInterruptedError(); }
      for (const pairing of targets) committed.add(pairing.documentId);
      return targets.map((pairing) => ({ pairing, action: "none" }));
    },
    persistCursor: async (token) => { cursor = token; },
  };
  await assert.rejects(runDriveChangeCycle(options), { name: "SyncPassInterruptedError" });
  assert.equal(committed.size, 20);
  assert.equal(cursor, undefined);
  current = true;
  await runDriveChangeCycle(options);
  assert.equal(committed.size, 45);
  assert.equal(cursor, "start");
});

test("reads paginated Drive changes and deduplicates file IDs", async () => {
  const requests = [];
  const pages = [
    {
      changes: [{ fileId: "doc-1" }, { fileId: "unpaired" }],
      nextPageToken: "page-2",
    },
    {
      changes: [{ fileId: "doc-1" }, { fileId: "sheet-1", removed: true }],
      newStartPageToken: "cursor-2",
    },
  ];
  const services = {
    drive: { changes: { list: async (request) => {
      requests.push(request);
      return { data: pages.shift() };
    } } },
  };
  const result = await readDriveChanges(services, "cursor-1");
  assert.deepEqual(result, {
    changeCount: 4,
    fileIds: ["doc-1", "unpaired", "sheet-1"],
    newStartPageToken: "cursor-2",
  });
  assert.deepEqual(requests.map((request) => request.pageToken), ["cursor-1", "page-2"]);
});

test("gets a start token and rejects a missing token", async () => {
  assert.equal(
    await getDriveStartPageToken({
      drive: { changes: { getStartPageToken: async () => ({ data: { startPageToken: "cursor" } }) } },
    }),
    "cursor",
  );
  await assert.rejects(
    getDriveStartPageToken({
      drive: { changes: { getStartPageToken: async () => ({ data: {} }) } },
    }),
    /did not return a start page token/,
  );
});

test("filters Drive changes to paired Docs and Sheets in registry order", () => {
  const pairings = [
    { documentId: "doc-1" },
    { type: "spreadsheet", spreadsheetId: "sheet-1" },
    { documentId: "doc-2" },
  ];
  assert.deepEqual(
    pairingsForDriveChanges(pairings, ["sheet-1", "unpaired", "doc-1"]),
    [pairings[0], pairings[1]],
  );
});

test("recognizes invalid Drive change cursors", () => {
  assert.equal(isInvalidDriveChangeToken({ response: { status: 410 } }), true);
  assert.equal(isInvalidDriveChangeToken({ code: 410 }), true);
  assert.equal(isInvalidDriveChangeToken({ response: { status: 500 } }), false);
});

test("schedules reconciliation when its timestamp is missing or one day old", () => {
  const now = Date.parse("2026-08-27T12:00:00.000Z");
  const day = 86_400_000;
  assert.equal(reconciliationDue({}, day, now), true);
  assert.equal(reconciliationDue({ remoteChanges: { lastReconciledAt: "2026-08-26T12:00:00.000Z" } }, day, now), true);
  assert.equal(reconciliationDue({ remoteChanges: { lastReconciledAt: "2026-08-27T11:59:00.000Z" } }, day, now), false);
});

test("initializes a cursor before reconciliation and persists it afterward", async () => {
  const events = [];
  const pairings = [{ documentId: "doc-1" }];
  const result = await runDriveChangeCycle({
    services: {},
    pairings,
    state: {},
    getStartPageToken: async () => {
      events.push("start-token");
      return "cursor-1";
    },
    syncPairings: async (targets) => {
      events.push(`sync:${targets.length}`);
      return [{ action: "unchanged" }];
    },
    persistCursor: async (token) => events.push(`persist:${token}`),
  });
  assert.deepEqual(events, ["start-token", "sync:1", "persist:cursor-1"]);
  assert.equal(result.initialized, true);
  assert.equal(result.cursorAdvanced, true);
});

test("initial reconciliation records its cursor despite isolated pairing errors", async () => {
  let persisted;
  const result = await runDriveChangeCycle({
    services: {},
    pairings: [{ documentId: "doc-1" }],
    state: {},
    getStartPageToken: async () => "cursor-1",
    syncPairings: async () => [{ action: "error" }],
    persistCursor: async (token) => { persisted = token; },
  });
  assert.equal(result.errorCount, 1);
  assert.equal(result.cursorAdvanced, true);
  assert.equal(persisted, "cursor-1");
});

test("retains the old cursor when a targeted sync fails so changes replay", async () => {
  let persistCount = 0;
  const options = {
    services: {},
    pairings: [{ documentId: "doc-1" }],
    state: { remoteChanges: { pageToken: "cursor-1" } },
    readChanges: async (_services, token) => {
      assert.equal(token, "cursor-1");
      return { changeCount: 1, fileIds: ["doc-1"], newStartPageToken: "cursor-2" };
    },
    syncPairings: async () => [{ action: "error" }],
    persistCursor: async () => { persistCount += 1; },
  };
  const first = await runDriveChangeCycle(options);
  const replay = await runDriveChangeCycle(options);
  assert.equal(first.cursorAdvanced, false);
  assert.equal(replay.targetCount, 1);
  assert.equal(persistCount, 0);
});

test("advances the cursor without syncing unpaired changes", async () => {
  let synced = false;
  let persisted;
  const result = await runDriveChangeCycle({
    services: {},
    pairings: [{ documentId: "doc-1" }],
    state: { remoteChanges: { pageToken: "cursor-1" } },
    readChanges: async () => ({ changeCount: 2, fileIds: ["other"], newStartPageToken: "cursor-2" }),
    syncPairings: async () => { synced = true; return []; },
    persistCursor: async (token) => { persisted = token; },
  });
  assert.equal(synced, false);
  assert.equal(persisted, "cursor-2");
  assert.equal(result.targetCount, 0);
});

test("invalid cursors acquire a new token and reconcile every pairing", async () => {
  const pairings = [{ documentId: "doc-1" }, { documentId: "doc-2" }];
  let targets;
  let persisted;
  const result = await runDriveChangeCycle({
    services: {},
    pairings,
    state: { remoteChanges: { pageToken: "expired" } },
    readChanges: async () => { throw { response: { status: 410 } }; },
    getStartPageToken: async () => "replacement",
    syncPairings: async (value) => { targets = value; return []; },
    persistCursor: async (token) => { persisted = token; },
  });
  assert.equal(result.reset, true);
  assert.deepEqual(targets, pairings);
  assert.equal(persisted, "replacement");
});

test("periodic reconciliation scans all pairings and records reconciliation completion", async () => {
  const pairings = [{ documentId: "doc-1" }, { documentId: "doc-2" }];
  let targets;
  let persisted;
  const result = await runDriveChangeCycle({
    services: {},
    pairings,
    state: { remoteChanges: { pageToken: "cursor-1" } },
    forceReconciliation: true,
    readChanges: async () => ({ changeCount: 1, fileIds: ["doc-1"], newStartPageToken: "cursor-2" }),
    syncPairings: async (value) => { targets = value; return [{ action: "none" }, { action: "error" }]; },
    persistCursor: async (token, metadata) => { persisted = { token, metadata }; },
  });
  assert.deepEqual(targets, pairings);
  assert.deepEqual(persisted, { token: "cursor-2", metadata: { reconciled: true } });
  assert.equal(result.reconciled, true);
  assert.equal(result.errorCount, 1);
});

for (const pairingCount of [100, 1_000, 10_000]) {
  test(`quiet polling remains one discovery request with ${pairingCount} inert pairings`, async () => {
    const pairings = Array.from({ length: pairingCount }, (_, index) => ({ documentId: `doc-${index}` }));
    let discoveryRequests = 0;
    let syncCalls = 0;
    const result = await runDriveChangeCycle({
      services: {},
      pairings,
      state: { remoteChanges: { pageToken: "cursor-1" } },
      readChanges: async () => {
        discoveryRequests += 1;
        return { changeCount: 0, fileIds: [], newStartPageToken: "cursor-2" };
      },
      syncPairings: async () => { syncCalls += 1; return []; },
      persistCursor: async () => {},
    });
    assert.equal(discoveryRequests, 1);
    assert.equal(syncCalls, 0);
    assert.equal(result.targetCount, 0);
  });
}

test("does not persist a cursor after a cycle is interrupted", async () => {
  let checks = 0;
  await assert.rejects(
    runDriveChangeCycle({
      services: {},
      pairings: [],
      state: { remoteChanges: { pageToken: "cursor-1" } },
      readChanges: async () => ({ changeCount: 0, fileIds: [], newStartPageToken: "cursor-2" }),
      syncPairings: async () => [],
      persistCursor: async () => assert.fail("cursor should not be persisted"),
      assertCurrent: () => {
        checks += 1;
        if (checks === 2) throw new Error("interrupted");
      },
    }),
    /interrupted/,
  );
});
