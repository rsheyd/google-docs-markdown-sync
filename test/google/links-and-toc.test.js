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

test("resolves a Markdown fragment to a Google Docs heading link", () => {
  const contents = [
    paragraph(1, "Purpose\n"),
    paragraph(9, "1. Purpose\n", "HEADING_2"),
  ];
  contents[1].paragraph.paragraphStyle.headingId = "heading-purpose";
  const document = { body: { content: contents } };
  const markdown =
    "[Purpose](#1.-purpose)\n\n## 1\\. Purpose {#1.-purpose}";

  assert.deepEqual(planHeadingLinkUpdate(document, markdown), [
    {
      updateTextStyle: {
        range: { startIndex: 1, endIndex: 8 },
        textStyle: { link: { headingId: "heading-purpose" } },
        fields: "link",
      },
    },
  ]);
});

test("normalizes an existing Google Docs heading link without churn", () => {
  const contents = [
    paragraph(1, "Purpose\n"),
    paragraph(9, "1. Purpose\n", "HEADING_2"),
  ];
  contents[0].paragraph.elements[0].textRun.textStyle.link = {
    headingId: "heading-purpose",
  };
  contents[1].paragraph.paragraphStyle.headingId = "heading-purpose";
  const document = { body: { content: contents } };
  const markdown =
    "[Purpose](#1.-purpose)\n\n## 1\\. Purpose {#1.-purpose}";

  assert.deepEqual(planIncrementalUpdate(document, markdown).requests, []);
  assert.deepEqual(planHeadingLinkUpdate(document, markdown), []);
});

test("flattens a native Google Docs table of contents like Markdown export", () => {
  const first = paragraph(1, "One\n");
  const second = paragraph(5, "Two\n");
  first.paragraph.elements[0].textRun.textStyle.link = {
    headingId: "heading-one",
  };
  second.paragraph.elements[0].textRun.textStyle.link = {
    headingId: "heading-two",
  };
  const headingOne = paragraph(20, "One\n", "HEADING_2");
  const headingTwo = paragraph(24, "Two\n", "HEADING_2");
  headingOne.paragraph.paragraphStyle.headingId = "heading-one";
  headingTwo.paragraph.paragraphStyle.headingId = "heading-two";
  const document = {
    body: {
      content: [
        {
          startIndex: 1,
          endIndex: 9,
          tableOfContents: { content: [first, second] },
        },
        headingOne,
        headingTwo,
      ],
    },
  };

  assert.deepEqual(
    blocksFromDocument(document).slice(0, 3).map((block) => ({
      text: block.text,
      link: block.styles[0]?.style.link,
      nativeTableOfContents: block.nativeTableOfContents,
    })),
    [
      { text: "One", link: "#one", nativeTableOfContents: true },
      { text: "", link: undefined, nativeTableOfContents: true },
      { text: "Two", link: "#two", nativeTableOfContents: true },
    ],
  );
  const cleanup = planSpacingCleanup(
    document,
    "[One](#one)\n\n[Two](#two)\n\n## One\n\n## Two",
  );
  assert.equal(
    cleanup.requests.every(
      (request) =>
        request.deleteContentRange.range.endIndex >
        request.deleteContentRange.range.startIndex,
    ),
    true,
  );
});

test("refuses to patch inside a native Google Docs table of contents", () => {
  const tocItem = paragraph(1, "One\n");
  tocItem.paragraph.elements[0].textRun.textStyle.link = {
    headingId: "heading-one",
  };
  const heading = paragraph(10, "One\n", "HEADING_2");
  heading.paragraph.paragraphStyle.headingId = "heading-one";
  const document = {
    body: {
      content: [
        {
          startIndex: 1,
          endIndex: 5,
          tableOfContents: { content: [tocItem] },
        },
        heading,
      ],
    },
  };

  assert.throws(
    () => planIncrementalUpdate(document, "[Changed](#one)\n\n## One"),
    /native Google Docs table of contents cannot be edited/,
  );
});

test("does not validate or rewrite native table-of-contents heading links", () => {
  const tocItem = paragraph(1, "Old heading\n");
  tocItem.paragraph.elements[0].textRun.textStyle.link = {
    headingId: "heading-old",
  };
  const heading = paragraph(20, "New heading\n", "HEADING_2");
  heading.paragraph.paragraphStyle.headingId = "heading-new";
  const document = {
    body: {
      content: [{
        startIndex: 1,
        endIndex: 13,
        tableOfContents: { content: [tocItem] },
      }, heading],
    },
  };

  assert.deepEqual(
    planHeadingLinkUpdate(
      document,
      "[Old heading](#old-heading)\n\n## New heading {#new-heading}",
    ),
    [],
  );
  assert.doesNotThrow(() =>
    planIncrementalUpdate(
      document,
      "[Old heading](#old-heading)\n\n## New heading {#new-heading}",
    ),
  );
});

test("rejects a fragment that does not match a Markdown heading", () => {
  const document = {
    body: { content: [paragraph(1, "Purpose\n")] },
  };
  assert.throws(
    () => planIncrementalUpdate(document, "[Purpose](#missing)"),
    /#missing does not match a heading/,
  );
});
