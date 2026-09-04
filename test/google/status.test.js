import test from "node:test";
import assert from "node:assert/strict";
import {
  blocksFromDocument,
  createDocumentFromMarkdown,
  createGoogleServices,
  diffBlockHunks,
  exportMarkdown,
  markdownFromDocument,
  planHeadingLinkUpdate,
  planInlineStyleUpdate,
  planIncrementalUpdate,
  planOrderedListNumberingUpdate,
  planParagraphSpacingUpdate,
  planSpacingCleanup,
  planTableColumnWidthUpdate,
  replaceDocumentFromMarkdown,
  updateDocumentStatus,
  updateDocumentFromMarkdown,
} from "../../src/google.js";
import { INLINE_IMAGE_MARKER } from "../../src/markdown.js";
import { bulletParagraph, imageParagraph, paragraph } from "./fixtures.js";

test("replaces only the managed status suffix", async () => {
  const updates = [];
  const body = paragraph(1, "Body\n");
  const separator = paragraph(body.endIndex, "---\n");
  const title = paragraph(separator.endIndex, "↔ Markdown sync status\n");
  const timestamp = paragraph(title.endIndex, "Last successful sync: old\n");
  const document = {
    revisionId: "revision-1",
    body: { content: [body, separator, title, timestamp] },
  };
  const services = {
    docs: { documents: {
      get: async () => ({ data: document }),
      batchUpdate: async (request) => updates.push(request),
    } },
    drive: { files: { get: async () => ({ data: {
      modifiedTime: "2026-08-03T12:00:00Z",
      name: "Example",
    } }) } },
  };

  await updateDocumentStatus(
    services,
    "document",
    "---\n\n*↔ Markdown sync status*\n\n*Last successful sync: now*",
  );

  assert.deepEqual(updates[0].requestBody.requests[0], {
    deleteContentRange: {
      range: { startIndex: separator.startIndex, endIndex: timestamp.endIndex - 1 },
    },
  });
  assert.equal(
    updates[0].requestBody.requests[1].insertText.location.index,
    separator.startIndex,
  );
  assert.match(
    updates[0].requestBody.requests[1].insertText.text,
    /^\n\n---\n↔ Markdown sync status\n/,
  );
  const mutedStyle = updates[0].requestBody.requests.find(
    (request) => request.updateTextStyle?.fields === "foregroundColor",
  );
  assert.deepEqual(mutedStyle.updateTextStyle.textStyle, {
    foregroundColor: {
      color: { rgbColor: { red: 0.35, green: 0.35, blue: 0.35 } },
    },
  });
});
