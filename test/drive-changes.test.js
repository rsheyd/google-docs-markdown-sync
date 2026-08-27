import test from "node:test";
import assert from "node:assert/strict";
import {
  getDriveStartPageToken,
  isInvalidDriveChangeToken,
  pairingsForDriveChanges,
  readDriveChanges,
  reconciliationDue,
  runDriveChangeCycle,
} from "../src/drive-changes.js";

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
