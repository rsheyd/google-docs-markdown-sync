import fs from "node:fs/promises";
import path from "node:path";
import { readJson, writeJsonAtomic } from "./files.js";
import { indexedManifestPaths, registerManifest } from "./locations.js";
import { hasMarkdownStatus } from "./status.js";
import {
  relocateAssetDirectory,
  rollbackAssetRelocation,
} from "./images.js";
import { MANIFEST_NAME } from "./paths.js";

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".cache",
  "node_modules",
  "dist",
  "build",
  "vendor",
]);

export function pairingLocalPath(pairing) {
  return pairing.type === "spreadsheet"
    ? pairing.directoryPath
    : pairing.markdownPath;
}

function comparePairingLocalPaths(a, b) {
  return pairingLocalPath(a).localeCompare(pairingLocalPath(b));
}

export function documentIdFromUrl(url) {
  const match = String(url).match(
    /^https:\/\/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]+)/,
  );
  if (!match) throw new Error("The active URL is not a Google Docs document.");
  return match[1];
}

export function spreadsheetIdFromUrl(url) {
  const match = String(url).match(
    /^https:\/\/docs\.google\.com\/spreadsheets\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]+)/,
  );
  if (!match) throw new Error("The URL is not a Google Sheets spreadsheet.");
  return match[1];
}

export function validateManifest(manifest, manifestPath) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.pairings)) {
    throw new Error(`${manifestPath} must have version 1 and a pairings array.`);
  }
  const syncLocation = path.dirname(manifestPath);
  return manifest.pairings.map((pairing) => {
    const type = pairing.type ?? "document";
    const remoteId = type === "spreadsheet" ? pairing.spreadsheetId : pairing.documentId;
    const relativeLocalPath = type === "spreadsheet" ? pairing.directoryPath : pairing.markdownPath;
    if (!remoteId || !relativeLocalPath) {
      throw new Error(
        `${manifestPath} ${type} pairings require a remote ID and local path.`,
      );
    }
    if (!['document', 'spreadsheet'].includes(type)) {
      throw new Error(`${manifestPath} contains unsupported pairing type ${type}.`);
    }
    if (path.isAbsolute(relativeLocalPath)) {
      throw new Error(`${manifestPath} local paths must be relative.`);
    }
    const absolutePath = path.resolve(syncLocation, relativeLocalPath);
    if (
      absolutePath !== syncLocation &&
      !absolutePath.startsWith(`${syncLocation}${path.sep}`)
    ) {
      throw new Error(`${relativeLocalPath} escapes its sync location.`);
    }
    return { ...pairing, type, manifestPath, syncLocation, absolutePath };
  });
}

export async function removeDocumentPairing(pairing) {
  if (pairing.type === "spreadsheet") {
    throw new Error("Deletion propagation currently supports Markdown/Google Docs only.");
  }
  const manifest = await readJson(pairing.manifestPath);
  const nextPairings = manifest.pairings.filter(
    (item) => item.documentId !== pairing.documentId,
  );
  if (nextPairings.length === manifest.pairings.length) return false;
  await writeJsonAtomic(pairing.manifestPath, {
    ...manifest,
    pairings: nextPairings,
  });
  return true;
}

export async function loadPairings(options = {}) {
  const manifestPaths = await indexedManifestPaths(options);
  const pairings = [];
  for (const manifestPath of manifestPaths) {
    const manifest = await readJson(manifestPath);
    pairings.push(...validateManifest(manifest, manifestPath));
  }
  return pairings;
}

