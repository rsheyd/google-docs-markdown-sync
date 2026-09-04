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

test("serializes Docs API headings, styles, lists, tables, and image references", () => {
  const heading = paragraph(1, "Heading\n", "HEADING_2");
  const styled = paragraph(heading.endIndex, "Bold link\n");
  styled.paragraph.elements[0].textRun.textStyle = {
    bold: true,
    link: { url: "https://example.com/path" },
  };
  const item = bulletParagraph(styled.endIndex, "First\n");
  const image = imageParagraph(item.endIndex);
  const tableStart = image.endIndex;
  const document = {
    lists: {
      bullets: {
        listProperties: {
          nestingLevels: [{ glyphSymbol: "●" }],
        },
      },
    },
    inlineObjects: {
      "image-1": {
        inlineObjectProperties: {
          embeddedObject: { title: "Diagram" },
        },
      },
    },
    body: {
      content: [
        heading,
        styled,
        item,
        image,
        {
          startIndex: tableStart,
          endIndex: tableStart + 8,
          table: {
            tableStyle: {
              tableColumnProperties: [
                { widthType: "FIXED_WIDTH", width: { magnitude: 90, unit: "PT" } },
                { widthType: "FIXED_WIDTH", width: { magnitude: 270, unit: "PT" } },
              ],
            },
            tableRows: [{
              tableCells: [
                { content: [paragraph(tableStart + 1, "A\n")] },
                { content: [paragraph(tableStart + 3, "B\n")] },
              ],
            }],
          },
        },
      ],
    },
  };

  assert.equal(markdownFromDocument(document), [
    "## Heading",
    "",
    "[**Bold link**](https://example.com/path)",
    "",
    "- First",
    "",
    "![Diagram][image1]",
    "",
    "<!-- gdms:table-column-widths: 90pt, 270pt -->",
    "| A | B |",
    "| --- | --- |",
    "",
  ].join("\n"));
});

test("adds fixed table widths to native Drive Markdown export", async () => {
  const document = {
    body: {
      content: [{
        startIndex: 1,
        endIndex: 7,
        table: {
          tableStyle: {
            tableColumnProperties: [
              { widthType: "FIXED_WIDTH", width: { magnitude: 72, unit: "PT" } },
              { widthType: "FIXED_WIDTH", width: { magnitude: 216, unit: "PT" } },
            ],
          },
          tableRows: [{ tableCells: [
            { content: [paragraph(2, "A\n")] },
            { content: [paragraph(4, "B\n")] },
          ] }],
        },
      }],
    },
  };
  const services = {
    drive: { files: { export: async () => ({
      data: "```text\n| not a table |\n```\n\n| A | B |\n|---|---|\n",
    }) } },
    docs: { documents: { get: async () => ({ data: document }) } },
  };
  assert.equal(
    await exportMarkdown(services, "document"),
    "```text\n| not a table |\n```\n\n<!-- gdms:table-column-widths: 72pt, 216pt -->\n| A | B |\n|---|---|\n",
  );
});

test("serializes consecutive cell paragraphs as consecutive HTML breaks", async () => {
  const first = paragraph(2, "First paragraph.\n");
  const empty = paragraph(first.endIndex, "\n");
  const milestone = paragraph(empty.endIndex, "Milestone ready.\n");
  milestone.paragraph.elements[0].textRun.textStyle = { bold: true };
  const document = {
    body: {
      content: [{
        startIndex: 1,
        endIndex: milestone.endIndex + 1,
        table: {
          tableRows: [{ tableCells: [{ content: [first, empty, milestone] }] }],
        },
      }],
    },
  };
  assert.equal(markdownFromDocument(document), [
    "| First paragraph.<br><br>**Milestone ready.** |",
    "| --- |",
    "",
  ].join("\n"));
  const services = {
    drive: { files: { export: async () => ({ data: "| Flattened cell |\n| --- |\n" }) } },
    docs: { documents: { get: async () => ({ data: document }) } },
  };
  assert.equal(
    await exportMarkdown(services, "document"),
    "| First paragraph.<br><br>**Milestone ready.** |\n| --- |\n",
  );
});

