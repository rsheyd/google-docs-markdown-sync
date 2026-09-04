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
