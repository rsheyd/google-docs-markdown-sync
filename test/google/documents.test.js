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

test("falls back to the Docs API when Drive Markdown export is too large", async () => {
  let documentReads = 0;
  const document = {
    body: { content: [paragraph(1, "Large document\n")] },
  };
  const services = {
    drive: {
      files: {
        export: async () => {
          throw {
            response: {
              data: {
                error: {
                  errors: [{ reason: "exportSizeLimitExceeded" }],
                },
              },
            },
          };
        },
      },
    },
    docs: {
      documents: {
        get: async () => {
          documentReads += 1;
          return { data: document };
        },
      },
    },
  };

  assert.equal(await exportMarkdown(services, "large-document"), "Large document\n");
  assert.equal(documentReads, 1);
  assert.equal(
    await exportMarkdown(services, "large-document", { document }),
    "Large document\n",
  );
  assert.equal(documentReads, 1);
});

test("does not hide unrelated Drive export errors", async () => {
  const denied = new Error("Access denied");
  const services = {
    drive: { files: { export: async () => { throw denied; } } },
    docs: { documents: { get: async () => assert.fail("unexpected Docs read") } },
  };
  await assert.rejects(exportMarkdown(services, "document"), denied);
});

test("uses Docs paragraph metadata to export a one-click indent as a blockquote", async () => {
  const quoted = paragraph(1, "Quoted paragraph\n");
  quoted.paragraph.paragraphStyle.indentStart = { magnitude: 36, unit: "PT" };
  quoted.paragraph.paragraphStyle.indentFirstLine = { magnitude: 36, unit: "PT" };
  const services = {
    drive: { files: { export: async () => ({ data: "Quoted paragraph\n" }) } },
    docs: { documents: { get: async () => ({
      data: { body: { content: [quoted] } },
    }) } },
  };
  assert.equal(await exportMarkdown(services, "document"), "> Quoted paragraph\n");
});

test("creates a Google Doc and populates it from Markdown", async () => {
  const calls = [];
  const progress = [];
  const document = {
    documentId: "new-document",
    revisionId: "revision-1",
    body: { content: [{ startIndex: 1, endIndex: 2, paragraph: { elements: [] } }] },
  };
  const services = {
    docs: {
      documents: {
        create: async (request) => {
          calls.push(["create", request]);
          return { data: { documentId: "new-document" } };
        },
        get: async () => ({ data: document }),
        batchUpdate: async (request) => {
          calls.push(["batchUpdate", request]);
          document.revisionId = "revision-2";
          document.body.content = [paragraph(1, "Hello\n")];
        },
      },
    },
    drive: {
      files: {
        get: async () => ({
          data: { id: "new-document", modifiedTime: "2026-08-03T12:00:00Z", name: "Example" },
        }),
      },
    },
  };

  const result = await createDocumentFromMarkdown(
    services,
    "Example",
    "Hello",
    { onProgress: (event) => progress.push(event) },
  );

  assert.equal(result.documentId, "new-document");
  assert.equal(result.documentUrl, "https://docs.google.com/document/d/new-document/edit");
  assert.equal(result.remote.revisionId, "revision-2");
  assert.deepEqual(calls[0], ["create", { requestBody: { title: "Example" } }]);
  assert.equal(calls[1][0], "batchUpdate");
  assert.deepEqual(progress, [{ type: "writing-content" }]);
});

test("does not structurally reconcile a rebuilt document without heading links", async () => {
  let documentReads = 0;
  const services = {
    docs: {
      documents: {
        get: async () => {
          documentReads += 1;
          return {
            data: {
              revisionId: `revision-${documentReads}`,
              body: {
                content: documentReads === 1
                  ? [paragraph(1, "Old\n")]
                  : [paragraph(1, "Google structural placeholder\n")],
              },
            },
          };
        },
        batchUpdate: async () => ({ data: {} }),
      },
    },
    drive: {
      files: {
        get: async () => ({
          data: { modifiedTime: "2026-08-03T12:00:00Z", name: "Example" },
        }),
      },
    },
  };

  await replaceDocumentFromMarkdown(services, "document", "");

  assert.equal(documentReads, 2);
});

test("batches a run of rebuilt text blocks into one Docs update", async () => {
  let documentReads = 0;
  const updates = [];
  const services = {
    docs: {
      documents: {
        get: async () => {
          documentReads += 1;
          return {
            data: {
              revisionId: `revision-${documentReads}`,
              body: { content: [paragraph(1, "\n")] },
            },
          };
        },
        batchUpdate: async (request) => {
          updates.push(request);
          return { data: {} };
        },
      },
    },
    drive: {
      files: {
        get: async () => ({
          data: { modifiedTime: "2026-08-03T12:00:00Z", name: "Example" },
        }),
      },
    },
  };
  const markdown = [
    "# Event options",
    "",
    ...Array.from({ length: 20 }, (_, index) => `- Option ${index + 1}`),
    "",
    "## Decision",
    "",
    "Choose one.",
  ].join("\n");

  await replaceDocumentFromMarkdown(services, "document", markdown);

  assert.equal(updates.length, 1);
  assert.equal(documentReads, 3);
  assert.match(updates[0].requestBody.requests[0].insertText.text, /Option 20/);
});

test("applies the request timeout to all Google services", () => {
  const services = createGoogleServices("test-auth", { timeout: 12_345 });
  assert.equal(services.docs.context._options.timeout, 12_345);
  assert.equal(services.drive.context._options.timeout, 12_345);
  assert.equal(services.sheets.context._options.timeout, 12_345);
});
