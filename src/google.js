import { google } from "googleapis";
import { googleRequestTimeoutMs } from "./config.js";
import {
  INLINE_IMAGE_MARKER,
  parseMarkdown,
} from "./markdown.js";
import { DOC_STATUS_TITLE, stripRemoteDocumentStatus } from "./status.js";

export function createGoogleServices(
  auth,
  { timeout = googleRequestTimeoutMs() } = {},
) {
  return {
    auth,
    docs: google.docs({ version: "v1", auth, timeout }),
    drive: google.drive({ version: "v3", auth, timeout }),
    sheets: google.sheets({ version: "v4", auth, timeout }),
  };
}

export async function exportMarkdown(services, documentId) {
  const response = await services.drive.files.export(
    { fileId: documentId, mimeType: "text/markdown" },
    { responseType: "arraybuffer" },
  );
  return stripRemoteDocumentStatus(Buffer.from(response.data).toString("utf8"));
}

export async function getRemoteInfo(services, documentId) {
  const [fileResponse, documentResponse] = await Promise.all([
    services.drive.files.get({
      fileId: documentId,
      fields: "id,modifiedTime,name",
    }),
    services.docs.documents.get({
      documentId,
      suggestionsViewMode: "PREVIEW_WITHOUT_SUGGESTIONS",
    }),
  ]);
  return {
    modifiedTime: fileResponse.data.modifiedTime,
    name: fileResponse.data.name,
    revisionId: documentResponse.data.revisionId,
    document: documentResponse.data,
  };
}

export async function createDocumentFromMarkdown(
  services,
  title,
  markdown,
  { onProgress } = {},
) {
  const response = await services.docs.documents.create({
    requestBody: { title },
  });
  const documentId = response.data.documentId;
  if (!documentId) throw new Error("Google Docs did not return a document ID.");
  onProgress?.({ type: "writing-content" });
  const remote = await updateDocumentFromMarkdown(
    services,
    documentId,
    markdown,
    { onProgress },
  );
  return {
    documentId,
    documentUrl: `https://docs.google.com/document/d/${documentId}/edit`,
    remote,
  };
}

function bodyOf(document) {
  if (document.body) return document.body;
  const firstTab = document.tabs?.[0]?.documentTab;
  if (firstTab?.body) return firstTab.body;
  throw new Error("The document has no writable primary body.");
}

function bodyEndIndex(document) {
  const content = bodyOf(document).content ?? [];
  return Math.max(1, ...content.map((element) => element.endIndex ?? 1));
}

function inlineObjectsOf(document) {
  if (document.inlineObjects) return document.inlineObjects;
  return document.tabs?.[0]?.documentTab?.inlineObjects ?? {};
}

function paragraphText(element) {
  const text = (element.paragraph?.elements ?? [])
    .map((content) => content.textRun?.content ?? "")
    .join("");
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function createHeadingSlugger() {
  const used = new Set();
  return (text) => {
    const base = text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "")
      .replace(/\s+/g, "-");
    let slug = base;
    let suffix = 0;
    while (used.has(slug)) {
      suffix += 1;
      slug = `${base}-${suffix}`;
    }
    used.add(slug);
    return slug;
  };
}

function headingLinks(document, desiredBlocks = []) {
  const idToFragment = new Map();
  const fragmentToId = new Map();
  const slug = createHeadingSlugger();
  const desiredByText = new Map();
  for (const block of desiredBlocks) {
    if (
      block.type !== "text" ||
      !String(block.paragraphStyle).startsWith("HEADING_")
    ) {
      continue;
    }
    const fragments = desiredByText.get(block.text) ?? [];
    fragments.push(block.headingFragment);
    desiredByText.set(block.text, fragments);
  }
  for (const element of bodyOf(document).content ?? []) {
    if (!element.paragraph) continue;
    const style = element.paragraph.paragraphStyle ?? {};
    if (!String(style.namedStyleType ?? "").startsWith("HEADING_")) continue;
    const text = paragraphText(element);
    const hintedFragment = desiredByText.get(text)?.shift();
    const generatedFragment = `#${slug(text)}`;
    const fragment = hintedFragment ?? generatedFragment;
    if (style.headingId) {
      idToFragment.set(style.headingId, fragment);
      fragmentToId.set(fragment, style.headingId);
    }
  }
  return { idToFragment, fragmentToId };
}

function linkHeadingId(link = {}) {
  return link.headingId ?? link.heading?.id;
}

function normalizedTextStyle(style = {}, idToFragment = new Map()) {
  const normalized = {};
  if (style.bold) normalized.bold = true;
  if (style.italic) normalized.italic = true;
  if (style.strikethrough) normalized.strikethrough = true;
  const headingId = linkHeadingId(style.link);
  if (headingId && idToFragment.has(headingId)) {
    normalized.link = idToFragment.get(headingId);
  } else if (style.link?.url) {
    normalized.link = style.link.url;
  }
  return normalized;
}

