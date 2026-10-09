import test from "node:test";
import assert from "node:assert/strict";
import { splitHeader } from "../../src/headers.js";
import { parseMarkdown } from "../../src/markdown.js";
import { markdownFromDocument, planHeaderUpdate, updateDocumentFromMarkdown } from "../../src/google.js";
import { localImagePaths, materializeRemoteImages } from "../../src/images.js";
import { paragraph, imageParagraph } from "./fixtures.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const marked = (pages, text) => `<!-- gdms:header pages="${pages}" -->\n${text}\n<!-- gdms:header:end -->\n\nBody\n`;
const doc = () => ({ body: { content: [paragraph(1, "Body\n")] }, documentStyle: { defaultHeaderId: "h" }, headers: { h: { content: [paragraph(0, "Letterhead\n")] } } });

test("header parser separates body and rejects ambiguous blocks", () => {
  assert.equal(splitHeader(marked("first", "Logo")).header.pages, "first");
  assert.deepEqual(parseMarkdown(marked("all", "Logo")).map(b => b.text), ["Body"]);
  assert.throws(() => splitHeader(marked("bad", "Logo")), /pages/);
  assert.throws(() => splitHeader('<!-- gdms:header pages="all" -->'), /missing/);
  assert.throws(() => splitHeader('Body\n' + marked("all", "Logo")), /start/);
  assert.equal(splitHeader('```html\n<!-- gdms:header pages="all" -->\n```').header, null);
});

test("export maps a repeating or existing first-page header to the same-file block", () => {
  const d = doc();
  assert.equal(markdownFromDocument(d), marked("all", "Letterhead"));
  d.documentStyle = { firstPageHeaderId: "h", useFirstPageHeaderFooter: true };
  assert.equal(markdownFromDocument(d), marked("first", "Letterhead"));
});

test("header updates remain inside their segment and unchanged headers have no requests", () => {
  const d = doc();
  const same = splitHeader(marked("all", "Letterhead")).header;
  assert.equal(planHeaderUpdate(d, same).changed, false);
  const plan = planHeaderUpdate(d, splitHeader(marked("all", "New logo")).header);
  assert.ok(plan.requests.length);
  for (const request of plan.requests) {
    const operation = Object.values(request)[0];
    if (operation.range) assert.equal(operation.range.segmentId, "h");
    if (operation.location) assert.equal(operation.location.segmentId, "h");
  }
  assert.ok(planHeaderUpdate(d, null).requests.some(r => r.deleteContentRange));
});

test("missing first-page headers and unsupported layouts fail before mutation", async () => {
  const d = doc();
  let wrote = false;
  const services = { docs: { documents: { get: async () => ({ data: d }), batchUpdate: async () => { wrote = true; } } } };
  await assert.rejects(updateDocumentFromMarkdown(services, "d", marked("first", "Logo")), /Different first page/);
  assert.equal(wrote, false);
  d.headers.h.content = [{ table: {} }];
  assert.throws(() => markdownFromDocument(d), /paragraphs/);
});

test("header images participate in asset discovery and remote materialization before body images", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gdms-header-"));
  try {
    const file = path.join(directory, "terms.md");
    assert.deepEqual(localImagePaths(file, marked("all", "![](terms.assets/logo.png)")), [path.join(directory, "terms.assets/logo.png")]);
    const d = doc();
    d.headers.h.content = [imageParagraph(0, "header-image")];
    d.body.content = [imageParagraph(1, "body-image")];
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    d.inlineObjects = Object.fromEntries(["header-image", "body-image"].map(id => [id, { inlineObjectProperties: { embeddedObject: { imageProperties: { contentUri: "https://example.com/" + id } } } }]));
    const markdown = markdownFromDocument(d);
    assert.match(markdown, /\[image1\]/); assert.match(markdown, /\[image2\]/);
    const result = await materializeRemoteImages({ auth: { request: async () => ({ data: png }) } }, { absolutePath: file }, d, markdown);
    assert.match(result, /gdms:header pages="all"/); assert.equal((result.match(/terms.assets/g) ?? []).length, 2);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});


test("existing first-page headers can be updated and invalid image staging fails before creation", () => {
  const d = doc();
  d.documentStyle = { firstPageHeaderId: "h", useFirstPageHeaderFooter: true };
  assert.ok(planHeaderUpdate(d, splitHeader(marked("first", "Updated")).header).requests.every(request => !request.createHeader));
  const blank = { body: { content: [paragraph(1, "Body\n")] }, documentStyle: {} };
  assert.throws(() => planHeaderUpdate(blank, splitHeader(marked("all", "![](terms.assets/logo.png)")).header), /staged image/);
});
