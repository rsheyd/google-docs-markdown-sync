import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readJson, writeJsonAtomic } from "./files.js";
import {
  LEGACY_DEFAULT_DISCOVERY_ROOT,
  LEGACY_INDEX_PATH,
  MANIFEST_INDEX_PATH,
  MANIFEST_NAME,
  SYNC_LOCATIONS_PATH,
} from "./paths.js";

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".cache",
  ".next",
  "node_modules",
  "dist",
  "build",
  "vendor",
]);

class InvalidRegistryError extends Error {}

function registryPaths(options = {}) {
  return {
    locationsPath: options.locationsPath ?? SYNC_LOCATIONS_PATH,
    indexPath: options.indexPath ?? MANIFEST_INDEX_PATH,
    legacyIndexPath: options.legacyIndexPath ?? LEGACY_INDEX_PATH,
  };
}

function normalizeLocation(location) {
  return path.resolve(String(location));
}

function containsPath(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validateLocations(value, filePath) {
  if (value?.version !== 1 || !Array.isArray(value.locations)) {
    throw new InvalidRegistryError(`${filePath} must have version 1 and a locations array.`);
  }
  const ids = new Set();
  const paths = new Set();
  return {
    version: 1,
    locations: value.locations.map((location) => {
      if (!location?.id || !location?.path || typeof location.id !== "string" || typeof location.path !== "string") {
        throw new InvalidRegistryError(`${filePath} contains an invalid sync location.`);
      }
      const normalized = normalizeLocation(location.path);
      if (ids.has(location.id) || paths.has(normalized)) {
        throw new InvalidRegistryError(`${filePath} contains duplicate sync locations.`);
      }
      ids.add(location.id);
      paths.add(normalized);
      return { id: location.id, path: normalized };
    }),
  };
}

function validateIndex(value, filePath, locations) {
  if (value?.version !== 1 || !Array.isArray(value.manifests)) {
    throw new InvalidRegistryError(`${filePath} must have version 1 and a manifests array.`);
  }
  const locationIds = new Set(locations.map((location) => location.id));
  const paths = new Set();
  return {
    version: 1,
    manifests: value.manifests.map((manifest) => {
      if (!manifest?.locationId || !manifest?.path || !locationIds.has(manifest.locationId)) {
        throw new InvalidRegistryError(`${filePath} contains a manifest for an unknown sync location.`);
      }
      const normalized = path.resolve(manifest.path);
      if (paths.has(normalized)) throw new InvalidRegistryError(`${filePath} contains duplicate manifests.`);
      paths.add(normalized);
      return { locationId: manifest.locationId, path: normalized };
    }),
  };
}

function owningLocation(locations, manifestPath) {
  return locations
    .filter((location) => containsPath(location.path, manifestPath))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function withRegistryLock(locationsPath, operation) {
  const lockPath = `${locationsPath}.lock`;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  let handle;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 30_000) {
        await fs.unlink(lockPath).catch(() => undefined);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (!handle) throw new Error("Timed out waiting to update sync locations.");
  try {
    return await operation();
  } finally {
    await handle.close();
    await fs.unlink(lockPath).catch(() => undefined);
  }
}

async function walkForManifests(directory, results, inaccessible) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EACCES" || error.code === "EPERM") {
      inaccessible.push(directory);
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    if (entry.name === MANIFEST_NAME && entry.isFile()) {
      results.add(path.join(directory, entry.name));
    } else if (entry.isDirectory() && !entry.name.startsWith(".") && !SKIPPED_DIRECTORIES.has(entry.name)) {
      await walkForManifests(path.join(directory, entry.name), results, inaccessible);
    }
  }
}

async function scanLocations(locations) {
  const manifests = [];
  const inaccessible = [];
  const unavailableLocationIds = [];
  for (const location of locations) {
    const found = new Set();
    await walkForManifests(location.path, found, inaccessible);
    if (inaccessible.includes(location.path)) unavailableLocationIds.push(location.id);
    manifests.push(...[...found].sort().map((manifestPath) => ({
      locationId: location.id,
      path: manifestPath,
    })));
  }
  manifests.sort((a, b) => a.path.localeCompare(b.path));
  return { manifests, inaccessible, unavailableLocationIds };
}

