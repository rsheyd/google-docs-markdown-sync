import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assetDirectoryPath,
  hashMarkdownWithAssets,
  materializeRemoteImages,
  prepareImagePush,
} from "../src/images.js";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("test-image"),
]);

function imageParagraph(startIndex, objectId) {
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

function imageDocument(ids) {
  return {
    inlineObjects: Object.fromEntries(ids.map((id) => [
      id,
      {
        inlineObjectProperties: {
          embeddedObject: {
            size: { width: { magnitude: 100, unit: "PT" } },
            imageProperties: { contentUri: `https://content.example/${id}` },
          },
        },
      },
    ])),
    body: {
      content: ids.map((id, index) => imageParagraph(1 + index * 2, id)),
    },
  };
}

test("derives a sibling asset directory from a Markdown path", () => {
  assert.equal(
    assetDirectoryPath("/workspace/notes/project.md"),
    "/workspace/notes/project.assets",
  );
});

test("downloads Docs image placeholders into content-addressed local assets", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gdocs-images-"));
  try {
    const pairing = { absolutePath: path.join(directory, "project.md") };
    const requested = [];
    const services = {
      auth: {
        request: async ({ url }) => {
          requested.push(url);
          return { data: PNG };
        },
      },
    };
    const markdown = "Before\n\n![][image1]\n\nAfter\n";
    const result = await materializeRemoteImages(
      services,
      pairing,
      imageDocument(["object-1"]),
      markdown,
    );
    assert.deepEqual(requested, ["https://content.example/object-1"]);
    assert.match(result, /^Before\n\n!\[\]\(project\.assets\/image-[a-f0-9]{12}\.png\)\n\nAfter\n$/);
    const [filename] = await fs.readdir(path.join(directory, "project.assets"));
    assert.match(filename, /^image-[a-f0-9]{12}\.png$/);
    assert.deepEqual(
      await fs.readFile(path.join(directory, "project.assets", filename)),
      PNG,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("refuses an ambiguous placeholder and inline-object count", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gdocs-images-"));
  try {
    await assert.rejects(
      materializeRemoteImages(
        { auth: { request: async () => ({ data: PNG }) } },
        { absolutePath: path.join(directory, "project.md") },
        imageDocument(["object-1", "object-2"]),
        "![][image1]\n",
      ),
      /found 2 inline objects but 1 Markdown placeholders/,
    );
    await assert.rejects(
      fs.access(path.join(directory, "project.assets")),
      /ENOENT/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("deduplicates identical image bytes across placeholders", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gdocs-images-"));
  try {
    const result = await materializeRemoteImages(
      { auth: { request: async () => ({ data: PNG }) } },
      { absolutePath: path.join(directory, "project.md") },
      imageDocument(["object-1", "object-2"]),
      "![][image1]\n\n![][image2]\n",
    );
    assert.equal((result.match(/project\.assets\/image-/g) ?? []).length, 2);
    assert.equal((await fs.readdir(path.join(directory, "project.assets"))).length, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("includes referenced local asset bytes in the local content hash", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gdocs-images-"));
  try {
    const markdownPath = path.join(directory, "project.md");
    const assetDirectory = path.join(directory, "project.assets");
    const assetPath = path.join(assetDirectory, "image.png");
    const markdown = "![Screenshot](project.assets/image.png)\n";
    await fs.mkdir(assetDirectory);
    await fs.writeFile(assetPath, PNG);
    const before = await hashMarkdownWithAssets(markdownPath, markdown);
    await fs.writeFile(assetPath, Buffer.concat([PNG, Buffer.from("changed")]));
    const after = await hashMarkdownWithAssets(markdownPath, markdown);
    assert.notEqual(after, before);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("rejects local image paths outside the managed asset directory", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gdocs-images-"));
  try {
    await assert.rejects(
      hashMarkdownWithAssets(
        path.join(directory, "project.md"),
        "![Outside](../outside.png)\n",
      ),
      /must stay inside project\.assets/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("compares remote bytes, hashes local assets, stages them, and cleans up", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gdocs-images-"));
  try {
    const markdownPath = path.join(directory, "project.md");
    const assetDirectory = path.join(directory, "project.assets");
    const assetPath = path.join(assetDirectory, "replacement.png");
    await fs.mkdir(assetDirectory);
    await fs.writeFile(assetPath, PNG);
    const staged = [];
    let cleaned = 0;
    const result = await prepareImagePush(
      {
        auth: { request: async () => ({ data: Buffer.concat([PNG, Buffer.from("old")]) }) },
      },
      markdownPath,
      "![Screenshot](project.assets/replacement.png)\n",
      imageDocument(["object-1"]),
      {
        stage: async ({ bytes, contentType }) => {
          staged.push({ bytes, contentType });
          return {
            url: "https://signed.example/replacement",
            cleanup: async () => { cleaned += 1; },
          };
        },
      },
    );
    assert.equal(result.currentImageHashes.has("object-1"), true);
    assert.equal(
      result.desiredImageHashes.has("project.assets/replacement.png"),
      true,
    );
    assert.equal(
      result.imageUris.get("project.assets/replacement.png"),
      "https://signed.example/replacement",
    );
    assert.equal(staged[0].contentType, "image/png");
    assert.deepEqual(staged[0].bytes, PNG);
    await result.cleanup();
    assert.equal(cleaned, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