export function markdownFilenameFromTitle(title) {
  const slug = String(title)
    .trim()
    .toLowerCase()
    .replace(/\s+-\s+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[/:\\\u0000-\u001f]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug || "google-doc"}.md`;
}

export function defaultDocumentTitle(markdownPath, date = new Date()) {
  const stem = path.basename(markdownPath, path.extname(markdownPath));
  const name = stem
    .replace(/-+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\S+/g, (word) =>
      `${word.charAt(0).toLocaleUpperCase("en-US")}${word.slice(1)}`,
    );
  const monthAndYear = new Intl.DateTimeFormat("en-US", {
    month: "short",
    year: "numeric",
  }).format(date);
  return `${name} - ${monthAndYear}`;
}

async function pathsReferToSameFile(firstPath, secondPath) {
  try {
    const [first, second] = await Promise.all([
      fs.stat(firstPath),
      fs.stat(secondPath),
    ]);
    return first.dev === second.dev && first.ino === second.ino;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function managedFileBelongsToDocument(filePath, documentId) {
  const markdown = await fs.readFile(filePath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  return Boolean(
    markdown &&
      hasMarkdownStatus(markdown) &&
      markdown.includes(`docs.google.com/document/d/${documentId}/`),
  );
}

async function findPathsByIdentity(directory, identity, results = []) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EACCES") return results;
    throw error;
  }

  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      !entry.name.startsWith(".") &&
      !SKIPPED_DIRECTORIES.has(entry.name)
    ) {
      await findPathsByIdentity(path.join(directory, entry.name), identity, results);
    } else if (entry.isFile()) {
      const candidate = path.join(directory, entry.name);
      const stat = await fs.stat(candidate).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!stat) continue;
      if (stat.dev === identity.dev && stat.ino === identity.ino) {
        results.push(candidate);
      }
    }
  }
  return results;
}

export async function applyLocalMove(pairing, identity) {
  if (!identity?.dev || !identity?.ino) return pairing;

  const sourceExists = await fs
    .access(pairing.absolutePath)
    .then(() => true)
    .catch((error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
  if (sourceExists) return pairing;

  const matches = await findPathsByIdentity(pairing.syncLocation, identity);
  if (matches.length !== 1) return pairing;

  const nextAbsolutePath = matches[0];
  const nextRelativePath = path.relative(pairing.syncLocation, nextAbsolutePath);
  if (
    !nextRelativePath ||
    path.isAbsolute(nextRelativePath) ||
    nextRelativePath.startsWith("..")
  ) {
    return pairing;
  }

  const manifest = await readJson(pairing.manifestPath);
  const index = manifest.pairings.findIndex(
    (item) => item.documentId === pairing.documentId,
  );
  if (index === -1) {
    throw new Error(`Pairing ${pairing.documentId} is missing from its manifest.`);
  }

  if (manifest.pairings[index].markdownPath !== pairing.markdownPath) {
    return validateManifest(manifest, pairing.manifestPath).find(
      (item) => item.documentId === pairing.documentId,
    );
  }
  const occupied = manifest.pairings.find(
    (item, itemIndex) =>
      itemIndex !== index &&
      item.markdownPath &&
      path.normalize(item.markdownPath) === path.normalize(nextRelativePath),
  );
  if (occupied) {
    throw new Error(
      `Cannot adopt move to ${nextRelativePath}: that path is already paired.`,
    );
  }

  manifest.pairings[index] = {
    ...manifest.pairings[index],
    markdownPath: nextRelativePath,
  };
  manifest.pairings.sort(comparePairingLocalPaths);
  const assetRelocation = await relocateAssetDirectory(
    pairing.absolutePath,
    nextAbsolutePath,
  );
  try {
    await writeJsonAtomic(pairing.manifestPath, manifest);
  } catch (error) {
    await rollbackAssetRelocation(assetRelocation);
    throw error;
  }
  return {
    ...pairing,
    markdownPath: nextRelativePath,
    absolutePath: nextAbsolutePath,
  };
}

export async function applyRemoteTitle(pairing, remoteTitle) {
  const title = String(remoteTitle).trim();
  if (!title || pairing.name === title) return pairing;

  const nextRelativePath = pairing.name
    ? path.join(
        path.dirname(pairing.markdownPath),
        markdownFilenameFromTitle(title),
      )
    : pairing.markdownPath;
  const nextAbsolutePath = path.resolve(pairing.syncLocation, nextRelativePath);
  const pathChanged = nextAbsolutePath !== pairing.absolutePath;
  const manifest = await readJson(pairing.manifestPath);
  const index = manifest.pairings.findIndex(
    (item) => item.documentId === pairing.documentId,
  );
  if (index === -1) {
    throw new Error(`Pairing ${pairing.documentId} is missing from its manifest.`);
  }

  const updatedManifest = {
    ...manifest,
    pairings: manifest.pairings.map((item, itemIndex) =>
      itemIndex === index
        ? { ...item, markdownPath: nextRelativePath, name: title }
        : item,
    ),
  };
  updatedManifest.pairings.sort(comparePairingLocalPaths);
  validateManifest(updatedManifest, pairing.manifestPath);

  const [sourceExists, destinationExists, sameFile] = await Promise.all([
    fs.access(pairing.absolutePath).then(() => true).catch((error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    }),
    fs.access(nextAbsolutePath).then(() => true).catch((error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    }),
    pathChanged
      ? pathsReferToSameFile(pairing.absolutePath, nextAbsolutePath)
      : true,
  ]);
  const recoveringInterruptedRename =
    pathChanged &&
    !sourceExists &&
    destinationExists &&
    (await managedFileBelongsToDocument(nextAbsolutePath, pairing.documentId));

  if (
    pathChanged &&
    destinationExists &&
    !sameFile &&
    !recoveringInterruptedRename
  ) {
    throw new Error(
      `Cannot rename ${pairing.markdownPath}: ${nextRelativePath} already exists.`,
    );
  }

  const renamed = pathChanged && sourceExists && !sameFile;
  let assetRelocation;
  try {
    if (renamed) await fs.rename(pairing.absolutePath, nextAbsolutePath);
    if (pathChanged) {
      assetRelocation = await relocateAssetDirectory(
        pairing.absolutePath,
        nextAbsolutePath,
      );
    }
    await writeJsonAtomic(pairing.manifestPath, updatedManifest);
  } catch (error) {
    await rollbackAssetRelocation(assetRelocation);
    if (renamed) await fs.rename(nextAbsolutePath, pairing.absolutePath);
    throw error;
  }

  return {
    ...pairing,
    markdownPath: nextRelativePath,
    name: title,
    absolutePath: nextAbsolutePath,
  };
}

export async function registerPairing({
  syncLocation,
  documentUrl,
  markdownPath,
  name,
}) {
  const resolvedSyncLocation = path.resolve(syncLocation);
  const manifestPath = path.join(resolvedSyncLocation, MANIFEST_NAME);
  const documentId = documentIdFromUrl(documentUrl);
  const relativePath = path.normalize(markdownPath);
  if (path.isAbsolute(relativePath) || relativePath.startsWith("..")) {
    throw new Error("Markdown filename must stay inside the selected sync location.");
  }

  const manifest = await readJson(manifestPath, { version: 1, pairings: [] });
  validateManifest(manifest, manifestPath);
  const pairing = {
    documentId,
    documentUrl: `https://docs.google.com/document/d/${documentId}/edit`,
    markdownPath: relativePath,
    ...(name ? { name } : {}),
  };
  manifest.pairings = manifest.pairings.filter(
    (item) =>
      item.documentId !== documentId && pairingLocalPath(item) !== relativePath,
  );
  manifest.pairings.push(pairing);
  manifest.pairings.sort(comparePairingLocalPaths);
  await writeJsonAtomic(manifestPath, manifest);
  await registerManifest(resolvedSyncLocation, manifestPath);
  return validateManifest({ version: 1, pairings: [pairing] }, manifestPath)[0];
}