async function migrateRegistry(paths, env) {
  const legacyExists = await pathExists(paths.legacyIndexPath);
  const legacy = legacyExists
    ? await readJson(paths.legacyIndexPath, { version: 1, manifests: [] })
    : { version: 1, manifests: [] };
  const candidatePaths = [];
  if (legacyExists) candidatePaths.push(normalizeLocation(env.GOOGLE_DOCS_SYNC_ROOT?.trim() || LEGACY_DEFAULT_DISCOVERY_ROOT));
  for (const manifestPath of legacy.manifests ?? []) {
    const normalizedManifest = path.resolve(manifestPath);
    if (!candidatePaths.some((location) => containsPath(location, normalizedManifest))) {
      candidatePaths.push(path.dirname(normalizedManifest));
    }
  }
  const locations = {
    version: 1,
    locations: candidatePaths.map((locationPath) => ({
      id: crypto.randomUUID(),
      path: locationPath,
    })),
  };
  const seenManifests = new Set();
  const manifests = (legacy.manifests ?? []).map((manifestPath) => {
    const normalized = path.resolve(manifestPath);
    if (seenManifests.has(normalized)) return null;
    seenManifests.add(normalized);
    const owner = owningLocation(locations.locations, normalized);
    return owner ? { locationId: owner.id, path: normalized } : null;
  }).filter(Boolean).sort((a, b) => a.path.localeCompare(b.path));
  const index = { version: 1, manifests };
  await writeJsonAtomic(paths.locationsPath, locations);
  await writeJsonAtomic(paths.indexPath, index);
  return { locations, index, migrated: legacyExists };
}

async function loadRegistryUnlocked(options = {}) {
  const paths = registryPaths(options);
  if (!(await pathExists(paths.locationsPath))) {
    return migrateRegistry(paths, options.env ?? process.env);
  }
  const locations = validateLocations(await readJson(paths.locationsPath), paths.locationsPath);
  let index;
  let rebuilt = false;
  try {
    index = validateIndex(await readJson(paths.indexPath), paths.indexPath, locations.locations);
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError) && !(error instanceof InvalidRegistryError)) throw error;
    const scanned = await scanLocations(locations.locations);
    index = { version: 1, manifests: scanned.manifests };
    await writeJsonAtomic(paths.indexPath, index);
    options.logger?.log(`manifest index rebuilt: ${index.manifests.length} manifest(s) across ${locations.locations.length} sync location(s).`);
    rebuilt = true;
  }
  return { locations, index, rebuilt };
}

export async function loadLocationRegistry(options = {}) {
  const paths = registryPaths(options);
  return withRegistryLock(paths.locationsPath, () => loadRegistryUnlocked(options));
}

export async function listSyncLocations(options = {}) {
  const registry = await loadLocationRegistry(options);
  return registry.locations.locations;
}

export async function summarizeSyncLocations(options = {}) {
  const registry = await loadLocationRegistry(options);
  const summaries = [];
  for (const location of registry.locations.locations) {
    const manifests = registry.index.manifests.filter((manifest) => manifest.locationId === location.id);
    let pairingCount = 0;
    let unreadableManifests = 0;
    for (const manifest of manifests) {
      try {
        const value = await readJson(manifest.path, { version: 1, pairings: [] });
        pairingCount += Array.isArray(value.pairings) ? value.pairings.length : 0;
      } catch {
        unreadableManifests += 1;
      }
    }
    summaries.push({ ...location, manifestCount: manifests.length, pairingCount, unreadableManifests });
  }
  return summaries;
}

export async function addSyncLocation(locationPath, options = {}) {
  const paths = registryPaths(options);
  const normalized = normalizeLocation(locationPath);
  const stat = await fs.stat(normalized).catch((error) => {
    if (error.code === "ENOENT") throw new Error(`Sync location does not exist: ${normalized}`);
    throw error;
  });
  if (!stat.isDirectory()) throw new Error(`Sync location is not a directory: ${normalized}`);
  return withRegistryLock(paths.locationsPath, async () => {
    const registry = await loadRegistryUnlocked(options);
    const existing = registry.locations.locations.find((location) => location.path === normalized);
    if (existing) return { location: existing, added: false, manifests: registry.index.manifests.filter((manifest) => manifest.locationId === existing.id), inaccessible: [] };
    const overlap = registry.locations.locations.find((location) => containsPath(location.path, normalized) || containsPath(normalized, location.path));
    if (overlap) throw new Error(`Sync location overlaps registered location: ${overlap.path}`);
    const location = { id: crypto.randomUUID(), path: normalized };
    const scanned = await scanLocations([location]);
    const locations = { version: 1, locations: [...registry.locations.locations, location] };
    const index = { version: 1, manifests: [...registry.index.manifests, ...scanned.manifests].sort((a, b) => a.path.localeCompare(b.path)) };
    await writeJsonAtomic(paths.locationsPath, locations);
    await writeJsonAtomic(paths.indexPath, index);
    return { location, added: true, manifests: scanned.manifests, inaccessible: scanned.inaccessible };
  });
}