function paragraphFromDocument(element, document, idToFragment = new Map()) {
  let text = "";
  const styles = [];
  const images = [];
  for (const content of element.paragraph.elements ?? []) {
    const inlineObjectId = content.inlineObjectElement?.inlineObjectId;
    if (inlineObjectId) {
      const offset = text.length;
      const embeddedObject = inlineObjectsOf(document)[inlineObjectId]
        ?.inlineObjectProperties?.embeddedObject ?? {};
      text += INLINE_IMAGE_MARKER;
      images.push({
        offset,
        objectId: inlineObjectId,
        ...(embeddedObject.title ? { title: embeddedObject.title } : {}),
        ...(embeddedObject.description
          ? { description: embeddedObject.description }
          : {}),
        ...(embeddedObject.size ? { size: embeddedObject.size } : {}),
        ...(embeddedObject.imageProperties?.sourceUri
          ? { sourceUri: embeddedObject.imageProperties.sourceUri }
          : {}),
        ...(embeddedObject.imageProperties?.contentUri
          ? { contentUri: embeddedObject.imageProperties.contentUri }
          : {}),
      });
      continue;
    }
    const value = content.textRun?.content ?? "";
    const start = text.length;
    text += value;
    const style = normalizedTextStyle(
      content.textRun?.textStyle,
      idToFragment,
    );
    const visibleEnd = Math.min(text.length, text.endsWith("\n") ? text.length - 1 : text.length);
    if (visibleEnd > start && Object.keys(style).length) {
      styles.push({ start, end: visibleEnd, style });
    }
  }
  if (text.endsWith("\n")) text = text.slice(0, -1);

  const bullet = element.paragraph.bullet;
  if (bullet) {
    const level =
      document.lists?.[bullet.listId]?.listProperties?.nestingLevels?.[
        bullet.nestingLevel ?? 0
      ] ?? {};
    const ordered =
      !level.glyphSymbol &&
      (Boolean(
        level.glyphType && level.glyphType !== "GLYPH_TYPE_UNSPECIFIED",
      ) ||
        String(level.glyphFormat ?? "").includes("%"));
    return {
      type: "listItem",
      ordered,
      nestingLevel: bullet.nestingLevel ?? 0,
      text,
      styles,
      ...(images.length ? { images } : {}),
      startIndex: element.startIndex,
      endIndex: element.endIndex,
    };
  }
  const paragraphSpaceBelow =
    element.paragraph.paragraphStyle?.spaceBelow?.magnitude;
  return {
    type: "text",
    paragraphStyle:
      element.paragraph.paragraphStyle?.namedStyleType ?? "NORMAL_TEXT",
    ...(paragraphSpaceBelow === undefined ? {} : { paragraphSpaceBelow }),
    text,
    styles,
    ...(images.length ? { images } : {}),
    startIndex: element.startIndex,
    endIndex: element.endIndex,
  };
}

function tableFromDocument(element, document, idToFragment = new Map()) {
  return {
    type: "table",
    rows: (element.table.tableRows ?? []).map((row) =>
      (row.tableCells ?? []).map((cell) => {
        const paragraphs = (cell.content ?? [])
          .filter((item) => item.paragraph)
          .map((item) =>
            paragraphFromDocument(item, document, idToFragment),
          );
        let text = "";
        const styles = [];
        for (const [index, paragraph] of paragraphs.entries()) {
          if (index) text += "\n";
          const offset = text.length;
          text += paragraph.text;
          styles.push(
            ...paragraph.styles.map((range) => ({
              ...range,
              start: range.start + offset,
              end: range.end + offset,
            })),
          );
        }
        const images = paragraphs.flatMap((paragraph, paragraphIndex) => {
          const prefixLength = paragraphs
            .slice(0, paragraphIndex)
            .reduce((total, item) => total + item.text.length + 1, 0);
          return (paragraph.images ?? []).map((image) => ({
            ...image,
            offset: image.offset + prefixLength,
          }));
        });
        return {
          text,
          styles,
          ...(images.length ? { images } : {}),
        };
      }),
    ),
    startIndex: element.startIndex,
    endIndex: element.endIndex,
  };
}

function tableOfContentsFromDocument(
  element,
  document,
  idToFragment = new Map(),
) {
  const paragraphs = (element.tableOfContents.content ?? [])
    .filter((item) => item.paragraph)
    .map((item) => ({
      ...paragraphFromDocument(item, document, idToFragment),
      nativeTableOfContents: true,
    }));
  return paragraphs.flatMap((paragraph, index) => [
    ...(index
      ? [
          {
            type: "text",
            paragraphStyle: "NORMAL_TEXT",
            text: "",
            styles: [],
            startIndex: paragraph.startIndex,
            endIndex: paragraph.startIndex,
            nativeTableOfContents: true,
          },
        ]
      : []),
    paragraph,
  ]);
}

export function blocksFromDocument(document, desiredBlocks = []) {
  const blocks = [];
  const { idToFragment } = headingLinks(document, desiredBlocks);
  for (const element of bodyOf(document).content ?? []) {
    if (element.paragraph) {
      blocks.push(paragraphFromDocument(element, document, idToFragment));
    } else if (element.table) {
      blocks.push(tableFromDocument(element, document, idToFragment));
    } else if (element.tableOfContents) {
      blocks.push(
        ...tableOfContentsFromDocument(element, document, idToFragment),
      );
    }
  }
  if (blocks.at(-1)?.type === "text" && blocks.at(-1)?.text === "") blocks.pop();
  return blocks;
}

