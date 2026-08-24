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
  planParagraphSpacingUpdate,
  planOrderedListNumberingUpdate,
  planSpacingCleanup,
  replaceDocumentFromMarkdown,
  updateDocumentStatus,
  updateDocumentFromMarkdown,
} from "../src/google.js";
import { INLINE_IMAGE_MARKER } from "../src/markdown.js";

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

function paragraph(startIndex, text, namedStyleType = "NORMAL_TEXT") {
  return {
    startIndex,
    endIndex: startIndex + text.length,
    paragraph: {
      elements: [
        {
          startIndex,
          endIndex: startIndex + text.length,
          textRun: { content: text, textStyle: {} },
        },
      ],
      paragraphStyle: { namedStyleType },
    },
  };
}

function bulletParagraph(startIndex, text, listId = "bullets") {
  const element = paragraph(startIndex, text);
  element.paragraph.bullet = { listId, nestingLevel: 0 };
  return element;
}

function imageParagraph(startIndex, objectId = "image-1") {
  return {
    startIndex,
    endIndex: startIndex + 2,
    paragraph: {
      elements: [
        {
          startIndex,
          endIndex: startIndex + 1,
          inlineObjectElement: { inlineObjectId: objectId },
        },
        {
          startIndex: startIndex + 1,
          endIndex: startIndex + 2,
          textRun: { content: "\n", textStyle: {} },
        },
      ],
      paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
    },
  };
}

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
    "| A | B |",
    "| --- | --- |",
    "",
  ].join("\n"));
});

test("extracts document paragraphs and ignores the terminal empty paragraph", () => {
  const document = {
    body: {
      content: [
        paragraph(1, "First\n"),
        paragraph(7, "\n"),
      ],
    },
  };
  assert.deepEqual(
    blocksFromDocument(document).map((block) => block.text),
    ["First"],
  );
});

test("extracts inline image identity and properties from Google Docs", () => {
  const document = {
    inlineObjects: {
      "image-1": {
        inlineObjectProperties: {
          embeddedObject: {
            title: "Login",
            description: "Login screen",
            size: {
              width: { magnitude: 320, unit: "PT" },
              height: { magnitude: 180, unit: "PT" },
            },
            imageProperties: {
              sourceUri: "https://example.com/login.png",
              contentUri: "https://temporary.example/image",
            },
          },
        },
      },
    },
    body: { content: [imageParagraph(1)] },
  };

  assert.deepEqual(blocksFromDocument(document)[0], {
    type: "text",
    paragraphStyle: "NORMAL_TEXT",
    text: INLINE_IMAGE_MARKER,
    styles: [],
    images: [
      {
        offset: 0,
        objectId: "image-1",
        title: "Login",
        description: "Login screen",
        size: {
          width: { magnitude: 320, unit: "PT" },
          height: { magnitude: 180, unit: "PT" },
        },
        sourceUri: "https://example.com/login.png",
        contentUri: "https://temporary.example/image",
      },
    ],
    startIndex: 1,
    endIndex: 3,
  });
});

test("preserves an unchanged inline image during an unrelated text edit", () => {
  const document = {
    inlineObjects: {
      "image-1": {
        inlineObjectProperties: { embeddedObject: { imageProperties: {} } },
      },
    },
    body: {
      content: [
        paragraph(1, "Old text\n"),
        imageParagraph(10),
      ],
    },
  };

  const plan = planIncrementalUpdate(
    document,
    "New text\n\n![Screenshot](https://example.com/screenshot.png)",
  );
  assert.equal(plan.hunks.length, 1);
  assert.deepEqual(plan.requests[0], {
    deleteContentRange: { range: { startIndex: 1, endIndex: 10 } },
  });
  assert.equal(
    plan.requests.some((request) =>
      request.deleteContentRange?.range.startIndex <= 10 &&
      request.deleteContentRange?.range.endIndex > 10),
    false,
  );
});

test("accepts a native Google Docs image placeholder for an unchanged image", () => {
  const document = {
    inlineObjects: {
      "image-1": {
        inlineObjectProperties: { embeddedObject: { imageProperties: {} } },
      },
    },
    body: { content: [imageParagraph(1)] },
  };
  const plan = planIncrementalUpdate(document, "![][image1]");
  assert.deepEqual(plan.requests, []);
});

