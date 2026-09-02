import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  addSyncLocation,
  indexedManifestPaths,
  listSyncLocations,
  loadLocationRegistry,
  removeSyncLocation,
  scanSyncLocations,
  summarizeSyncLocations,
} from "../src/locations.js";

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gdms-locations-"));
  return {
    directory,
    options: {
      locationsPath: path.join(directory, "sync-locations.json"),
      indexPath: path.join(directory, "manifest-index.json"),
      legacyIndexPath: path.join(directory, "workspaces.json"),
      env: {},
    },
  };
}

async function writeManifest(manifestPath, documentId = "doc") {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify({
    version: 1,
    pairings: [{ documentId, markdownPath: `${documentId}.md` }],
  })}\n`);
}

test("fresh registry assumes no personal sync location", async () => {
  const { directory, options } = await fixture();
  try {
    const registry = await loadLocationRegistry(options);
    assert.deepEqual(registry.locations.locations, []);
    assert.deepEqual(registry.index.manifests, []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("migrates the legacy root and outside manifest without changing the old index", async () => {
  const { directory, options } = await fixture();
  const legacyRoot = path.join(directory, "dev");
  const projectManifest = path.join(legacyRoot, "project", "google-docs-sync.json");
  const archiveManifest = path.join(directory, "Roman", "google-docs-sync.json");
  await writeManifest(projectManifest, "project-doc");
  await writeManifest(archiveManifest, "archive-doc");
  const legacy = { version: 1, manifests: [projectManifest, archiveManifest] };
  await fs.writeFile(options.legacyIndexPath, `${JSON.stringify(legacy)}\n`);
  options.env = { GOOGLE_DOCS_SYNC_ROOT: legacyRoot };
  try {
    const registry = await loadLocationRegistry(options);
    assert.equal(registry.migrated, true);
    assert.deepEqual(registry.locations.locations.map((location) => location.path), [
      legacyRoot,
      path.dirname(archiveManifest),
    ]);
    assert.deepEqual(
      await indexedManifestPaths(options),
      [archiveManifest, projectManifest].sort((a, b) => a.localeCompare(b)),
    );
    assert.deepEqual(JSON.parse(await fs.readFile(options.legacyIndexPath, "utf8")), legacy);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("adds, scans, lists, and removes a sync location without deleting content", async () => {
  const { directory, options } = await fixture();
  const locationPath = path.join(directory, "Roman");
  const manifestPath = path.join(locationPath, "my health", "google-docs-sync.json");
  const skippedManifest = path.join(locationPath, "node_modules", "google-docs-sync.json");
  await writeManifest(manifestPath, "health-doc");
  await writeManifest(skippedManifest, "skip-doc");
  try {
    const added = await addSyncLocation(locationPath, options);
    assert.equal(added.added, true);
    assert.deepEqual(added.manifests.map((manifest) => manifest.path), [manifestPath]);
    assert.deepEqual((await listSyncLocations(options)).map((location) => location.path), [locationPath]);

    await writeManifest(path.join(locationPath, "notes", "google-docs-sync.json"), "notes-doc");
    const scanned = await scanSyncLocations(locationPath, options);
    assert.equal(scanned.manifests.length, 2);
    assert.deepEqual(await summarizeSyncLocations(options), [{
      ...added.location,
      manifestCount: 2,
      pairingCount: 2,
      unreadableManifests: 0,
    }]);

    const removed = await removeSyncLocation(locationPath, options);
    assert.equal(removed.pairingCount, 2);
    assert.deepEqual(await listSyncLocations(options), []);
    await fs.access(manifestPath);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("rebuilds a missing manifest index from configured locations", async () => {
  const { directory, options } = await fixture();
  const locationPath = path.join(directory, "archive");
  const manifestPath = path.join(locationPath, "google-docs-sync.json");
  await writeManifest(manifestPath);
  try {
    await addSyncLocation(locationPath, options);
    await fs.unlink(options.indexPath);
    const registry = await loadLocationRegistry(options);
    assert.equal(registry.rebuilt, true);
    assert.deepEqual(registry.index.manifests.map((manifest) => manifest.path), [manifestPath]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("preserves cached manifests when a configured location is temporarily unavailable", async () => {
  const { directory, options } = await fixture();
  const locationPath = path.join(directory, "cloud-archive");
  const unavailablePath = path.join(directory, "cloud-archive-offline");
  const manifestPath = path.join(locationPath, "google-docs-sync.json");
  await writeManifest(manifestPath);
  try {
    await addSyncLocation(locationPath, options);
    await fs.rename(locationPath, unavailablePath);
    const scanned = await scanSyncLocations(locationPath, options);
    assert.deepEqual(scanned.inaccessible, [locationPath]);
    const registry = await loadLocationRegistry(options);
    assert.deepEqual(registry.index.manifests.map((manifest) => manifest.path), [manifestPath]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("rejects an invalid authoritative location registry", async () => {
  const { directory, options } = await fixture();
  try {
    await fs.writeFile(options.locationsPath, '{"version":2,"locations":[]}\n');
    await assert.rejects(loadLocationRegistry(options), /must have version 1/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("serializes concurrent location additions and rejects overlaps", async () => {
  const { directory, options } = await fixture();
  const first = path.join(directory, "first");
  const second = path.join(directory, "second");
  await Promise.all([fs.mkdir(first), fs.mkdir(second)]);
  try {
    await Promise.all([
      addSyncLocation(first, options),
      addSyncLocation(second, options),
    ]);
    assert.deepEqual((await listSyncLocations(options)).map((location) => location.path), [first, second]);
    await fs.mkdir(path.join(first, "nested"));
    await assert.rejects(
      addSyncLocation(path.join(first, "nested"), options),
      /overlaps registered location/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
