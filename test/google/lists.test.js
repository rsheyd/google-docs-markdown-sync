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
  planNativeCheckboxConversion,
  nativeCheckboxConversionRequests,
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

test("native conversion requires unambiguous exported tasks and preserves exported completion", async () => {
  const document = { revisionId: "r1", lists: { bullets: { listProperties: {
    nestingLevels: [{ glyphType: "GLYPH_TYPE_UNSPECIFIED" }],
  } } }, body: { content: [bulletParagraph(1, "Done\n")] } };
  assert.equal(planNativeCheckboxConversion(document, "- [x] Done\n")[1].insertText.text, "x] ");
  for (const markdown of ["- Done\n", "- [ ] Different\n", "- [ ] Done\n- Done\n", "```\n- [ ] Done\n```", "- [ ] Done\n\n  More text\n"]) {
    assert.deepEqual(planNativeCheckboxConversion(document, markdown), []);
  }
  const duplicate = structuredClone(document);
  duplicate.body.content.push(bulletParagraph(6, "Done\n"));
  assert.deepEqual(planNativeCheckboxConversion(duplicate, "- [ ] Done\n"), []);
  const services = { drive: { files: { export: async () => ({ data: Buffer.from("- [x] Done\n") }) } },
    docs: { documents: { get: async () => ({ data: { ...document, revisionId: "r2" } }) } } };
  await assert.rejects(nativeCheckboxConversionRequests(services, "doc", document), /changed during/);
  services.drive.files.export = async () => { throw { response: { data: { error: { message: "This file is too large to be exported." } } } }; };
  assert.deepEqual(await nativeCheckboxConversionRequests(services, "doc", document), []);
});

test("native conversion requires explicit candidate metadata and preserves text", () => {
  const document = { revisionId: "r1", lists: {
    native: { listProperties: { nestingLevels: [{ glyphType: "GLYPH_TYPE_UNSPECIFIED", glyphFormat: "%0" }] } },
    ordinary: { listProperties: { nestingLevels: [{ glyphType: "GLYPH_TYPE_UNSPECIFIED" }] } },
  }, body: { content: [bulletParagraph(1, "Task\n", "native"), bulletParagraph(6, "Plain\n", "ordinary"), bulletParagraph(12, "Unknown\n")] } };
  const requests = planNativeCheckboxConversion(document, "- [ ] Task\n- Plain\n- Unknown\n");
  assert.equal(blocksFromDocument(document)[0].ordered, false);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[1], { insertText: { location: { index: 1 }, text: "o] " } });
  assert.equal(requests[2].createParagraphBullets.bulletPreset, "BULLET_DISC_CIRCLE_SQUARE");
  assert.deepEqual(planNativeCheckboxConversion({ body: document.body }), []);
});

test("exports whole-item formatting outside task markers", async () => {
  const item = bulletParagraph(1, "x] Done\n");
  item.paragraph.elements[0].textRun.textStyle = { bold: true };
  const document = { body: { content: [item] } };
  assert.equal(markdownFromDocument(document), "- [x] **Done**\n");
  const services = { drive: { files: { export: async () => ({ data: Buffer.from("- **x] Done**\n") }) } } };
  assert.equal(await exportMarkdown(services, "doc", { document }), "- [x] **Done**\n");
});

test("task markers round-trip through both exports without repeated text updates", async () => {
  const document = { body: { content: [
    bulletParagraph(1, "o] Open\n"), bulletParagraph(9, "x] Done\n"),
  ] } };
  const expected = "- [ ] Open\n- [x] Done\n";
  assert.equal(markdownFromDocument(document), expected);
  const services = { drive: { files: { export: async () => ({
    data: Buffer.from("* o\\] Open\n* x\\] Done\n"),
  }) } } };
  assert.equal(await exportMarkdown(services, "doc", { document }), "* [ ] Open\n* [x] Done\n");
  const plan = planIncrementalUpdate(document, expected);
  assert.equal(plan.requests.some((r) => r.insertText || r.deleteContentRange), false);
  const toggle = planIncrementalUpdate(document, "- [x] Open\n- [x] Done\n");
  assert.ok(toggle.requests.some((r) => r.insertText?.text.includes("x] Open")));
});