export async function removeSyncLocation(locationPath, options = {}) {
  const paths = registryPaths(options);
  const normalized = normalizeLocation(locationPath);
  return withRegistryLock(paths.locationsPath, async () => {
    const registry = await loadRegistryUnlocked(options);
    const location = registry.locations.locations.find((candidate) => candidate.path === normalized);
    if (!location) throw new Error(`Sync location is not registered: ${normalized}`);
    const removedManifests = registry.index.manifests.filter((manifest) => manifest.locationId === location.id);
    let pairingCount = 0;
    let unreadableManifests = 0;
    for (const manifest of removedManifests) {
      try {
        const value = await readJson(manifest.path, { version: 1, pairings: [] });
        pairingCount += Array.isArray(value.pairings) ? value.pairings.length : 0;
      } catch {
        unreadableManifests += 1;
      }
    }
    await writeJsonAtomic(paths.locationsPath, { version: 1, locations: registry.locations.locations.filter((candidate) => candidate.id !== location.id) });
    await writeJsonAtomic(paths.indexPath, { version: 1, manifests: registry.index.manifests.filter((manifest) => manifest.locationId !== location.id) });
    return { location, manifests: removedManifests, pairingCount, unreadableManifests };
  });
}

export async function scanSyncLocations(locationPath, options = {}) {
  const paths = registryPaths(options);
  const normalized = locationPath ? normalizeLocation(locationPath) : undefined;
  return withRegistryLock(paths.locationsPath, async () => {
    const startedAt = Date.now();
    const registry = await loadRegistryUnlocked(options);
    const selected = normalized
      ? registry.locations.locations.filter((location) => location.path === normalized)
      : registry.locations.locations;
    if (normalized && !selected.length) throw new Error(`Sync location is not registered: ${normalized}`);
    const scanned = await scanLocations(selected);
    const replaceableIds = new Set(selected.filter((location) => !scanned.unavailableLocationIds.includes(location.id)).map((location) => location.id));
    const retained = registry.index.manifests.filter((manifest) => !replaceableIds.has(manifest.locationId));
    const index = { version: 1, manifests: [...retained, ...scanned.manifests].sort((a, b) => a.path.localeCompare(b.path)) };
    const discoveredPaths = new Set(scanned.manifests.map((manifest) => manifest.path));
    const staleCount = registry.index.manifests.filter((manifest) => replaceableIds.has(manifest.locationId) && !discoveredPaths.has(manifest.path)).length;
    await writeJsonAtomic(paths.indexPath, index);
    return { locations: selected, manifests: scanned.manifests, inaccessible: scanned.inaccessible, staleCount, elapsedMs: Date.now() - startedAt };
  });
}

export async function indexedManifestPaths(options = {}) {
  const paths = registryPaths(options);
  return withRegistryLock(paths.locationsPath, async () => {
    const registry = await loadRegistryUnlocked(options);
    const existing = [];
    const stale = [];
    for (const manifest of registry.index.manifests) {
      if (await pathExists(manifest.path)) existing.push(manifest);
      else stale.push(manifest);
    }
    if (stale.length) await writeJsonAtomic(paths.indexPath, { version: 1, manifests: existing });
    return existing.map((manifest) => manifest.path);
  });
}

export async function registerManifest(syncLocationPath, manifestPath, options = {}) {
  const paths = registryPaths(options);
  const normalizedLocation = normalizeLocation(syncLocationPath);
  const normalizedManifest = path.resolve(manifestPath);
  return withRegistryLock(paths.locationsPath, async () => {
    const registry = await loadRegistryUnlocked(options);
    let owner = owningLocation(registry.locations.locations, normalizedManifest);
    let locations = registry.locations;
    if (!owner) {
      const overlap = registry.locations.locations.find((location) => containsPath(location.path, normalizedLocation) || containsPath(normalizedLocation, location.path));
      if (overlap) throw new Error(`Sync location overlaps registered location: ${overlap.path}`);
      owner = { id: crypto.randomUUID(), path: normalizedLocation };
      locations = { version: 1, locations: [...locations.locations, owner] };
    }
    const manifests = registry.index.manifests.filter((manifest) => manifest.path !== normalizedManifest);
    manifests.push({ locationId: owner.id, path: normalizedManifest });
    manifests.sort((a, b) => a.path.localeCompare(b.path));
    await writeJsonAtomic(paths.locationsPath, locations);
    await writeJsonAtomic(paths.indexPath, { version: 1, manifests });
    return owner;
  });
}
