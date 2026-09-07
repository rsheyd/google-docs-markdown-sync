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
    /Only standalone image paragraphs and one image per table cell can be changed/,
  );
});

test("refuses a full rebuild containing unstaged inline images before remote writes", async () => {
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
    /No staged image URL is available/,
  );
  assert.equal(writes, 0);
});

test("rebuilds text around a staged standalone image", async () => {
  const writes = [];
  const document = {
    revisionId: "revision-1",
    body: { content: [paragraph(1, "Old\n")] },
  };
  const services = {
    docs: { documents: {
      get: async () => ({ data: document }),
      batchUpdate: async (request) => { writes.push(request); },
    } },
    drive: { files: { get: async () => ({ data: {
      id: "document",
      modifiedTime: "2026-09-04T12:00:00Z",
      name: "Document",
    } }) } },
  };
  const source = "project.assets/screenshot.png";
  await replaceDocumentFromMarkdown(
    services,
    "document",
    `Before\n\n![Screenshot](${source})\n\nAfter`,
    {
      imageUris: new Map([[source, "https://signed.example/screenshot"]]),
      imageSizes: new Map([[source, {
        width: { magnitude: 320, unit: "PT" },
        height: { magnitude: 180, unit: "PT" },
      }]]),
    },
  );

  assert.deepEqual(writes[0].requestBody.requests, [
    { deleteContentRange: { range: { startIndex: 1, endIndex: 4 } } },
  ]);
  const imageRequest = writes
    .flatMap((write) => write.requestBody.requests)
    .find((request) => request.insertInlineImage);
  assert.deepEqual(imageRequest, {
    insertInlineImage: {
      location: { index: 4 },
      uri: "https://signed.example/screenshot",
      objectSize: {
        width: { magnitude: 320, unit: "PT" },
        height: { magnitude: 180, unit: "PT" },
      },
    },
  });
});

test("rebuilds a table cell containing one staged image at its text offset", async () => {
  const writes = [];
  let reads = 0;
  const tableDocument = () => ({
    revisionId: `revision-${reads}`,
    body: { content: [{
      startIndex: 1,
      endIndex: 30,
      table: {
        columns: 2,
        tableRows: [
          { tableCells: [{ startIndex: 2, content: [] }, { startIndex: 8, content: [] }] },
          { tableCells: [{ startIndex: 14, content: [] }, { startIndex: 20, content: [] }] },
        ],
      },
    }] },
  });
  const services = {
    docs: { documents: {
      get: async () => {
        reads += 1;
        return { data: reads === 1
          ? { revisionId: "revision-1", body: { content: [paragraph(1, "Old\n")] } }
          : tableDocument() };
      },
      batchUpdate: async (request) => { writes.push(request); },
    } },
    drive: { files: { get: async () => ({ data: {
      id: "document",
      modifiedTime: "2026-09-07T12:00:00Z",
      name: "Document",
    } }) } },
  };
  const source = "project.assets/logo.png";

  await replaceDocumentFromMarkdown(
    services,
    "document",
    `| Rank | Team |\n| --- | --- |\n| 1 | ![logo](${source}) Winners |`,
    { imageUris: new Map([[source, "https://signed.example/logo"]]) },
  );

  const imageRequest = writes
    .flatMap((write) => write.requestBody.requests)
    .find((request) => request.insertInlineImage);
  assert.deepEqual(imageRequest, {
    insertInlineImage: {
      location: { index: 21 },
      uri: "https://signed.example/logo",
    },
  });
  assert.equal(
    writes.flatMap((write) => write.requestBody.requests)
      .some((request) => request.insertText?.text.includes(INLINE_IMAGE_MARKER)),
    false,
  );
});

test("refuses more than one image in a rebuilt table cell before writing", async () => {
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
      "| Team |\n| --- |\n| ![](a.png) ![](b.png) |",
      { imageUris: new Map([
        ["a.png", "https://signed.example/a"],
        ["b.png", "https://signed.example/b"],
      ]) },
    ),
    /one image per table cell/,
  );
  assert.equal(writes, 0);
});
