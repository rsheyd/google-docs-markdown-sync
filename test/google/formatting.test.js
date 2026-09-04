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

test("finds a focused paragraph replacement", () => {
  const current = [
    { type: "text", paragraphStyle: "NORMAL_TEXT", text: "One", styles: [] },
    { type: "text", paragraphStyle: "NORMAL_TEXT", text: "Old", styles: [] },
    { type: "text", paragraphStyle: "NORMAL_TEXT", text: "Three", styles: [] },
  ];
  const desired = [
    { type: "text", paragraphStyle: "NORMAL_TEXT", text: "One", styles: [] },
    { type: "text", paragraphStyle: "NORMAL_TEXT", text: "New", styles: [] },
    { type: "text", paragraphStyle: "NORMAL_TEXT", text: "Three", styles: [] },
  ];
  assert.deepEqual(diffBlockHunks(current, desired), [
    { currentStart: 1, currentEnd: 2, desiredStart: 1, desiredEnd: 2 },
  ]);
});

test("plans one atomic incremental batch without Markdown separator paragraphs", () => {
  const document = {
    revisionId: "revision-1",
    body: {
      content: [
        paragraph(1, "Hello\n"),
        paragraph(7, "World\n"),
      ],
    },
  };
  const plan = planIncrementalUpdate(document, "Hello\n\nChanged");
  assert.equal(plan.mode, "incremental");
  assert.equal(plan.hunks.length, 1);
  assert.deepEqual(plan.requests[0], {
    deleteContentRange: { range: { startIndex: 7, endIndex: 12 } },
  });
  assert.equal(plan.requests[1].insertText.text, "Changed\n");
});

test("adds visual spacing after Markdown paragraphs but not hard breaks", () => {
  const firstLine = paragraph(1, "First line\n");
  const continuation = paragraph(firstLine.endIndex, "continuation\n");
  const second = paragraph(continuation.endIndex, "Second paragraph\n");
  const document = { body: { content: [firstLine, continuation, second] } };

  const requests = planParagraphSpacingUpdate(
    document,
    "First line  \ncontinuation\n\nSecond paragraph",
  );

  assert.deepEqual(
    requests.map((request) => request.updateParagraphStyle),
    [continuation].map((item) => ({
      range: { startIndex: item.startIndex, endIndex: item.endIndex },
      paragraphStyle: { spaceBelow: { magnitude: 8, unit: "PT" } },
      fields: "spaceBelow",
    })),
  );
});

test("indents Markdown blockquotes without decorative formatting", () => {
  const quoted = paragraph(1, "Quoted paragraph\n");
  const requests = planParagraphSpacingUpdate(
    { body: { content: [quoted] } },
    "> Quoted paragraph",
  );
  assert.deepEqual(requests.map((request) => request.updateParagraphStyle), [{
    range: { startIndex: quoted.startIndex, endIndex: quoted.endIndex },
    paragraphStyle: {
      indentStart: { magnitude: 36, unit: "PT" },
      indentFirstLine: { magnitude: 36, unit: "PT" },
    },
    fields: "indentStart,indentFirstLine",
  }]);
});

test("clears both indents when normalizing a blockquote back to ordinary text", () => {
  const paragraphWithFirstLineArtifact = paragraph(1, "Ordinary paragraph\n");
  paragraphWithFirstLineArtifact.paragraph.paragraphStyle.indentFirstLine = {
    magnitude: 36,
    unit: "PT",
  };
  const requests = planParagraphSpacingUpdate(
    { body: { content: [paragraphWithFirstLineArtifact] } },
    "Ordinary paragraph",
  );
  assert.deepEqual(requests.map((request) => request.updateParagraphStyle), [{
    range: {
      startIndex: paragraphWithFirstLineArtifact.startIndex,
      endIndex: paragraphWithFirstLineArtifact.endIndex,
    },
    paragraphStyle: { indentFirstLine: { magnitude: 0, unit: "PT" } },
    fields: "indentFirstLine",
  }]);
});

test("adds visual spacing between a heading and following list", () => {
  const heading = paragraph(1, "Planning\n", "HEADING_3");
  const item = bulletParagraph(heading.endIndex, "First\n");
  const document = {
    lists: {
      bullets: {
        listProperties: {
          nestingLevels: [{ glyphSymbol: "●", glyphFormat: "%0" }],
        },
      },
    },
    body: { content: [heading, item] },
  };
  const requests = planParagraphSpacingUpdate(
    document,
    "### Planning\n\n- First",
  );
  assert.deepEqual(requests.map((request) => request.updateParagraphStyle), [{
    range: { startIndex: heading.startIndex, endIndex: heading.endIndex },
    paragraphStyle: { spaceBelow: { magnitude: 8, unit: "PT" } },
    fields: "spaceBelow",
  }]);
});

test("normalizes an existing heading-styled list item to normal text", () => {
  const item = bulletParagraph(1, "AI-Assisted Development: Codex\n");
  item.paragraph.paragraphStyle.namedStyleType = "HEADING_2";
  item.paragraph.elements[0].textRun.textStyle = { bold: true };
  const document = {
    lists: {
      bullets: {
        listProperties: {
          nestingLevels: [{ glyphSymbol: "●", glyphFormat: "%0" }],
        },
      },
    },
    body: { content: [item] },
  };

  assert.deepEqual(
    planParagraphSpacingUpdate(
      document,
      "- **AI-Assisted Development: Codex**",
    ),
    [{
      updateParagraphStyle: {
        range: { startIndex: item.startIndex, endIndex: item.endIndex },
        paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
        fields: "namedStyleType",
      },
    }],
  );
});