export async function registerSpreadsheetPairing({
  syncLocation,
  spreadsheetUrl,
  directoryPath,
  name,
}) {
  const resolvedSyncLocation = path.resolve(syncLocation);
  const manifestPath = path.join(resolvedSyncLocation, MANIFEST_NAME);
  const spreadsheetId = spreadsheetIdFromUrl(spreadsheetUrl);
  const relativePath = path.normalize(directoryPath);
  if (path.isAbsolute(relativePath) || relativePath.startsWith("..")) {
    throw new Error("Spreadsheet directory must stay inside the selected sync location.");
  }
  const manifest = await readJson(manifestPath, { version: 1, pairings: [] });
  validateManifest(manifest, manifestPath);
  const pairing = {
    type: "spreadsheet",
    spreadsheetId,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    directoryPath: relativePath,
    ...(name ? { name } : {}),
  };
  manifest.pairings = manifest.pairings.filter((item) =>
    item.spreadsheetId !== spreadsheetId &&
    pairingLocalPath(item) !== relativePath
  );
  manifest.pairings.push(pairing);
  manifest.pairings.sort(comparePairingLocalPaths);
  await writeJsonAtomic(manifestPath, manifest);
  await registerManifest(resolvedSyncLocation, manifestPath);
  return validateManifest({ version: 1, pairings: [pairing] }, manifestPath)[0];
}