test("normalizes Google Docs vertical-tab cell breaks to HTML breaks", async () => {
  const cellParagraph = paragraph(2, "First paragraph.\u000b\u000bMilestone ready.\n");
  const document = {
    body: {
      content: [{
        startIndex: 1,
        endIndex: cellParagraph.endIndex + 1,
        table: {
          tableRows: [{ tableCells: [{ content: [cellParagraph] }] }],
        },
      }],
    },
  };
  const services = {
    drive: { files: { export: async () => ({
      data: "| First paragraph.\u000b\u000bMilestone ready. |\n| --- |\n",
    }) } },
    docs: { documents: { get: async () => ({ data: document }) } },
  };
  assert.equal(
    await exportMarkdown(services, "document"),
    "| First paragraph.<br><br>Milestone ready. |\n| --- |\n",
  );
});

test("plans targeted fixed table column-width updates", () => {
  const document = {
    body: {
      content: [{
        startIndex: 1,
        endIndex: 7,
        table: {
          tableStyle: {
            tableColumnProperties: [
              { widthType: "FIXED_WIDTH", width: { magnitude: 100, unit: "PT" } },
              { widthType: "FIXED_WIDTH", width: { magnitude: 100, unit: "PT" } },
            ],
          },
          tableRows: [{ tableCells: [
            { content: [paragraph(2, "A\n")] },
            { content: [paragraph(4, "B\n")] },
          ] }],
        },
      }],
    },
  };
  const markdown = [
    "<!-- gdms:table-column-widths: 80pt,220pt -->",
    "| A | B |",
    "| --- | --- |",
  ].join("\n");
  assert.deepEqual(planIncrementalUpdate(document, markdown).hunks, []);
  assert.deepEqual(planTableColumnWidthUpdate(document, markdown), [
    {
      updateTableColumnProperties: {
        tableStartLocation: { index: 1 },
        columnIndices: [0],
        tableColumnProperties: {
          widthType: "FIXED_WIDTH",
          width: { magnitude: 80, unit: "PT" },
        },
        fields: "widthType,width",
      },
    },
    {
      updateTableColumnProperties: {
        tableStartLocation: { index: 1 },
        columnIndices: [1],
        tableColumnProperties: {
          widthType: "FIXED_WIDTH",
          width: { magnitude: 220, unit: "PT" },
        },
        fields: "widthType,width",
      },
    },
  ]);
});

test("applies width-only table edits without rebuilding content", async () => {
  const document = {
    revisionId: "revision-1",
    body: {
      content: [{
        startIndex: 1,
        endIndex: 7,
        table: {
          tableStyle: {
            tableColumnProperties: [
              { widthType: "FIXED_WIDTH", width: { magnitude: 100, unit: "PT" } },
              { widthType: "FIXED_WIDTH", width: { magnitude: 100, unit: "PT" } },
            ],
          },
          tableRows: [{ tableCells: [
            { content: [paragraph(2, "A\n")] },
            { content: [paragraph(4, "B\n")] },
          ] }],
        },
      }],
    },
  };
  const updates = [];
  const services = {
    docs: { documents: {
      get: async () => ({ data: document }),
      batchUpdate: async (request) => { updates.push(request); return { data: {} }; },
    } },
    drive: { files: { get: async () => ({
      data: { modifiedTime: "2026-08-28T12:00:00Z", name: "Widths", version: "2" },
    }) } },
  };
  await updateDocumentFromMarkdown(services, "document", [
    "<!-- gdms:table-column-widths: 80pt, 220pt -->",
    "| A | B |",
    "| --- | --- |",
  ].join("\n"));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].requestBody.requests.length, 2);
  assert.ok(updates[0].requestBody.requests.every(
    (request) => request.updateTableColumnProperties,
  ));
});