test("refuses to change a paragraph containing an inline image", () => {
  const document = {
    inlineObjects: {
      "image-1": {
        inlineObjectProperties: { embeddedObject: { imageProperties: {} } },
      },
    },
    body: { content: [imageParagraph(1)] },
  };

  assert.throws(
    () => planIncrementalUpdate(
      document,
      "Caption ![Screenshot](project.assets/screenshot.png)",
    ),
    /Inline images cannot be added, removed, replaced, or edited/,
  );
});

test("refuses a local image source even when its structural position matches", () => {
  const document = {
    inlineObjects: {
      "image-1": {
        inlineObjectProperties: { embeddedObject: { imageProperties: {} } },
      },
    },
    body: { content: [imageParagraph(1)] },
  };

  assert.throws(
    () => planIncrementalUpdate(
      document,
      "![Screenshot](project.assets/replacement.png)",
    ),
    /Inline image sources cannot be changed from Markdown yet/,
  );
});

test("plans replacement of a standalone image with a staged URL", () => {
  const document = {
    inlineObjects: {
      "image-1": {
        inlineObjectProperties: {
          embeddedObject: {
            size: {
              width: { magnitude: 320, unit: "PT" },
              height: { magnitude: 180, unit: "PT" },
            },
            imageProperties: {},
          },
        },
      },
    },
    body: { content: [imageParagraph(1)] },
  };
  const source = "project.assets/replacement.png";
  const plan = planIncrementalUpdate(
    document,
    `![Screenshot](${source})`,
    {
      currentImageHashes: new Map([["image-1", "old-hash"]]),
      desiredImageHashes: new Map([[source, "new-hash"]]),
      imageUris: new Map([[source, "https://signed.example/replacement"]]),
    },
  );
  assert.deepEqual(plan.requests, [
    { deleteContentRange: { range: { startIndex: 1, endIndex: 2 } } },
    {
      insertInlineImage: {
        location: { index: 1 },
        uri: "https://signed.example/replacement",
        objectSize: {
          width: { magnitude: 320, unit: "PT" },
          height: { magnitude: 180, unit: "PT" },
        },
      },
    },
  ]);
});

test("plans insertion and deletion of standalone images", () => {
  const source = "project.assets/new.png";
  const emptyDocument = {
    body: { content: [paragraph(1, "\n")] },
  };
  const insertion = planIncrementalUpdate(
    emptyDocument,
    `![Screenshot](${source})`,
    {
      currentImageHashes: new Map(),
      desiredImageHashes: new Map([[source, "new-hash"]]),
      imageUris: new Map([[source, "https://signed.example/new"]]),
    },
  );
  assert.deepEqual(insertion.requests.slice(0, 2), [
    { insertText: { location: { index: 1 }, text: "\n" } },
    {
      insertInlineImage: {
        location: { index: 1 },
        uri: "https://signed.example/new",
      },
    },
  ]);

  const imageDocumentValue = {
    inlineObjects: {
      "image-1": {
        inlineObjectProperties: { embeddedObject: { imageProperties: {} } },
      },
    },
    body: { content: [imageParagraph(1)] },
  };
  const deletion = planIncrementalUpdate(imageDocumentValue, "", {
    currentImageHashes: new Map([["image-1", "old-hash"]]),
    desiredImageHashes: new Map(),
    imageUris: new Map(),
  });
  assert.deepEqual(deletion.requests, [
    { deleteContentRange: { range: { startIndex: 1, endIndex: 2 } } },
  ]);
});

test("refuses image changes mixed with paragraph text even when staged", () => {
  const document = {
    body: { content: [paragraph(1, "Before\n")] },
  };
  const source = "project.assets/new.png";
  assert.throws(
    () => planIncrementalUpdate(
      document,
      `Before ![Screenshot](${source})`,
      {
        currentImageHashes: new Map(),
        desiredImageHashes: new Map([[source, "hash"]]),
        imageUris: new Map([[source, "https://signed.example/new"]]),
      },
    ),
    /Only standalone image paragraphs can be changed/,
  );
});

test("refuses a full rebuild containing inline images before remote writes", async () => {
  let writes = 0;
  const services = {
    docs: { documents: {
      get: async () => ({ data: { body: { content: [paragraph(1, "Old\n")] } } }),
      batchUpdate: async () => { writes += 1; },
    } },
  };
  await assert.rejects(
    replaceDocumentFromMarkdown(
      services,
      "document",
      "![Screenshot](project.assets/screenshot.png)",
    ),
    /full document rebuild containing inline images is not supported/,
  );
  assert.equal(writes, 0);
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