function comparableBlock(block, imageHashes = new Map()) {
  if (block.type === "table") {
    return {
      type: "table",
      rows: block.rows.map((row) =>
        row.map((cell) => ({
          text: cell.text,
          styles: cell.styles,
          images: (cell.images ?? []).map((image) => ({
            offset: image.offset,
            ...(imageHashes.has(image.objectId ?? image.url)
              ? { contentHash: imageHashes.get(image.objectId ?? image.url) }
              : {}),
          })),
        })),
      ),
    };
  }
  return {
    type: block.type,
    ...(block.type === "text"
      ? { paragraphStyle: block.paragraphStyle }
      : { ordered: block.ordered, nestingLevel: block.nestingLevel ?? 0 }),
    text: block.text,
    styles: block.styles,
    images: (block.images ?? []).map((image) => ({
      offset: image.offset,
      ...(imageHashes.has(image.objectId ?? image.url)
        ? { contentHash: imageHashes.get(image.objectId ?? image.url) }
        : {}),
    })),
  };
}

function blockHasImages(block) {
  if (block.type === "table") {
    return block.rows.some((row) =>
      row.some((cell) => (cell.images ?? []).length > 0),
    );
  }
  return (block.images ?? []).length > 0;
}

function standaloneImage(block) {
  return (
    block.type === "text" &&
    block.text === INLINE_IMAGE_MARKER &&
    block.images?.length === 1 &&
    block.images[0].offset === 0
  );
}

function assertSupportedImageMutation(current, desired, hunks, imageUris) {
  const changesImages = hunks.some((hunk) =>
    [
      ...current.slice(hunk.currentStart, hunk.currentEnd),
      ...desired.slice(hunk.desiredStart, hunk.desiredEnd),
    ].some(blockHasImages),
  );
  if (changesImages && !imageUris) {
    throw new Error(
      "Inline images cannot be added, removed, replaced, or edited from " +
        "Markdown yet. Leave the image-bearing paragraph unchanged or edit " +
        "the image in Google Docs.",
    );
  }

  if (changesImages) {
    const changedBlocks = hunks.flatMap((hunk) => [
      ...current.slice(hunk.currentStart, hunk.currentEnd),
      ...desired.slice(hunk.desiredStart, hunk.desiredEnd),
    ]).filter(blockHasImages);
    if (changedBlocks.some((block) => !standaloneImage(block))) {
      throw new Error(
        "Only standalone image paragraphs can be changed from Markdown. " +
          "Mixed text-and-image paragraphs are not supported yet.",
      );
    }
    for (const block of desired) {
      for (const image of block.images ?? []) {
        if (!imageUris.has(image.url)) {
          throw new Error(`No staged image URL is available for ${image.url}.`);
        }
      }
    }
  }

  if (imageUris) return;
  for (let index = 0; index < desired.length; index += 1) {
    const desiredImages = desired[index].images ?? [];
    const currentImages = current[index]?.images ?? [];
    for (let imageIndex = 0; imageIndex < desiredImages.length; imageIndex += 1) {
      const desiredImage = desiredImages[imageIndex];
      const currentImage = currentImages[imageIndex];
      const remoteSource = currentImage?.sourceUri ?? currentImage?.contentUri;
      const desiredIsExportReference = Boolean(desiredImage.reference);
      const desiredIsRemoteUrl = /^https?:\/\//i.test(desiredImage.url ?? "");
      if (
        !desiredIsExportReference &&
        (!desiredIsRemoteUrl || (remoteSource && desiredImage.url !== remoteSource))
      ) {
        throw new Error(
          "Inline image sources cannot be changed from Markdown yet. Leave " +
            "the exported remote image reference unchanged or edit the image " +
            "in Google Docs.",
        );
      }
    }
  }
}

function fingerprint(block, imageHashes) {
  return JSON.stringify(comparableBlock(block, imageHashes));
}

export function diffBlockHunks(
  current,
  desired,
  { currentImageHashes, desiredImageHashes } = {},
) {
  const currentKeys = current.map((block) => fingerprint(block, currentImageHashes));
  const desiredKeys = desired.map((block) => fingerprint(block, desiredImageHashes));
  const matrix = Array.from(
    { length: current.length + 1 },
    () => new Uint32Array(desired.length + 1),
  );
  for (let left = current.length - 1; left >= 0; left -= 1) {
    for (let right = desired.length - 1; right >= 0; right -= 1) {
      matrix[left][right] =
        currentKeys[left] === desiredKeys[right]
          ? matrix[left + 1][right + 1] + 1
          : Math.max(matrix[left + 1][right], matrix[left][right + 1]);
    }
  }

  const matches = [];
  let left = 0;
  let right = 0;
  while (left < current.length && right < desired.length) {
    if (currentKeys[left] === desiredKeys[right]) {
      matches.push([left, right]);
      left += 1;
      right += 1;
    } else if (matrix[left + 1][right] >= matrix[left][right + 1]) {
      left += 1;
    } else {
      right += 1;
    }
  }

  const hunks = [];
  let currentStart = 0;
  let desiredStart = 0;
  for (const [currentMatch, desiredMatch] of [
    ...matches,
    [current.length, desired.length],
  ]) {
    if (currentStart !== currentMatch || desiredStart !== desiredMatch) {
      hunks.push({
        currentStart,
        currentEnd: currentMatch,
        desiredStart,
        desiredEnd: desiredMatch,
      });
    }
    currentStart = currentMatch + 1;
    desiredStart = desiredMatch + 1;
  }
  return hunks;
}

