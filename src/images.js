import fs from "node:fs/promises";
import path from "node:path";
import { ensureDirectory, sha256, writeFileAtomic } from "./files.js";
import { blocksFromDocument } from "./google.js";
import { parseMarkdown } from "./markdown.js";

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const GOOGLE_IMAGE_REFERENCE = /!\[([^\]]*)\]\[(image\d+)\]/gi;

export function assetDirectoryPath(markdownPath) {
  const extension = path.extname(markdownPath);
  return path.join(
    path.dirname(markdownPath),
    `${path.basename(markdownPath, extension)}.assets`,
  );
}

export function localImagePaths(markdownPath, markdown) {
  const directory = assetDirectoryPath(markdownPath);
  const relativeUrls = parseMarkdown(markdown).flatMap((block) => {
    if (block.type === "table") {
      return block.rows.flatMap((row) =>
        row.flatMap((cell) => (cell.images ?? []).map((image) => image.url)),
      );
    }
    return (block.images ?? []).map((image) => image.url);
  }).filter((url) => url && !/^[a-z][a-z0-9+.-]*:/i.test(url));

  return [...new Set(relativeUrls.map((url) => {
    const cleanUrl = url.split(/[?#]/, 1)[0];
    const resolved = path.resolve(path.dirname(markdownPath), cleanUrl);
    const relative = path.relative(directory, resolved);
    if (!relative || path.isAbsolute(relative) || relative.startsWith("..")) {
      throw new Error(
        `Local Markdown images must stay inside ${path.basename(directory)}.`,
      );
    }
    return resolved;
  }))].sort();
}

export async function hashMarkdownWithAssets(markdownPath, markdown) {
  const imagePaths = localImagePaths(markdownPath, markdown);
  if (!imagePaths.length) return sha256(markdown);
  const pieces = [Buffer.from(markdown)];
  for (const imagePath of imagePaths) {
    const bytes = await fs.readFile(imagePath);
    pieces.push(
      Buffer.from(`\0${path.relative(path.dirname(markdownPath), imagePath)}\0`),
      bytes,
    );
  }
  return sha256(Buffer.concat(pieces));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function relocateAssetDirectory(oldMarkdownPath, newMarkdownPath) {
  const source = assetDirectoryPath(oldMarkdownPath);
  const destination = assetDirectoryPath(newMarkdownPath);
  if (source === destination) return { moved: false };
  const sourceExists = await fs.access(source).then(() => true).catch((error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  if (!sourceExists) return { moved: false };
  const destinationExists = await fs.access(destination).then(() => true).catch((error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  if (destinationExists) {
    throw new Error(`Cannot move image assets: ${destination} already exists.`);
  }

  const originalMarkdown = await fs.readFile(newMarkdownPath, "utf8");
  const oldName = path.basename(source);
  const newName = path.basename(destination);
  const rewrittenMarkdown = originalMarkdown.replace(
    new RegExp(`(\\]\\()${escapeRegExp(oldName)}(/)`, "g"),
    `$1${newName}$2`,
  );
  await fs.rename(source, destination);
  try {
    if (rewrittenMarkdown !== originalMarkdown) {
      await writeFileAtomic(newMarkdownPath, Buffer.from(rewrittenMarkdown));
    }
  } catch (error) {
    await fs.rename(destination, source);
    throw error;
  }
  return {
    moved: true,
    source,
    destination,
    markdownPath: newMarkdownPath,
    originalMarkdown,
  };
}

export async function rollbackAssetRelocation(relocation) {
  if (!relocation?.moved) return;
  await writeFileAtomic(
    relocation.markdownPath,
    Buffer.from(relocation.originalMarkdown),
  );
  await fs.rename(relocation.destination, relocation.source);
}

function documentImages(document) {
  return blocksFromDocument(document).flatMap((block, blockIndex) => {
    if (block.type === "table") {
      return block.rows.flatMap((row, rowIndex) =>
        row.flatMap((cell, columnIndex) =>
          (cell.images ?? []).map((image) => ({
            ...image,
            blockIndex,
            rowIndex,
            columnIndex,
          })),
        ),
      );
    }
    return (block.images ?? []).map((image) => ({ ...image, blockIndex }));
  });
}

function exportedImageReferences(markdown) {
  return parseMarkdown(markdown).flatMap((block, blockIndex) => {
    if (block.type === "table") {
      return block.rows.flatMap((row, rowIndex) =>
        row.flatMap((cell, columnIndex) =>
          (cell.images ?? [])
            .filter((image) => image.reference)
            .map((image) => ({ ...image, blockIndex, rowIndex, columnIndex })),
        ),
      );
    }
    return (block.images ?? [])
      .filter((image) => image.reference)
      .map((image) => ({ ...image, blockIndex }));
  });
}

function imageFormat(bytes) {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) return { extension: ".png", mimeType: "image/png" };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: ".jpg", mimeType: "image/jpeg" };
  }
  const signature = bytes.subarray(0, 6).toString("ascii");
  if (signature === "GIF87a" || signature === "GIF89a") {
    return { extension: ".gif", mimeType: "image/gif" };
  }
  throw new Error("Google Docs returned an unsupported inline image format.");
}

async function downloadImage(auth, image) {
  if (!image.contentUri) {
    throw new Error(`Google Docs inline object ${image.objectId} has no content URL.`);
  }
  const response = await auth.request({
    url: image.contentUri,
    responseType: "arraybuffer",
  });
  const bytes = Buffer.from(response.data);
  if (!bytes.length) throw new Error("Google Docs returned an empty inline image.");
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error("Google Docs returned an inline image larger than 50 MB.");
  }
  return { bytes, ...imageFormat(bytes) };
}

function markdownImages(markdown) {
  return parseMarkdown(markdown).flatMap((block) => {
    if (block.type === "table") {
      return block.rows.flatMap((row) =>
        row.flatMap((cell) => cell.images ?? []),
      );
    }
    return block.images ?? [];
  });
}

export function hasImagesForSync(document, markdown) {
  return documentImages(document).length > 0 || markdownImages(markdown).length > 0;
}

export async function prepareImagePush(
  services,
  markdownPath,
  markdown,
  document,
  stager,
) {
  const desiredImages = markdownImages(markdown);
  const remoteImages = documentImages(document);
  if (!desiredImages.length && !remoteImages.length) {
    return {
      currentImageHashes: new Map(),
      desiredImageHashes: new Map(),
      imageUris: new Map(),
      cleanup: async () => [],
    };
  }
  if (!services.auth?.request) {
    throw new Error("Google authentication is unavailable for image comparison.");
  }

  const currentImageHashes = new Map();
  for (const image of remoteImages) {
    const { bytes } = await downloadImage(services.auth, image);
    currentImageHashes.set(image.objectId, sha256(bytes));
  }

  const desiredImageHashes = new Map();
  const imageUris = new Map();
  const staged = [];
  try {
    for (const image of desiredImages) {
      if (image.reference) {
        throw new Error("Unmaterialized Google Docs image placeholders cannot be pushed.");
      }
      if (/^https?:\/\//i.test(image.url ?? "")) {
        desiredImageHashes.set(image.url, image.url);
        imageUris.set(image.url, image.url);
        continue;
      }
      const [imagePath] = localImagePaths(
        markdownPath,
        `![image](${image.url})`,
      );
      const bytes = await fs.readFile(imagePath);
      if (bytes.length > MAX_IMAGE_BYTES) {
        throw new Error(`Local image ${image.url} is larger than 50 MB.`);
      }
      const format = imageFormat(bytes);
      desiredImageHashes.set(image.url, sha256(bytes));
      if (!imageUris.has(image.url)) {
        const item = await stager.stage({ bytes, contentType: format.mimeType });
        staged.push(item);
        imageUris.set(image.url, item.url);
      }
    }
  } catch (error) {
    await Promise.allSettled(staged.map((item) => item.cleanup()));
    throw error;
  }
  return {
    currentImageHashes,
    desiredImageHashes,
    imageUris,
    cleanup: async () => Promise.allSettled(staged.map((item) => item.cleanup())),
  };
}

async function writeAsset(filePath, bytes) {
  const existing = await fs.readFile(filePath).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing) {
    if (sha256(existing) !== sha256(bytes)) {
      throw new Error(`Refusing to overwrite a different image at ${filePath}.`);
    }
    return;
  }
  await writeFileAtomic(filePath, bytes);
}

export async function materializeRemoteImages(
  services,
  pairing,
  document,
  markdown,
) {
  const remoteImages = documentImages(document);
  const references = exportedImageReferences(markdown);
  if (!remoteImages.length && !references.length) return markdown;
  if (remoteImages.length !== references.length) {
    throw new Error(
      `Cannot align Google Docs images: found ${remoteImages.length} inline ` +
        `objects but ${references.length} Markdown placeholders.`,
    );
  }
  if (!services.auth?.request) {
    throw new Error("Google authentication is unavailable for image downloads.");
  }

  const directory = assetDirectoryPath(pairing.absolutePath);
  await ensureDirectory(directory);
  const replacements = [];
  for (let index = 0; index < remoteImages.length; index += 1) {
    const remote = remoteImages[index];
    const reference = references[index];
    if (
      remote.rowIndex !== reference.rowIndex ||
      remote.columnIndex !== reference.columnIndex
    ) {
      throw new Error("Cannot align a Google Docs image across table boundaries.");
    }
    const { bytes, extension } = await downloadImage(services.auth, remote);
    const digest = sha256(bytes);
    const filename = `image-${digest.slice(0, 12)}${extension}`;
    const filePath = path.join(directory, filename);
    await writeAsset(filePath, bytes);
    replacements.push({
      reference: reference.reference,
      alt: reference.alt,
      relativePath: path.posix.join(path.basename(directory), filename),
    });
  }

  let replacementIndex = 0;
  const materialized = markdown.replace(
    GOOGLE_IMAGE_REFERENCE,
    (match, exportedAlt, identifier) => {
      const replacement = replacements[replacementIndex];
      if (!replacement || replacement.reference.toLowerCase() !== identifier.toLowerCase()) {
        throw new Error("Google Docs image placeholder order changed during pull.");
      }
      replacementIndex += 1;
      const alt = exportedAlt || replacement.alt || "";
      return `![${alt}](${replacement.relativePath})`;
    },
  );
  if (replacementIndex !== replacements.length) {
    throw new Error("Not every Google Docs image placeholder was materialized.");
  }
  return materialized;
}
