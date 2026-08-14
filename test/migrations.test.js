import test from "node:test";
import assert from "node:assert/strict";
import {
  planPendingMigrations,
  runDocumentMigrations,
} from "../src/migrations.js";

function paragraph(startIndex, text, listId) {
  return {
    startIndex,
    endIndex: startIndex + text.length,
    paragraph: {
      elements: [{
        startIndex,
        endIndex: startIndex + text.length,
        textRun: { content: text, textStyle: {} },
      }],
      paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
      ...(listId ? { bullet: { listId, nestingLevel: 0 } } : {}),
    },
  };
}

function splitNumberedDocument(revisionId = "revision-1") {
  const first = paragraph(1, "First\n", "one");
  const second = paragraph(first.endIndex, "Second\n", "two");
  return {
    revisionId,
    lists: Object.fromEntries(["one", "two"].map((listId) => [listId, {
      listProperties: {
        nestingLevels: [{ glyphType: "DECIMAL", glyphFormat: "%0." }],
      },
    }])),
    body: { content: [first, second] },
  };
}

test("skips migrations already recorded for a document", () => {
  const plan = planPendingMigrations(
    splitNumberedDocument(),
    "1. First\n2. Second",
    {
      "0.3.2": "2026-08-14T12:00:00.000Z",
      "0.4.1": "2026-08-14T12:00:00.000Z",
    },
  );
  assert.deepEqual(plan, { versions: [], requests: [] });
});

test("dry-run plans every document without writes or state changes", async () => {
  let writes = 0;
  let saves = 0;
  const state = { version: 1, documents: {} };
  const results = await runDocumentMigrations({
    dryRun: true,
    pairings: [
      { type: "document", documentId: "doc", absolutePath: "/paired.md" },
      { type: "spreadsheet", spreadsheetId: "sheet", absolutePath: "/sheet" },
    ],
    state,
    readFile: async () => "1. First\n2. Second",
    persistState: async () => { saves += 1; },
    logger: { log() {}, error() {} },
    services: {
      docs: { documents: {
        get: async () => ({ data: splitNumberedDocument() }),
        batchUpdate: async () => { writes += 1; },
      } },
    },
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "planned");
  assert.equal(results[0].requests, 1);
  assert.equal(writes, 0);
  assert.equal(saves, 0);
  assert.deepEqual(state.documents, {});
});

test("migration isolates failures and records each successful document", async () => {
  const state = {
    version: 1,
    documents: {
      good: { localHash: "local", remoteRevisionId: "old" },
      bad: { localHash: "bad", remoteRevisionId: "old" },
    },
  };
  const saved = [];
  const writes = [];
  const migrated = new Set();
  const services = {
    docs: { documents: {
      get: async ({ documentId }) => ({
        data: splitNumberedDocument(
          `${documentId}-${migrated.has(documentId) ? "new" : "old"}`,
        ),
      }),
      batchUpdate: async ({ documentId }) => {
        writes.push(documentId);
        if (documentId === "bad") throw new Error("remote rejected write");
        migrated.add(documentId);
      },
    } },
    drive: { files: {
      get: async ({ fileId }) => ({ data: {
        id: fileId,
        name: fileId,
        modifiedTime: "2026-08-14T12:00:00.000Z",
        headRevisionId: `${fileId}-new`,
      } }),
    } },
  };
  const results = await runDocumentMigrations({
    pairings: ["good", "bad"].map((documentId) => ({
      type: "document",
      documentId,
      absolutePath: `/${documentId}.md`,
    })),
    services,
    state,
    readFile: async () => "1. First\n2. Second",
    persistState: async (next) => {
      saved.push(structuredClone(next));
    },
    logger: { log() {}, error() {} },
  });
  assert.deepEqual(results.map((result) => result.status), ["migrated", "error"]);
  assert.deepEqual(writes, ["good", "bad"]);
  assert.equal(saved.length, 1);
  assert.ok(state.documents.good.migrations["0.3.2"]);
  assert.ok(state.documents.good.migrations["0.4.1"]);
  assert.equal(state.documents.good.remoteRevisionId, "good-new");
  assert.equal(state.documents.bad.migrations, undefined);
});