test("distinguishes unordered Google Docs bullets from numbering", () => {
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
        {
          ...paragraph(1, "Bullet\n"),
          paragraph: {
            ...paragraph(1, "Bullet\n").paragraph,
            bullet: { listId: "bullets", nestingLevel: 0 },
          },
        },
      ],
    },
  };
  assert.equal(blocksFromDocument(document)[0].ordered, false);
  assert.equal(blocksFromDocument(document)[0].nestingLevel, 0);
});

test("plans nested list insertion without dropping child items", () => {
  const document = {
    revisionId: "revision-1",
    body: { content: [paragraph(1, "Before\n")] },
  };
  const plan = planIncrementalUpdate(
    document,
    "Before\n\n* parent\n  * child",
  );
  const insertion = plan.requests.find((request) => request.insertText);
  const bullets = plan.requests.filter((request) => request.createParagraphBullets);
  assert.equal(insertion.insertText.text, "\nparent\n\tchild\n");
  assert.equal(bullets.length, 1);
  assert.deepEqual(bullets[0].createParagraphBullets.range, {
    startIndex: 8,
    endIndex: 22,
  });
});

test("resets inserted list paragraphs to normal text before creating bullets", () => {
  const document = {
    revisionId: "revision-1",
    body: { content: [paragraph(1, "Role\n", "HEADING_3")] },
  };
  const plan = planIncrementalUpdate(document, "### Role\n\n- Responsibility");
  const bulletIndex = plan.requests.findIndex(
    (request) => request.createParagraphBullets,
  );
  const styleIndex = plan.requests.findIndex(
    (request) =>
      request.updateParagraphStyle?.fields === "namedStyleType" &&
      request.updateParagraphStyle.paragraphStyle.namedStyleType === "NORMAL_TEXT",
  );

  assert.ok(styleIndex >= 0);
  assert.ok(styleIndex < bulletIndex);
  assert.deepEqual(
    plan.requests[styleIndex].updateParagraphStyle.range,
    plan.requests[bulletIndex].createParagraphBullets.range,
  );
});

test("creates one bullet range so ordered list numbering continues", () => {
  const document = {
    revisionId: "revision-1",
    body: { content: [paragraph(1, "Before\n")] },
  };
  const plan = planIncrementalUpdate(
    document,
    "Before\n\n1. First\n2. Second\n3. Third",
  );
  const bullets = plan.requests.filter((request) => request.createParagraphBullets);
  assert.equal(bullets.length, 1);
  assert.deepEqual(bullets[0].createParagraphBullets, {
    range: { startIndex: 8, endIndex: 27 },
    bulletPreset: "NUMBERED_DECIMAL_NESTED",
  });
});

test("adds visual spacing after a list only when another block follows", () => {
  const first = bulletParagraph(1, "First\n", "numbered");
  const second = bulletParagraph(first.endIndex, "Second\n", "numbered");
  const after = paragraph(second.endIndex, "After\n");
  const document = {
    lists: {
      numbered: {
        listProperties: {
          nestingLevels: [{ glyphType: "DECIMAL", glyphFormat: "%0." }],
        },
      },
    },
    body: { content: [first, second, after] },
  };
  const requests = planParagraphSpacingUpdate(
    document,
    "1. First\n2. Second\n\nAfter",
  );
  assert.deepEqual(requests.map((request) => request.updateParagraphStyle), [{
    range: { startIndex: second.startIndex, endIndex: second.endIndex },
    paragraphStyle: { spaceBelow: { magnitude: 8, unit: "PT" } },
    fields: "spaceBelow",
  }]);
});

test("repairs an ordered run split across separate Google list IDs", () => {
  const first = bulletParagraph(1, "First\n", "one");
  const second = bulletParagraph(first.endIndex, "Second\n", "two");
  const document = {
    lists: Object.fromEntries(["one", "two"].map((listId) => [listId, {
      listProperties: {
        nestingLevels: [{ glyphType: "DECIMAL", glyphFormat: "%0." }],
      },
    }])),
    body: { content: [first, second] },
  };
  assert.deepEqual(
    planOrderedListNumberingUpdate(document, "1. First\n2. Second"),
    [{
      createParagraphBullets: {
        range: { startIndex: first.startIndex, endIndex: second.endIndex },
        bulletPreset: "NUMBERED_DECIMAL_NESTED",
      },
    }],
  );
  second.paragraph.bullet.listId = "one";
  assert.deepEqual(
    planOrderedListNumberingUpdate(document, "1. First\n2. Second"),
    [],
  );
});
