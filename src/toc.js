import { parseMarkdown } from "./markdown.js";

export const GENERATED_TOC_START =
  "<!-- gdms:generated-toc:start | auto-generated from headings; edit headings, not this list -->";
export const GENERATED_TOC_END = "<!-- gdms:generated-toc:end -->";

export function documentHasNativeTableOfContents(document) {
  const body = document.body ?? document.tabs?.[0]?.documentTab?.body;
  return (body?.content ?? []).some((element) => element.tableOfContents);
}

function markerRange(markdown) {
  const start = markdown.indexOf(GENERATED_TOC_START);
  const end = markdown.indexOf(GENERATED_TOC_END);
  if ((start < 0) !== (end < 0)) {
    throw new Error(
      "The generated table of contents has only one GDMS marker. Restore both the start and end markers, or remove both.",
    );
  }
  if (start < 0) return undefined;
  if (end < start || markdown.indexOf(GENERATED_TOC_START, start + 1) >= 0 ||
      markdown.indexOf(GENERATED_TOC_END, end + 1) >= 0) {
    throw new Error("The generated table-of-contents markers are duplicated or out of order.");
  }
  return { start, end: end + GENERATED_TOC_END.length };
}

function headingSlugger() {
  const used = new Set();
  return (text) => {
    const base = text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "")
      .replace(/\s+/g, "-");
    let slug = base;
    let suffix = 0;
    while (used.has(slug)) slug = `${base}-${++suffix}`;
    used.add(slug);
    return slug;
  };
}

function tocEntries(markdown) {
  const slug = headingSlugger();
  return parseMarkdown(stripGeneratedTableOfContents(markdown))
    .filter((block) => block.type === "text" && /^HEADING_[1-6]$/.test(block.paragraphStyle))
    .map((block) => {
      const generatedFragment = `#${slug(block.text)}`;
      const fragment = block.headingFragment ?? generatedFragment;
      const label = block.text.replace(/([\\\[\]])/g, "\\$1");
      return `[${label}](${fragment})`;
    });
}

export function generatedTableOfContents(markdown) {
  return [
    GENERATED_TOC_START,
    "",
    "**Table of Contents**",
    "",
    ...tocEntries(markdown).flatMap((entry) => [entry, ""]),
    GENERATED_TOC_END,
  ].join("\n");
}

export function stripGeneratedTableOfContents(markdown) {
  const range = markerRange(markdown);
  if (!range) return markdown;
  return `${markdown.slice(0, range.start)}${markdown.slice(range.end)}`;
}

export function refreshGeneratedTableOfContents(markdown) {
  const range = markerRange(markdown);
  if (!range) return markdown;
  return `${markdown.slice(0, range.start)}${generatedTableOfContents(markdown)}${markdown.slice(range.end)}`;
}

function exportedNativeTocRange(markdown) {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const start = lines.findIndex((line) => /^\*\*Table of Contents\*\*\s*$/.test(line));
  if (start < 0) return undefined;
  const headingOffset = lines.slice(start + 1).findIndex((line) => /^#{1,6}\s/.test(line));
  if (headingOffset < 0) return undefined;
  return { lines, start, end: start + 1 + headingOffset };
}

export function representNativeTableOfContents(markdown) {
  const existing = markerRange(markdown);
  if (existing) return refreshGeneratedTableOfContents(markdown);
  const native = exportedNativeTocRange(markdown);
  if (!native) {
    throw new Error("Google Docs contains a native table of contents, but its Markdown position could not be identified.");
  }
  return [
    ...native.lines.slice(0, native.start),
    generatedTableOfContents(markdown),
    ...native.lines.slice(native.end),
  ].join("\n");
}

export function representNativeTableOfContentsFromRemote(markdown, remoteMarkdown) {
  if (markerRange(markdown)) return refreshGeneratedTableOfContents(markdown);
  const remote = exportedNativeTocRange(remoteMarkdown);
  if (!remote) {
    throw new Error("Google Docs contains a native table of contents, but its Markdown position could not be identified.");
  }
  const targetHeading = remote.lines[remote.end];
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const localExportRange = exportedNativeTocRange(markdown);
  if (localExportRange) {
    return [
      ...lines.slice(0, localExportRange.start),
      generatedTableOfContents(markdown),
      ...lines.slice(localExportRange.end),
    ].join("\n");
  }
  const headingIndex = lines.findIndex((line) => line === targetHeading);
  if (headingIndex < 0) {
    throw new Error("The local position corresponding to the native Google Docs table of contents could not be identified.");
  }
  return [
    ...lines.slice(0, headingIndex),
    generatedTableOfContents(markdown),
    "",
    ...lines.slice(headingIndex),
  ].join("\n");
}

export function restoreNativeTableOfContents(markdown, remoteMarkdown) {
  const generated = markerRange(markdown);
  const native = exportedNativeTocRange(remoteMarkdown);
  if (!generated || !native) return markdown;
  const remoteRange = native.lines.slice(native.start, native.end).join("\n");
  return `${markdown.slice(0, generated.start)}${remoteRange}${markdown.slice(generated.end)}`;
}

export function hasGeneratedTableOfContents(markdown) {
  return Boolean(markerRange(markdown));
}
