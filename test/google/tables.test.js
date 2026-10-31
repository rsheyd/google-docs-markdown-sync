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

// Real Docs index layout: table + row boundaries + cell boundaries + paragraphs.
function editableTable(rows, startIndex = 10) {
  let index = startIndex + 1;
  const tableRows = rows.map((row) => {
    const rowStart = index++;
    const tableCells = row.map((text) => {
      const cellStart = index++;
      const content = [paragraph(index, `${text}\n`)];
      index = content[0].endIndex;
      return { startIndex: cellStart, endIndex: index, content };
    });
    return { startIndex: rowStart, endIndex: index, tableCells };
  });
  return { startIndex, endIndex: index + 1, table: { columns: rows[0].length, tableRows } };
}

function tableDocument(rows, { toc = false } = {}) {
  const table = editableTable(rows);
  const entry = paragraph(2, 'Index\n');
  const content = toc ? [{ startIndex: 1, endIndex: 9,
    tableOfContents: { content: [entry] } }] : [];
  return { revisionId: 'revision-1', body: { content: [
    ...content, table, paragraph(table.endIndex, 'After\n'),
  ] } };
}

function tableMarkdown(rows, toc = false) {
  return [toc ? 'Index' : '',
    `| ${rows[0].join(' | ')} |\n| ${rows[0].map(() => '---').join(' | ')} |`,
    ...rows.slice(1).map((row) => `| ${row.join(' | ')} |`), '', 'After',
  ].join('\n');
}

test('inserts a contiguous row group atomically while preserving a native TOC', () => {
  const rows = [['A', 'B'], ['C', 'D']];
  const document = tableDocument(rows, { toc: true });
  const before = structuredClone(document);
  const plan = planIncrementalUpdate(document,
    tableMarkdown([rows[0], ['New', '**Bold**'], ['Next', ''], rows[1]], true));
  assert.equal(plan.mode, 'incremental');
  assert.equal(plan.requests.filter((r) => r.insertTableRow).length, 2);
  const rowStart = document.body.content[1].table.tableRows[1].startIndex;
  assert.deepEqual(plan.requests.filter((r) => r.insertText).map((r) => r.insertText), [
    { location: { index: rowStart + 7 }, text: 'Next' },
    { location: { index: rowStart + 4 }, text: 'Bold' },
    { location: { index: rowStart + 2 }, text: 'New' },
  ]);
  assert.ok(plan.requests.every((r) => !r.deleteContentRange));
  assert.deepEqual(document, before);
});

test('inserts rows at the beginning and end without replacing the table', () => {
  for (const desired of [
    [['New', 'Row'], ['A', 'B']],
    [['A', 'B'], ['New', 'Row'], ['More', 'Rows']],
  ]) {
    const doc = tableDocument([['A', 'B']]);
    const plan = planIncrementalUpdate(doc, tableMarkdown(desired));
    const inserts = plan.requests.filter((r) => r.insertTableRow);
    assert.equal(inserts.length, desired.length - 1);
    assert.equal(inserts[0].insertTableRow.insertBelow, desired[0][0] === 'A');
    assert.ok(!plan.requests.some((r) => r.deleteContentRange));
  }
});

test('patches cell text and clears inherited emphasis and links before adding styles', () => {
  const doc = tableDocument([['A', 'B'], ['C', 'D']], { toc: true });
  const plan = planIncrementalUpdate(doc, tableMarkdown([['A', 'B'], ['Changed', '**Bold**']], true));
  assert.equal(plan.mode, 'incremental');
  assert.equal(plan.requests.filter((r) => r.deleteContentRange).length, 2);
  assert.equal(plan.requests.filter((r) => r.insertText).length, 2);
  assert.equal(plan.requests.filter((r) => r.updateTextStyle?.fields === 'bold,italic,strikethrough,link').length, 2);
  assert.ok(plan.requests.some((r) => r.updateTextStyle?.textStyle.bold));
  assert.deepEqual(planIncrementalUpdate(doc, tableMarkdown([['A', 'B'], ['C', 'D']], true)).requests, []);
});

test('orders cell updates and surrounding body edits by descending index', () => {
  const doc = tableDocument([['A', 'B']]);
  const md = tableMarkdown([['Changed', 'B']]).replace('After', 'Updated');
  const plan = planIncrementalUpdate(doc, md);
  const deletions = plan.requests.filter((r) => r.deleteContentRange).map((r) => r.deleteContentRange.range.startIndex);
  assert.equal(deletions.length, 2);
  assert.ok(deletions[0] > deletions[1]);
});

test('keeps unsupported structural and image-bearing table changes behind the TOC guard', () => {
  const rows = [['A', 'B'], ['C', 'D']];
  for (const desired of [
    [rows[0]], // deletion
    [['A', 'B', 'C'], ['C', 'D', 'E']], // columns
    [rows[0], ['New', 'Row'], ['Edited', 'D']], // simultaneous insertion and edit
    [rows[0], ['![image](asset.png)', 'D']],
  ]) {
    assert.throws(() => planIncrementalUpdate(tableDocument(rows, { toc: true }),
      tableMarkdown(desired, true), { imageUris: new Map([['asset.png', 'https://example.com/image.png']]) }),
    /full-rebuild table fallback/);
  }
  const doc = tableDocument(rows, { toc: true });
  doc.body.content[1].table.tableRows[1].tableCells[0].tableCellStyle = { columnSpan: 2 };
  assert.throws(() => planIncrementalUpdate(doc,
    tableMarkdown([rows[0], ['Changed', 'D']], true)), /full-rebuild table fallback/);
});

test('sends table row insertion and population in one revision-checked batch', async () => {
  const doc = tableDocument([['A', 'B']]);
  const updates = [];
  const services = {
    docs: { documents: {
      get: async () => ({ data: doc }),
      batchUpdate: async (request) => { updates.push(request); return { data: {} }; },
    } },
    drive: { files: { get: async () => ({ data: { modifiedTime: '2026-10-31T12:00:00Z', name: 'Table', version: '2' } }) } },
  };
  await updateDocumentFromMarkdown(services, 'document', tableMarkdown([['A', 'B'], ['New', 'Row']]));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].requestBody.writeControl.requiredRevisionId, 'revision-1');
  assert.ok(updates[0].requestBody.requests.some((r) => r.insertTableRow));
  assert.equal(updates[0].requestBody.requests.filter((r) => r.insertText).length, 2);
});

test('updates a table before inserting body text at the same boundary', () => {
  const doc = tableDocument([['A', 'B']]);
  const plan = planIncrementalUpdate(doc, 'Before\n\n' + tableMarkdown([['Changed', 'B']]).trimStart());
  const cellInsertion = plan.requests.findIndex((r) => r.insertText?.text === 'Changed');
  const bodyInsertion = plan.requests.findIndex((r) => r.insertText?.text.includes('Before'));
  assert.ok(cellInsertion >= 0 && bodyInsertion > cellInsertion);
});

test('does not continue to formatting or metadata writes after a revision rejection', async () => {
  const doc = tableDocument([['A', 'B']]);
  let batches = 0;
  const services = { docs: { documents: {
    get: async () => ({ data: doc }),
    batchUpdate: async (request) => {
      batches += 1;
      assert.equal(request.requestBody.writeControl.requiredRevisionId, 'revision-1');
      throw new Error('revision rejected');
    },
  } } };
  await assert.rejects(updateDocumentFromMarkdown(services, 'document',
    tableMarkdown([['A', 'B'], ['New', 'Row']])), /revision rejected/);
  assert.equal(batches, 1);
});