function inlineStyleRequests(start, ranges) {
  return ranges.flatMap((range) => {
    const textStyle = {};
    const fields = [];
    if (range.style.bold) {
      textStyle.bold = true;
      fields.push("bold");
    }
    if (range.style.italic) {
      textStyle.italic = true;
      fields.push("italic");
    }
    if (range.style.strikethrough) {
      textStyle.strikethrough = true;
      fields.push("strikethrough");
    }
    if (range.style.link && !range.style.link.startsWith("#")) {
      textStyle.link = { url: range.style.link };
      fields.push("link");
    }
    if (!fields.length) return [];
    return {
      updateTextStyle: {
        range: {
          startIndex: start + range.start,
          endIndex: start + range.end,
        },
        textStyle,
        fields: fields.join(","),
      },
    };
  });
}

function internalLinkAt(block, offset) {
  for (const range of block.styles ?? []) {
    if (
      range.start <= offset &&
      range.end > offset &&
      range.style.link?.startsWith("#")
    ) {
      return range.style.link;
    }
  }
  return undefined;
}

function desiredHeadingFragments(blocks) {
  const fragments = new Set();
  const slug = createHeadingSlugger();
  for (const block of blocks) {
    if (
      block.type === "text" &&
      String(block.paragraphStyle).startsWith("HEADING_")
    ) {
      const generatedFragment = `#${slug(block.text)}`;
      fragments.add(block.headingFragment ?? generatedFragment);
    }
  }
  return fragments;
}

function internalLinks(blocks) {
  return blocks.flatMap((block) =>
    (block.styles ?? [])
      .filter((range) => range.style.link?.startsWith("#"))
      .map((range) => ({
        block,
        range,
        fragment: range.style.link,
      })),
  );
}

function assertResolvableHeadingLinks(blocks) {
  if (
    blocks.some(
      (block) =>
        block.type === "table" &&
        block.rows.some((row) =>
          row.some((cell) =>
            cell.styles.some((range) => range.style.link?.startsWith("#")),
          ),
        ),
    )
  ) {
    throw new Error("Markdown heading links inside tables are not supported.");
  }
  const fragments = desiredHeadingFragments(blocks);
  const unresolved = [
    ...new Set(
      internalLinks(blocks)
        .map((item) => item.fragment)
        .filter((fragment) => !fragments.has(fragment)),
    ),
  ];
  if (unresolved.length) {
    throw new Error(
      `Markdown heading link${unresolved.length === 1 ? "" : "s"} ` +
        `${unresolved.join(", ")} ${unresolved.length === 1 ? "does" : "do"} ` +
        "not match a heading in the document.",
    );
  }
}

function withoutStructuralTableSpacers(blocks) {
  return blocks.filter((block, index, all) => {
    const structuralTableSpacer =
      block.type === "text" &&
      block.text === "" &&
      all[index + 1]?.type === "table";
    return !structuralTableSpacer;
  });
}

function withoutManagedStatusBlocks(blocks) {
  const statusIndex = blocks.findIndex(
    (block) => block.type === "text" && block.text === DOC_STATUS_TITLE,
  );
  if (statusIndex < 0) return blocks;
  let start = statusIndex;
  while (start > 0 && blocks[start - 1].type === "text" && blocks[start - 1].text === "") start -= 1;
  if (start > 0 && blocks[start - 1].type === "text" && blocks[start - 1].text === "---") start -= 1;
  return blocks.slice(0, start);
}

export function planHeadingLinkUpdate(document, markdown) {
  const desired = parseMarkdown(markdown);
  assertResolvableHeadingLinks(desired);
  const current = withoutStructuralTableSpacers(
    blocksFromDocument(document, desired),
  );
  const { fragmentToId } = headingLinks(document, desired);
  if (current.length !== desired.length) {
    throw new Error("Google Docs content did not settle after its structural update.");
  }

  const requests = [];
  for (let blockIndex = 0; blockIndex < desired.length; blockIndex += 1) {
    const desiredBlock = desired[blockIndex];
    const currentBlock = current[blockIndex];
    if (desiredBlock.type === "table") continue;
    if (
      currentBlock.type === "table" ||
      currentBlock.text !== desiredBlock.text
    ) {
      throw new Error(
        "Google Docs content did not settle after its structural update.",
      );
    }
    let rangeStart;
    let previousDesired;
    for (let offset = 0; offset <= desiredBlock.text.length; offset += 1) {
      const desiredLink =
        offset < desiredBlock.text.length
          ? internalLinkAt(desiredBlock, offset)
          : undefined;
      const currentLink =
        offset < currentBlock.text.length
          ? internalLinkAt(currentBlock, offset)
          : undefined;
      const differs = desiredLink !== currentLink;
      if (differs && rangeStart === undefined) {
        rangeStart = offset;
        previousDesired = desiredLink;
      }
      const boundary =
        rangeStart !== undefined &&
        (!differs || desiredLink !== previousDesired);
      if (boundary) {
        const headingId = previousDesired
          ? fragmentToId.get(previousDesired)
          : undefined;
        if (previousDesired && !headingId) {
          throw new Error(
            `Google Docs did not assign a heading ID for ${previousDesired}.`,
          );
        }
        requests.push({
          updateTextStyle: {
            range: {
              startIndex: currentBlock.startIndex + rangeStart,
              endIndex: currentBlock.startIndex + offset,
            },
            textStyle: {
              link: headingId ? { headingId } : null,
            },
            fields: "link",
          },
        });
        rangeStart = differs ? offset : undefined;
        previousDesired = desiredLink;
      }
    }
  }
  return requests;
}