test("clears paragraph spacing on an explicit Markdown blank line", () => {
  const first = paragraph(1, "First\n");
  first.paragraph.paragraphStyle.spaceBelow = { magnitude: 8, unit: "PT" };
  const blank = paragraph(first.endIndex, "\n");
  blank.paragraph.paragraphStyle.spaceBelow = { magnitude: 8, unit: "PT" };
  const second = paragraph(blank.endIndex, "Second\n");
  second.paragraph.paragraphStyle.spaceBelow = { magnitude: 8, unit: "PT" };
  const requests = planParagraphSpacingUpdate(
    { body: { content: [first, blank, second] } },
    "First\n\n\nSecond",
  );
  assert.deepEqual(
    requests.map((request) => request.updateParagraphStyle.range),
    [blank, second].map((item) => ({
      startIndex: item.startIndex,
      endIndex: item.endIndex,
    })),
  );
  assert.ok(requests.every(
    (request) => request.updateParagraphStyle.paragraphStyle.spaceBelow.magnitude === 0,
  ));
});

test("styles matching paragraphs while skipping API-only legacy blocks", () => {
  const extra = paragraph(1, "Legacy API-only block\n");
  const first = paragraph(extra.endIndex, "First\n");
  const second = paragraph(first.endIndex, "Second\n");
  const requests = planParagraphSpacingUpdate(
    { body: { content: [extra, first, second] } },
    "First\n\nSecond",
  );
  assert.deepEqual(
    requests.map((request) => request.updateParagraphStyle.range),
    [
      { startIndex: first.startIndex, endIndex: first.endIndex },
    ],
  );
});

test("reconciles paragraph spacing when Markdown content is unchanged", async () => {
  const document = {
    revisionId: "revision-1",
    body: { content: [paragraph(1, "Paragraph\n"), paragraph(11, "Second\n")] },
  };
  const updates = [];
  const services = {
    docs: { documents: {
      get: async () => ({ data: document }),
      batchUpdate: async (request) => updates.push(request),
    } },
    drive: { files: { get: async () => ({ data: {
      modifiedTime: "2026-08-11T12:00:00Z",
      name: "Example",
    } }) } },
  };

  await updateDocumentFromMarkdown(services, "document", "Paragraph\n\nSecond");

  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].requestBody.requests, [{
    updateParagraphStyle: {
      range: { startIndex: 1, endIndex: 11 },
      paragraphStyle: { spaceBelow: { magnitude: 8, unit: "PT" } },
      fields: "spaceBelow",
    },
  }]);
});

test("does not write an unchanged document", () => {
  const document = {
    body: { content: [paragraph(1, "Hello\n")] },
  };
  const plan = planIncrementalUpdate(document, "Hello");
  assert.equal(plan.mode, "incremental");
  assert.deepEqual(plan.requests, []);
});

test("repairs inline styles without replacing unchanged text", () => {
  const item = paragraph(1, "Quick links\n");
  const document = { body: { content: [item] } };
  assert.deepEqual(planInlineStyleUpdate(document, "**Quick links**"), [{
    updateTextStyle: {
      range: { startIndex: 1, endIndex: 12 },
      textStyle: {
        bold: true,
        italic: false,
        strikethrough: false,
        link: null,
      },
      fields: "bold,italic,strikethrough,link",
    },
  }]);
});

test("opens a new paragraph before appending to an existing bullet list", () => {
  const document = {
    lists: {
      bullets: {
        listProperties: {
          nestingLevels: [{ glyphSymbol: "●", glyphFormat: "%0" }],
        },
      },
    },
    body: {
      content: [
        bulletParagraph(1, "One\n"),
        bulletParagraph(5, "Two\n"),
      ],
    },
  };

  const plan = planIncrementalUpdate(document, "- One\n- Two\n- Three");
  const insertion = plan.requests.find((request) => request.insertText);
  const bullet = plan.requests.find((request) => request.createParagraphBullets);

  assert.equal(insertion.insertText.location.index, 8);
  assert.equal(insertion.insertText.text, "\nThree\n");
  assert.deepEqual(bullet.createParagraphBullets.range, {
    startIndex: 9,
    endIndex: 15,
  });
});

test("ignores the required extra Google Docs paragraph before a table", () => {
  const heading = paragraph(1, "Summary\n", "HEADING_2");
  const structuralSpacer = paragraph(heading.endIndex, "\n");
  const table = {
    startIndex: structuralSpacer.endIndex,
    endIndex: structuralSpacer.endIndex + 4,
    table: {
      tableRows: [{ tableCells: [{ content: [paragraph(1, "Cell\n")] }] }],
    },
  };
  const document = { body: { content: [heading, structuralSpacer, table] } };

  const plan = planIncrementalUpdate(document, "## Summary\n\n| Cell |\n| --- |");

  assert.deepEqual(plan.hunks, []);
  assert.deepEqual(plan.requests, []);
  assert.deepEqual(
    planHeadingLinkUpdate(document, "## Summary\n\n| Cell |\n| --- |"),
    [],
  );
});

test("spacing cleanup accepts only deletion of empty paragraphs", () => {
  const first = paragraph(1, "First\n");
  const blank = paragraph(first.endIndex, "\n");
  const second = paragraph(blank.endIndex, "Second\n");
  const document = { body: { content: [first, blank, second] } };

  const spacing = planSpacingCleanup(document, "First\n\nSecond");
  assert.equal(spacing.safe, true);
  assert.equal(spacing.emptyParagraphs, 1);
  assert.deepEqual(spacing.requests, [{
    deleteContentRange: {
      range: { startIndex: blank.startIndex, endIndex: blank.endIndex },
    },
  }]);

  const contentChange = planSpacingCleanup(document, "First\n\nChanged");
  assert.equal(contentChange.safe, true);
  assert.equal(contentChange.emptyParagraphs, 0);
  assert.deepEqual(contentChange.requests, []);
});
