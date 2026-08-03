import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  defaultDocumentTitle,
  applyLocalMove,
  applyRemoteTitle,
  documentIdFromUrl,
  spreadsheetIdFromUrl,
  markdownFilenameFromTitle,
  pairingLocalPath,
  validateManifest,
} from "../src/manifests.js";

test("extracts document IDs from standard and account-routed URLs", () => {
  assert.equal(
    documentIdFromUrl("https://docs.google.com/document/d/abc_123-XY/edit"),
    "abc_123-XY",
  );
  assert.equal(
    documentIdFromUrl(
      "https://docs.google.com/document/u/1/d/abc_123-XY/edit?tab=t.0",
    ),
    "abc_123-XY",
  );
});

test("derives a dated Google Doc title from a Markdown filename", () => {
  assert.equal(
    defaultDocumentTitle(
      "/notes/rockland-bergen-social-sandbox-event-options.md",
      new Date("2026-08-03T12:00:00Z"),
    ),
    "Rockland Bergen Social Sandbox Event Options - Aug 2026",
  );
});

test("extracts spreadsheet IDs and resolves spreadsheet directories", () => {
  assert.equal(
    spreadsheetIdFromUrl("https://docs.google.com/spreadsheets/d/sheet_123/edit#gid=0"),
    "sheet_123",
  );
  const [pairing] = validateManifest(
    {
      version: 1,
      pairings: [{
        type: "spreadsheet",
        spreadsheetId: "sheet_123",
        spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet_123/edit",
        directoryPath: "data/budget",
      }],
    },
    "/Users/roman/dev/example/google-docs-sync.json",
  );
  assert.equal(pairing.type, "spreadsheet");
  assert.equal(pairing.absolutePath, "/Users/roman/dev/example/data/budget");
});

test("reads local paths from mixed document and spreadsheet pairings", () => {
  const pairings = [
    { type: "spreadsheet", directoryPath: "data/budget" },
    { documentId: "abc", markdownPath: "notes/example.md" },
  ];
  assert.deepEqual(pairings.map(pairingLocalPath), [
    "data/budget",
    "notes/example.md",
  ]);
  assert.doesNotThrow(() =>
    pairings.sort((a, b) => pairingLocalPath(a).localeCompare(pairingLocalPath(b))),
  );
});

test("resolves portable manifest paths inside the workspace", () => {
  const manifestPath = "/Users/roman/dev/example/google-docs-sync.json";
  const [pairing] = validateManifest(
    {
      version: 1,
      pairings: [
        {
          documentId: "abc",
          documentUrl: "https://docs.google.com/document/d/abc/edit",
          markdownPath: "notes/example.md",
        },
      ],
    },
    manifestPath,
  );
  assert.equal(
    pairing.absolutePath,
    path.join("/Users/roman/dev/example", "notes/example.md"),
  );
});

test("rejects paths that escape a workspace", () => {
  assert.throws(() =>
    validateManifest(
      {
        version: 1,
        pairings: [{ documentId: "abc", markdownPath: "../outside.md" }],
      },
      "/Users/roman/dev/example/google-docs-sync.json",
    ),
  );
});

test("derives safe Markdown filenames from Google Doc titles", () => {
  assert.equal(markdownFilenameFromTitle("My New / Doc"), "my-new-doc.md");
  assert.equal(markdownFilenameFromTitle("  /  "), "google-doc.md");
});

