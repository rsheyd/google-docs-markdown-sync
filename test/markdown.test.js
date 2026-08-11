import test from "node:test";
import assert from "node:assert/strict";
import { INLINE_IMAGE_MARKER, parseMarkdown } from "../src/markdown.js";

test("parses headings and inline formatting", () => {
  const blocks = parseMarkdown(
    "# Heading\n\nA **bold**, *italic*, [linked](https://example.com) paragraph.",
  );
  assert.equal(blocks[0].paragraphStyle, "HEADING_1");
  assert.equal(blocks[0].text, "Heading");
  assert.equal(blocks[1].text, "A bold, italic, linked paragraph.");
  assert.deepEqual(
    blocks[1].styles.map((range) => range.style),
    [
      { bold: true },
      { italic: true },
      { link: "https://example.com" },
    ],
  );
});

test("parses ordered and unordered list items", () => {
  const blocks = parseMarkdown("- One\n- Two\n\n1. First\n2. Second");
  assert.deepEqual(
    blocks.map(({ type, ordered, nestingLevel, text }) => ({
      type,
      ordered,
      nestingLevel,
      text,
    })),
    [
      { type: "listItem", ordered: false, nestingLevel: 0, text: "One" },
      { type: "listItem", ordered: false, nestingLevel: 0, text: "Two" },
      { type: "listItem", ordered: true, nestingLevel: 0, text: "First" },
      { type: "listItem", ordered: true, nestingLevel: 0, text: "Second" },
    ],
  );
});

test("preserves links nested in heading-styled list items", () => {
  const blocks = parseMarkdown(
    "* ## [Purpose and priorities](#1-purpose)",
  );
  assert.deepEqual(blocks, [
    {
      type: "listItem",
      ordered: false,
      nestingLevel: 0,
      text: "Purpose and priorities",
      styles: [
        {
          start: 0,
          end: 22,
          style: { link: "#1-purpose" },
        },
      ],
    },
  ]);
});

test("preserves nested list items and their depth", () => {
  const blocks = parseMarkdown(
    "* arctiq linkedin job email\n  * found that the job no longer exists\n* next item",
  );
  assert.deepEqual(
    blocks.map(({ text, ordered, nestingLevel }) => ({ text, ordered, nestingLevel })),
    [
      { text: "arctiq linkedin job email", ordered: false, nestingLevel: 0 },
      { text: "found that the job no longer exists", ordered: false, nestingLevel: 1 },
      { text: "next item", ordered: false, nestingLevel: 0 },
    ],
  );
});

test("treats native Google Docs heading anchors as sync metadata", () => {
  const blocks = parseMarkdown("## 1\\. Purpose {#1.-purpose}");
  assert.deepEqual(blocks, [
    {
      type: "text",
      paragraphStyle: "HEADING_2",
      headingFragment: "#1.-purpose",
      text: "1. Purpose",
      styles: [],
    },
  ]);
});

test("uses one blank line as Markdown syntax and preserves only extras", () => {
  assert.deepEqual(
    parseMarkdown("First\n\nSecond").map((block) => block.text),
    ["First", "Second"],
  );
  const blocks = parseMarkdown("First\n\n\nSecond");
  assert.deepEqual(
    blocks.map((block) => block.text),
    ["First", "", "Second"],
  );
});

test("splits Markdown hard breaks into separate Google paragraph blocks", () => {
  const blocks = parseMarkdown("First  \nSecond");
  assert.deepEqual(
    blocks.map((block) => block.text),
    ["First", "Second"],
  );
});

test("parses a simple GFM table", () => {
  const blocks = parseMarkdown("| Name | Value |\n| --- | --- |\n| A | **B** |");
  assert.equal(blocks[0].type, "table");
  assert.equal(blocks[0].rows[1][1].text, "B");
  assert.deepEqual(blocks[0].rows[1][1].styles[0].style, { bold: true });
});

test("represents inline images structurally instead of flattening alt text", () => {
  const [block] = parseMarkdown(
    "Before ![Login screen](project.assets/login.png \"Current login\") after.",
  );
  assert.equal(block.text, `Before ${INLINE_IMAGE_MARKER} after.`);
  assert.deepEqual(block.images, [
    {
      offset: 7,
      url: "project.assets/login.png",
      alt: "Login screen",
      title: "Current login",
    },
  ]);
});

test("retains image offsets when splitting Markdown hard breaks", () => {
  const blocks = parseMarkdown(
    "First ![one](assets/one.png)  \nSecond ![two](assets/two.png)",
  );
  assert.deepEqual(
    blocks.map((block) => ({ text: block.text, images: block.images })),
    [
      {
        text: `First ${INLINE_IMAGE_MARKER}`,
        images: [{ offset: 6, url: "assets/one.png", alt: "one" }],
      },
      {
        text: `Second ${INLINE_IMAGE_MARKER}`,
        images: [{ offset: 7, url: "assets/two.png", alt: "two" }],
      },
    ],
  );
});

test("recognizes unresolved Google Docs image references as image placeholders", () => {
  const [block] = parseMarkdown("![][image1]");
  assert.equal(block.text, INLINE_IMAGE_MARKER);
  assert.deepEqual(block.images, [
    { offset: 0, alt: "", reference: "image1" },
  ]);
});