export function planParagraphSpacingUpdate(document, markdown) {
  const desired = parseMarkdown(markdown);
  const current = withoutManagedStatusBlocks(
    withoutStructuralTableSpacers(blocksFromDocument(document, desired)),
  );

  const requests = [];
  let currentIndex = 0;
  for (const desiredBlock of desired) {
    const desiredFingerprint = fingerprint(desiredBlock);
    while (
      currentIndex < current.length &&
      fingerprint(current[currentIndex]) !== desiredFingerprint
    ) {
      currentIndex += 1;
    }
    if (currentIndex >= current.length) break;
    const currentBlock = current[currentIndex];
    currentIndex += 1;
    if (
      desiredBlock.type !== "text" ||
      desiredBlock.paragraphStyle !== "NORMAL_TEXT" ||
      currentBlock.type !== "text" ||
      currentBlock.nativeTableOfContents ||
      currentBlock.text !== desiredBlock.text
    ) {
      continue;
    }
    const target = desiredBlock.paragraphSpaceBelow ?? 0;
    if ((currentBlock.paragraphSpaceBelow ?? 0) === target) continue;
    requests.push({
      updateParagraphStyle: {
        range: {
          startIndex: currentBlock.startIndex,
          endIndex: currentBlock.endIndex,
        },
        paragraphStyle: {
          spaceBelow: { magnitude: target, unit: "PT" },
        },
        fields: "spaceBelow",
      },
    });
  }
  return requests;
}

function insertionRequests(
  startIndex,
  blocks,
  {
    append = false,
    imageUris,
    imageSizes = new Map(),
    retainedTerminalParagraph = false,
    applyParagraphSpacing = true,
  } = {},
) {
  if (blocks.some(blockHasImages)) {
    if (!imageUris) throw new Error("Inline image insertion is not configured.");
    const requests = [];
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index];
      const blockAppend = append && index === 0;
      if (!blockHasImages(block)) {
        requests.push(
          ...insertionRequests(startIndex, [block], { append: blockAppend }),
        );
        continue;
      }
      if (!standaloneImage(block)) {
        throw new Error("Only standalone image paragraphs can be inserted.");
      }
      const image = block.images[0];
      const leadingSeparation = blockAppend ? "\n" : "";
      const reuseParagraph = retainedTerminalParagraph && index === blocks.length - 1;
      if (!reuseParagraph) {
        requests.push({
          insertText: {
            location: { index: startIndex },
            text: `${leadingSeparation}\n`,
          },
        });
      }
      requests.push({
        insertInlineImage: {
          location: {
            index: startIndex + (reuseParagraph ? 0 : leadingSeparation.length),
          },
          uri: imageUris.get(image.url),
          ...(imageSizes.get(image.url)
            ? { objectSize: imageSizes.get(image.url) }
            : {}),
        },
      });
    }
    return requests;
  }
  const prefix = append && blocks.length ? "\n" : "";
  const rendered = blocks.map((block) => ({
    block,
    prefix: block.type === "listItem" ? "\t".repeat(block.nestingLevel ?? 0) : "",
  }));
  const text = `${prefix}${rendered.map(({ block, prefix: blockPrefix }) => `${blockPrefix}${block.text}\n`).join("")}`;
  if (!text) return [];
  const requests = [
    { insertText: { location: { index: startIndex }, text } },
    {
      updateTextStyle: {
        range: { startIndex, endIndex: startIndex + text.length },
        textStyle: {
          bold: false,
          italic: false,
          strikethrough: false,
          link: null,
        },
        fields: "bold,italic,strikethrough,link",
      },
    },
    {
      deleteParagraphBullets: {
        range: { startIndex, endIndex: startIndex + text.length },
      },
    },
  ];
  let offset = prefix.length;
  const positioned = rendered.map(({ block, prefix: blockPrefix }) => {
    const blockStart = startIndex + offset;
    const visibleStart = blockStart + blockPrefix.length;
    const blockEnd = visibleStart + block.text.length + 1;
    offset += blockPrefix.length + block.text.length + 1;
    return { block, blockStart, visibleStart, blockEnd };
  });
  // Google Docs removes leading tabs when it creates nested bullets. Work from
  // the end so those removals cannot invalidate the remaining request indexes.
  for (const { block, blockStart, visibleStart, blockEnd } of positioned.reverse()) {
    requests.push(...inlineStyleRequests(visibleStart, block.styles));
    if (block.type === "text") {
      const paragraphStyle = { namedStyleType: block.paragraphStyle };
      const fields = ["namedStyleType"];
      if (applyParagraphSpacing && block.paragraphStyle === "NORMAL_TEXT") {
        paragraphStyle.spaceBelow = {
          magnitude: block.paragraphSpaceBelow ?? 0,
          unit: "PT",
        };
        fields.push("spaceBelow");
      }
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: visibleStart, endIndex: blockEnd },
          paragraphStyle,
          fields: fields.join(","),
        },
      });
    } else {
      requests.push({
        createParagraphBullets: {
          range: { startIndex: blockStart, endIndex: blockEnd },
          bulletPreset: block.ordered
            ? "NUMBERED_DECIMAL_NESTED"
            : "BULLET_DISC_CIRCLE_SQUARE",
        },
      });
    }
  }
  return requests;
}

