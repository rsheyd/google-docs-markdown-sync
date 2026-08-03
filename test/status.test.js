import test from "node:test";
import assert from "node:assert/strict";
import {
  DOC_STATUS_TITLE,
  documentStatusMarkdown,
  hasMarkdownStatus,
  hasRemoteDocumentStatus,
  remoteDocumentStatusMarkdown,
  spreadsheetStatusMarkdown,
  spreadsheetStatusValues,
  stripMarkdownStatus,
  stripRemoteDocumentStatus,
} from "../src/status.js";

const documentPairing = {
  documentId: "doc-id",
  documentUrl: "https://docs.google.com/document/d/doc-id/edit",
  markdownPath: "notes/example.md",
};
const state = {
  lastWriter: "markdown",
  lastSuccessfulSync: "2026-08-03T18:41:00.000Z",
};

test("adds a visible managed Markdown footer without changing canonical content", () => {
  const rendered = documentStatusMarkdown(documentPairing, {
    ...state,
    content: "# Example\n\nBody\n",
  });
  assert.equal(hasMarkdownStatus(rendered), true);
  assert.match(rendered, /Google Doc.*doc-id/);
  assert.match(rendered, /Markdown → Google Docs/);
  assert.equal(stripMarkdownStatus(rendered), "# Example\n\nBody\n");
});

test("replaces an edited managed Markdown footer as one unit", () => {
  const rendered = documentStatusMarkdown(documentPairing, {
    ...state,
    content: "Body\n\n<!-- google-docs-sync:status:start -->\nbroken",
  });
  assert.equal(rendered.match(/google-docs-sync:status:start/g).length, 1);
  assert.doesNotMatch(rendered, /broken/);
});

test("strips the visible Google Docs status section from native Markdown export", () => {
  const exported = `Body\n\n\\---  \n${DOC_STATUS_TITLE}  \nLast successful sync: Aug 3, 2026 · Google Docs → Markdown  \nLocal file: notes/example.md\n`;
  assert.equal(stripRemoteDocumentStatus(exported), "Body\n");
  assert.match(remoteDocumentStatusMarkdown(documentPairing, state), /Local file/);
});

test("removes a leaked remote footer before regenerating the managed local footer", () => {
  const leaked = `Body\n\n\\---  \n${DOC_STATUS_TITLE}  \nLast successful sync: old\n`;
  const rendered = documentStatusMarkdown(documentPairing, { ...state, content: leaked });
  assert.equal(rendered.match(/Markdown sync status/g).length, 1);
  assert.doesNotMatch(rendered, /sync: old/);
});

test("detects the managed status section in a Google Doc body", () => {
  const document = { body: { content: [{ paragraph: { elements: [
    { textRun: { content: `${DOC_STATUS_TITLE}\n` } },
  ] } }] } };
  assert.equal(hasRemoteDocumentStatus(document), true);
});

test("builds equivalent local and remote spreadsheet status views", () => {
  const pairing = {
    spreadsheetId: "sheet-id",
    spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-id/edit",
    directoryPath: "data/budget",
    name: "Budget",
  };
  assert.match(spreadsheetStatusMarkdown(pairing, { ...state, lastWriter: "csv" }), /CSV → Google Sheets/);
  assert.deepEqual(
    spreadsheetStatusValues(pairing, { ...state, lastWriter: "google-sheets" })[2],
    ["Direction", "Google Sheets → CSV"],
  );
});
