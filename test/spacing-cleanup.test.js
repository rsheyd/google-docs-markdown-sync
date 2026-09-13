import test from "node:test";
import assert from "node:assert/strict";
import { runSpacingCleanup } from "../src/spacing-cleanup.js";

function paragraph(startIndex, text) {
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
    },
  };
}

function documentWithExtraParagraph(revisionId) {
  const first = paragraph(1, "First\n");
  const blank = paragraph(first.endIndex, "\n");
  const second = paragraph(blank.endIndex, "Second\n");
  return { revisionId, body: { content: [first, blank, second] } };
}

test("cleans every document pairing, skips spreadsheets, and persists each success", async () => {
  const state = { version: 1, documents: {} };
  const writes = [];
  const saves = [];
  const documents = new Map([
    ["clean", documentWithExtraParagraph("clean-old")],
    ["current", {
      revisionId: "current-old",
      body: { content: [paragraph(1, "First\n"), paragraph(7, "Second\n")] },
    }],
  ]);
  const services = {
    docs: { documents: {
      get: async ({ documentId }) => ({ data: documents.get(documentId) }),
      batchUpdate: async ({ documentId, requestBody }) => {
        writes.push({ documentId, requestBody });
        documents.set(documentId, documentWithExtraParagraph(`${documentId}-new`));
      },
    } },
    drive: { files: { get: async ({ fileId }) => ({ data: {
      name: fileId,
      modifiedTime: "2026-09-13T12:00:00.000Z",
      version: `${fileId}-drive-new`,
    } }) } },
  };
  const progress = [];
  const results = await runSpacingCleanup({
    pairings: [
      { type: "document", documentId: "clean", absolutePath: "/clean.md" },
      { type: "spreadsheet", spreadsheetId: "sheet", absolutePath: "/sheet" },
      { type: "document", documentId: "current", absolutePath: "/current.md" },
    ],
    services,
    state,
    readFile: async () => "First\n\nSecond",
    persistState: async (next) => saves.push(structuredClone(next)),
    onProgress: (event) => progress.push(event),
  });

  assert.deepEqual(results.map((result) => result.status), ["cleaned", "current"]);
  assert.deepEqual(results.map((result) => result.emptyParagraphs), [1, 0]);
  assert.deepEqual(writes.map((write) => write.documentId), ["clean"]);
  assert.equal(saves.length, 2);
  assert.equal(state.documents.clean.remoteDriveRevisionId, "clean-drive-new");
  assert.equal(state.documents.current.remoteRevisionId, "current-old");
  assert.deepEqual(progress.map((event) => event.type), [
    "start", "complete", "start", "complete",
  ]);
});

test("isolates failures and rejects an unknown requested document", async () => {
  const state = { version: 1, documents: {} };
  const pairings = ["good", "bad"].map((documentId) => ({
    type: "document",
    documentId,
    absolutePath: `/${documentId}.md`,
  }));
  const services = {
    docs: { documents: {
      get: async ({ documentId }) => {
        if (documentId === "bad") throw new Error("permission denied");
        return { data: documentWithExtraParagraph("good-old") };
      },
      batchUpdate: async () => {},
    } },
    drive: { files: { get: async () => ({ data: {
      name: "good",
      modifiedTime: "2026-09-13T12:00:00.000Z",
      headRevisionId: "good-drive-new",
    } }) } },
  };
  const results = await runSpacingCleanup({
    pairings,
    services,
    state,
    readFile: async () => "First\n\nSecond",
    persistState: async () => {},
  });
  assert.deepEqual(results.map((result) => result.status), ["cleaned", "error"]);
  assert.match(results[1].error.message, /permission denied/);

  await assert.rejects(
    runSpacingCleanup({
      documentId: "missing",
      pairings,
      services,
      state,
    }),
    /No document pairing found/,
  );
});