function statusInsertionRequests(startIndex, statusMarkdown) {
  const leadingSeparation = "\n\n";
  const requests = insertionRequests(
    startIndex,
    parseMarkdown(statusMarkdown),
    { applyParagraphSpacing: false },
  );
  const insertion = requests.find((request) => request.insertText);
  if (!insertion) return requests;

  insertion.insertText.text = leadingSeparation + insertion.insertText.text;
  for (const request of requests) {
    const range =
      request.updateTextStyle?.range ??
      request.deleteParagraphBullets?.range ??
      request.updateParagraphStyle?.range ??
      request.createParagraphBullets?.range;
    if (range) {
      range.startIndex += leadingSeparation.length;
      range.endIndex += leadingSeparation.length;
    }
  }
  requests.push({
    updateTextStyle: {
      range: {
        startIndex: startIndex + leadingSeparation.length,
        endIndex: startIndex + insertion.insertText.text.length,
      },
      textStyle: {
        foregroundColor: {
          color: { rgbColor: { red: 0.35, green: 0.35, blue: 0.35 } },
        },
      },
      fields: "foregroundColor",
    },
  });
  return requests;
}

export function planIncrementalUpdate(
  document,
  markdown,
  {
    ignoreManagedStatus = false,
    currentImageHashes,
    desiredImageHashes,
    imageUris,
  } = {},
) {
  const desired = parseMarkdown(markdown);
  assertResolvableHeadingLinks(desired);
  let current = withoutStructuralTableSpacers(
    blocksFromDocument(document, desired),
  );
  if (ignoreManagedStatus) {
    current = withoutManagedStatusBlocks(current);
  }
  const hunks = diffBlockHunks(current, desired, {
    currentImageHashes,
    desiredImageHashes,
  });
  assertSupportedImageMutation(current, desired, hunks, imageUris);
  const firstNativeToc = current.findIndex(
    (block) => block.nativeTableOfContents,
  );
  const lastNativeToc = current.findLastIndex(
    (block) => block.nativeTableOfContents,
  );
  const changesNativeToc =
    firstNativeToc >= 0 &&
    hunks.some(
      (hunk) =>
        (hunk.currentStart < hunk.currentEnd &&
          hunk.currentStart <= lastNativeToc &&
          hunk.currentEnd > firstNativeToc) ||
        (hunk.currentStart === hunk.currentEnd &&
          hunk.currentStart > firstNativeToc &&
          hunk.currentStart <= lastNativeToc),
    );
  if (changesNativeToc) {
    throw new Error(
      "A native Google Docs table of contents cannot be edited from Markdown. " +
        "Leave its exported Markdown range unchanged or replace it in Google Docs.",
    );
  }
  const requiresTableFallback = hunks.some((hunk) =>
    [
      ...current.slice(hunk.currentStart, hunk.currentEnd),
      ...desired.slice(hunk.desiredStart, hunk.desiredEnd),
    ].some((block) => block.type === "table"),
  );
  if (requiresTableFallback) {
    if (firstNativeToc >= 0) {
      throw new Error(
        "A document containing a native Google Docs table of contents cannot " +
          "use the full-rebuild table fallback.",
      );
    }
    return { mode: "full-rebuild", current, desired, hunks, requests: [] };
  }

  const endIndex = bodyEndIndex(document);
  const requests = [];
  for (const hunk of [...hunks].reverse()) {
    const insertionIndex =
      hunk.currentStart < current.length
        ? current[hunk.currentStart].startIndex
        : endIndex - 1;
    let retainedTerminalParagraph = false;
    if (hunk.currentStart < hunk.currentEnd) {
      const rawEnd = current[hunk.currentEnd - 1].endIndex;
      const deletionEnd = Math.min(rawEnd, endIndex - 1);
      retainedTerminalParagraph = rawEnd > deletionEnd;
      if (deletionEnd > insertionIndex) {
        requests.push({
          deleteContentRange: {
            range: { startIndex: insertionIndex, endIndex: deletionEnd },
          },
        });
      }
    }
    const desiredBlocks = desired.slice(hunk.desiredStart, hunk.desiredEnd);
    const imageSizes = new Map();
    const currentImages = current
      .slice(hunk.currentStart, hunk.currentEnd)
      .flatMap((block) => block.images ?? []);
    const desiredImages = desiredBlocks.flatMap((block) => block.images ?? []);
    if (currentImages.length === 1 && desiredImages.length === 1) {
      if (currentImages[0].size) {
        imageSizes.set(desiredImages[0].url, currentImages[0].size);
      }
    }
    requests.push(
      ...insertionRequests(insertionIndex, desiredBlocks, {
        append:
          current.length > 0 &&
          hunk.currentStart === current.length &&
          hunk.currentStart === hunk.currentEnd,
        imageUris,
        imageSizes,
        retainedTerminalParagraph,
      }),
    );
  }
  return { mode: "incremental", current, desired, hunks, requests };
}