test("renames Markdown and updates its pairing after a remote title change", async () => {
  const workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), "gdocs-sync-rename-"),
  );
  const manifestPath = path.join(workspace, "google-docs-sync.json");
  const oldPath = path.join(workspace, "notes", "old-title.md");
  await fs.mkdir(path.dirname(oldPath));
  await fs.writeFile(oldPath, "content\n");
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify({
      version: 1,
      pairings: [
        {
          documentId: "abc",
          markdownPath: "notes/old-title.md",
          name: "Old Title",
        },
      ],
    })}\n`,
  );

  try {
    const [pairing] = validateManifest(
      JSON.parse(await fs.readFile(manifestPath, "utf8")),
      manifestPath,
    );
    const updated = await applyRemoteTitle(pairing, "New Title");
    assert.equal(updated.markdownPath, "notes/new-title.md");
    assert.equal(await fs.readFile(updated.absolutePath, "utf8"), "content\n");
    await assert.rejects(fs.access(oldPath));
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    assert.equal(manifest.pairings[0].markdownPath, "notes/new-title.md");
    assert.equal(manifest.pairings[0].name, "New Title");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("adopts a paired Markdown file moved into a subfolder", async () => {
  const workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), "gdocs-sync-local-move-"),
  );
  const manifestPath = path.join(workspace, "google-docs-sync.json");
  const oldPath = path.join(workspace, "note.md");
  const newPath = path.join(workspace, "archive", "note.md");
  const manifest = {
    version: 1,
    pairings: [{ documentId: "abc", markdownPath: "note.md", name: "Note" }],
  };
  await fs.writeFile(oldPath, "content\n");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

  try {
    const identity = await fs.stat(oldPath);
    await fs.mkdir(path.dirname(newPath));
    await fs.rename(oldPath, newPath);
    const [pairing] = validateManifest(manifest, manifestPath);
    const updated = await applyLocalMove(pairing, identity);

    assert.equal(updated.markdownPath, path.join("archive", "note.md"));
    assert.equal(updated.absolutePath, newPath);
    const stored = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    assert.equal(stored.pairings[0].markdownPath, path.join("archive", "note.md"));
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("does not adopt a copied file with a different filesystem identity", async () => {
  const workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), "gdocs-sync-local-copy-"),
  );
  const manifestPath = path.join(workspace, "google-docs-sync.json");
  const oldPath = path.join(workspace, "note.md");
  const newPath = path.join(workspace, "archive", "note.md");
  const manifest = {
    version: 1,
    pairings: [{ documentId: "abc", markdownPath: "note.md" }],
  };
  await fs.writeFile(oldPath, "content\n");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

  try {
    const identity = await fs.stat(oldPath);
    await fs.mkdir(path.dirname(newPath));
    await fs.copyFile(oldPath, newPath);
    await fs.rm(oldPath);
    const [pairing] = validateManifest(manifest, manifestPath);
    const updated = await applyLocalMove(pairing, identity);

    assert.equal(updated.markdownPath, "note.md");
    const stored = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    assert.equal(stored.pairings[0].markdownPath, "note.md");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("refuses a title rename that would overwrite another file", async () => {
  const workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), "gdocs-sync-collision-"),
  );
  const manifestPath = path.join(workspace, "google-docs-sync.json");
  const oldPath = path.join(workspace, "old.md");
  const occupiedPath = path.join(workspace, "occupied.md");
  await fs.writeFile(oldPath, "original\n");
  await fs.writeFile(occupiedPath, "occupied\n");
  const manifest = {
    version: 1,
    pairings: [
      { documentId: "abc", markdownPath: "old.md", name: "Old" },
    ],
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

  try {
    const [pairing] = validateManifest(manifest, manifestPath);
    await assert.rejects(
      applyRemoteTitle(pairing, "Occupied"),
      /already exists/,
    );
    assert.equal(await fs.readFile(oldPath, "utf8"), "original\n");
    assert.equal(await fs.readFile(occupiedPath, "utf8"), "occupied\n");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("adopts the new title path when a missing local file must be pulled", async () => {
  const workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), "gdocs-sync-missing-"),
  );
  const manifestPath = path.join(workspace, "google-docs-sync.json");
  const manifest = {
    version: 1,
    pairings: [
      { documentId: "abc", markdownPath: "old.md", name: "Old" },
    ],
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

  try {
    const [pairing] = validateManifest(manifest, manifestPath);
    const updated = await applyRemoteTitle(pairing, "New");
    assert.equal(updated.markdownPath, "new.md");
    const stored = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    assert.equal(stored.pairings[0].markdownPath, "new.md");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("records a baseline title for legacy pairings without renaming", async () => {
  const workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), "gdocs-sync-legacy-"),
  );
  const manifestPath = path.join(workspace, "google-docs-sync.json");
  const customPath = path.join(workspace, "custom-name.md");
  const manifest = {
    version: 1,
    pairings: [{ documentId: "abc", markdownPath: "custom-name.md" }],
  };
  await fs.writeFile(customPath, "content\n");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

  try {
    const [pairing] = validateManifest(manifest, manifestPath);
    const updated = await applyRemoteTitle(pairing, "Current Title");
    assert.equal(updated.markdownPath, "custom-name.md");
    assert.equal(updated.name, "Current Title");
    assert.equal(await fs.readFile(customPath, "utf8"), "content\n");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
