import { google } from "googleapis";
import { googleRequestTimeoutMs } from "./config.js";
import { parseMarkdown } from "./markdown.js";
import { DOC_STATUS_TITLE, stripRemoteDocumentStatus } from "./status.js";

export function createGoogleServices(
  auth,
  { timeout = googleRequestTimeoutMs() } = {},
) {
  return {
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
  for (const content of element.paragraph.elements ?? []) {
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
      text,
      styles,
      startIndex: element.startIndex,
      endIndex: element.endIndex,
    };
  }
  return {
    type: "text",
    paragraphStyle:
      element.paragraph.paragraphStyle?.namedStyleType ?? "NORMAL_TEXT",
    text,
    styles,
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
        return { text, styles };
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

function comparableBlock(block) {
  if (block.type === "table") {
    return {
      type: "table",
      rows: block.rows.map((row) =>
        row.map((cell) => ({ text: cell.text, styles: cell.styles })),
      ),
    };
  }
  return {
    type: block.type,
    ...(block.type === "text"
      ? { paragraphStyle: block.paragraphStyle }
      : { ordered: block.ordered }),
    text: block.text,
    styles: block.styles,
  };
}

function fingerprint(block) {
  return JSON.stringify(comparableBlock(block));
}

export function diffBlockHunks(current, desired) {
  const currentKeys = current.map(fingerprint);
  const desiredKeys = desired.map(fingerprint);
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

function insertionRequests(startIndex, blocks, { append = false } = {}) {
  const prefix = append && blocks.length ? "\n" : "";
  const text = `${prefix}${blocks.map((block) => `${block.text}\n`).join("")}`;
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
  for (const block of blocks) {
    const blockStart = startIndex + offset;
    const blockEnd = blockStart + block.text.length + 1;
    requests.push(...inlineStyleRequests(blockStart, block.styles));
    if (block.type === "text") {
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: blockStart, endIndex: blockEnd },
          paragraphStyle: { namedStyleType: block.paragraphStyle },
          fields: "namedStyleType",
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
    offset += block.text.length + 1;
  }
  return requests;
}

export function planIncrementalUpdate(
  document,
  markdown,
  { ignoreManagedStatus = false } = {},
) {
  const desired = parseMarkdown(markdown);
  assertResolvableHeadingLinks(desired);
  let current = withoutStructuralTableSpacers(
    blocksFromDocument(document, desired),
  );
  if (ignoreManagedStatus) {
    current = withoutManagedStatusBlocks(current);
  }
  const hunks = diffBlockHunks(current, desired);
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
    if (hunk.currentStart < hunk.currentEnd) {
      const rawEnd = current[hunk.currentEnd - 1].endIndex;
      const deletionEnd = Math.min(rawEnd, endIndex - 1);
      if (deletionEnd > insertionIndex) {
        requests.push({
          deleteContentRange: {
            range: { startIndex: insertionIndex, endIndex: deletionEnd },
          },
        });
      }
    }
    const desiredBlocks = desired.slice(hunk.desiredStart, hunk.desiredEnd);
    requests.push(
      ...insertionRequests(insertionIndex, desiredBlocks, {
        append:
          current.length > 0 &&
          hunk.currentStart === current.length &&
          hunk.currentStart === hunk.currentEnd,
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
  const requests = planHeadingLinkUpdate(document, markdown);
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
  { onProgress } = {},
) {
  const document = await currentDocument(services, documentId);
  const plan = planIncrementalUpdate(document, markdown);
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
  requests.push(...insertionRequests(insertionIndex, parseMarkdown(statusMarkdown)));
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