export function planSpacingCleanup(document, markdown) {
  const desired = parseMarkdown(markdown);
  const current = withoutManagedStatusBlocks(
    withoutStructuralTableSpacers(blocksFromDocument(document, desired)),
  ).filter(
    (block) =>
      !(
        block.nativeTableOfContents &&
        block.type === "text" &&
        block.text === "" &&
        block.startIndex === block.endIndex
      ),
  );
  const plan = {
    mode: "spacing-cleanup",
    current,
    desired,
    hunks: diffBlockHunks(current, desired),
  };
  const requests = [];
  let emptyParagraphs = 0;
  for (let start = 0; start < plan.current.length; start += 1) {
    if (plan.current[start].type !== "text" || plan.current[start].text !== "") continue;
    let end = start + 1;
    while (
      end < plan.current.length &&
      plan.current[end].type === "text" &&
      plan.current[end].text === ""
    ) end += 1;
    if (start === 0 || end === plan.current.length) {
      start = end - 1;
      continue;
    }
    const before = fingerprint(plan.current[start - 1]);
    const after = fingerprint(plan.current[end]);
    const matches = [];
    for (let desiredIndex = 0; desiredIndex < plan.desired.length; desiredIndex += 1) {
      if (fingerprint(plan.desired[desiredIndex]) !== before) continue;
      let next = desiredIndex + 1;
      while (
        next < plan.desired.length &&
        plan.desired[next].type === "text" &&
        plan.desired[next].text === ""
      ) next += 1;
      if (next < plan.desired.length && fingerprint(plan.desired[next]) === after) {
        matches.push({ emptyParagraphs: next - desiredIndex - 1 });
      }
    }
    if (matches.length === 1) {
      const excess = end - start - matches[0].emptyParagraphs;
      const writableRun = plan.current
        .slice(start, end)
        .every(
          (block) =>
            !block.nativeTableOfContents && block.endIndex > block.startIndex,
        ) && !plan.current[end].nativeTableOfContents;
      if (excess > 0 && writableRun) {
        const first = start + matches[0].emptyParagraphs;
        requests.push({
          deleteContentRange: {
            range: {
              startIndex: plan.current[first].startIndex,
              endIndex: plan.current[end - 1].endIndex,
            },
          },
        });
        emptyParagraphs += excess;
      }
    }
    start = end - 1;
  }
  requests.sort(
    (left, right) =>
      right.deleteContentRange.range.startIndex -
      left.deleteContentRange.range.startIndex,
  );
  return {
    ...plan,
    safe: true,
    requests,
    emptyParagraphs,
  };
}

export async function cleanupDocumentSpacing(services, documentId, markdown) {
  const document = await currentDocument(services, documentId);
  const plan = planSpacingCleanup(document, markdown);
  if (plan.requests.length) {
    await services.docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: plan.requests,
        writeControl: { requiredRevisionId: document.revisionId },
      },
    });
  }
  return { remote: await getRemoteInfo(services, documentId), ...plan };
}

async function currentDocument(services, documentId) {
  const response = await services.docs.documents.get({
    documentId,
    suggestionsViewMode: "PREVIEW_WITHOUT_SUGGESTIONS",
  });
  return response.data;
}

async function reconcileHeadingLinks(services, documentId, markdown) {
  const document = await currentDocument(services, documentId);
  const requests = [
    ...planHeadingLinkUpdate(document, markdown),
    ...planParagraphSpacingUpdate(document, markdown),
  ];
  if (requests.length) {
    await services.docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests,
        writeControl: { requiredRevisionId: document.revisionId },
      },
    });
  }
}

export async function updateDocumentFromMarkdown(
  services,
  documentId,
  markdown,
  { onProgress, imageSync } = {},
) {
  const document = await currentDocument(services, documentId);
  const plan = planIncrementalUpdate(document, markdown, imageSync);
  if (plan.mode === "full-rebuild") {
    return replaceDocumentFromMarkdown(services, documentId, markdown, {
      onProgress,
    });
  }
  if (plan.requests.length) {
    await services.docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: plan.requests,
        writeControl: { requiredRevisionId: document.revisionId },
      },
    });
  }
  await reconcileHeadingLinks(services, documentId, markdown);
  return getRemoteInfo(services, documentId);
}

export async function updateDocumentParagraphSpacing(
  services,
  documentId,
  document,
  markdown,
) {
  const requests = planParagraphSpacingUpdate(document, markdown);
  if (!requests.length) return undefined;
  await services.docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests,
      writeControl: { requiredRevisionId: document.revisionId },
    },
  });
  return getRemoteInfo(services, documentId);
}

export async function updateDocumentStatus(
  services,
  documentId,
  statusMarkdown,
) {
  const document = await currentDocument(services, documentId);
  const current = blocksFromDocument(document);
  const statusIndex = current.findIndex(
    (block) => block.type === "text" && block.text === DOC_STATUS_TITLE,
  );
  let insertionIndex = bodyEndIndex(document) - 1;
  const requests = [];
  if (statusIndex >= 0) {
    let firstStatusBlock = statusIndex;
    while (
      firstStatusBlock > 0 &&
      current[firstStatusBlock - 1].type === "text" &&
      current[firstStatusBlock - 1].text === ""
    ) {
      firstStatusBlock -= 1;
    }
    if (
      firstStatusBlock > 0 &&
      current[firstStatusBlock - 1].type === "text" &&
      current[firstStatusBlock - 1].text === "---"
    ) {
      firstStatusBlock -= 1;
    }
    insertionIndex = current[firstStatusBlock].startIndex;
    const deletionEnd = bodyEndIndex(document) - 1;
    if (deletionEnd > insertionIndex) {
      requests.push({
        deleteContentRange: {
          range: { startIndex: insertionIndex, endIndex: deletionEnd },
        },
      });
    }
  }
  requests.push(...statusInsertionRequests(insertionIndex, statusMarkdown));
  if (requests.length) {
    await services.docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests,
        writeControl: { requiredRevisionId: document.revisionId },
      },
    });
  }
  return getRemoteInfo(services, documentId);
}

async function appendTextBlocks(services, documentId, blocks) {
  if (!blocks.length) return;
  const document = await currentDocument(services, documentId);
  const startIndex = bodyEndIndex(document) - 1;
  const requests = insertionRequests(startIndex, blocks);
  await services.docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests,
      writeControl: { requiredRevisionId: document.revisionId },
    },
  });
}

function lastTable(document) {
  const tables = (bodyOf(document).content ?? []).filter((item) => item.table);
  return tables.at(-1);
}

async function appendTable(services, documentId, block) {
  if (!block.rows.length || !block.rows[0]?.length) return;
  const columns = Math.max(...block.rows.map((row) => row.length));
  await services.docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests: [
        {
          insertTable: {
            rows: block.rows.length,
            columns,
            endOfSegmentLocation: {},
          },
        },
      ],
    },
  });

  let document = await currentDocument(services, documentId);
  let table = lastTable(document)?.table;
  if (!table) throw new Error("Google Docs did not return the inserted table.");

  const insertions = [];
  for (let rowIndex = 0; rowIndex < block.rows.length; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < columns; columnIndex += 1) {
      const cell = table.tableRows[rowIndex].tableCells[columnIndex];
      const value = block.rows[rowIndex][columnIndex]?.text ?? "";
      if (value) {
        insertions.push({
          index: cell.startIndex + 1,
          request: {
            insertText: {
              location: { index: cell.startIndex + 1 },
              text: value,
            },
          },
        });
      }
    }
  }
  insertions.sort((a, b) => b.index - a.index);
  if (insertions.length) {
    await services.docs.documents.batchUpdate({
      documentId,
      requestBody: { requests: insertions.map((item) => item.request) },
    });
  }

  document = await currentDocument(services, documentId);
  table = lastTable(document)?.table;
  const styleRequests = [];
  for (let rowIndex = 0; rowIndex < block.rows.length; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < columns; columnIndex += 1) {
      const sourceCell = block.rows[rowIndex][columnIndex];
      if (!sourceCell) continue;
      const cell = table.tableRows[rowIndex].tableCells[columnIndex];
      styleRequests.push(
        ...inlineStyleRequests(cell.startIndex + 1, sourceCell.styles),
      );
    }
  }
  if (styleRequests.length) {
    await services.docs.documents.batchUpdate({
      documentId,
      requestBody: { requests: styleRequests },
    });
  }
}

export async function replaceDocumentFromMarkdown(
  services,
  documentId,
  markdown,
  { onProgress } = {},
) {
  const blocks = parseMarkdown(markdown);
  if (blocks.some(blockHasImages)) {
    throw new Error(
      "A full document rebuild containing inline images is not supported yet.",
    );
  }
  const tableCount = blocks.filter((block) => block.type === "table").length;
  let tableNumber = 0;
  const document = await currentDocument(services, documentId);
  const endIndex = bodyEndIndex(document);
  if (endIndex > 2) {
    await services.docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [
          {
            deleteContentRange: {
              range: { startIndex: 1, endIndex: endIndex - 1 },
            },
          },
        ],
      },
    });
  }
  for (let index = 0; index < blocks.length;) {
    const block = blocks[index];
    if (block.type === "table") {
      tableNumber += 1;
      onProgress?.({
        type: "writing-table",
        current: tableNumber,
        total: tableCount,
      });
      await appendTable(services, documentId, block);
      index += 1;
    } else {
      const end = blocks.findIndex(
        (candidate, candidateIndex) =>
          candidateIndex > index && candidate.type === "table",
      );
      const chunkEnd = end === -1 ? blocks.length : end;
      await appendTextBlocks(services, documentId, blocks.slice(index, chunkEnd));
      index = chunkEnd;
    }
  }
  if (internalLinks(blocks).length) {
    await reconcileHeadingLinks(services, documentId, markdown);
  }
  return getRemoteInfo(services, documentId);
}
