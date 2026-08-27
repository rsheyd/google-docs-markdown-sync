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
  const headings = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^#{1,6}\s+(.+?)\s*$/);
    if (!match) continue;
    const explicit = match[1].match(/^(.*?)\s+\{#([^}]+)\}\s*$/);
    const text = explicit ? explicit[1] : match[1];
    headings.push({ text, index });
  }

  const linkPattern = /^\s*\[(.+)\]\((#[^)]+)\)\s*$/;
  const candidates = [];
  for (let start = 0; start < lines.length; start += 1) {
    if (!linkPattern.test(lines[start])) continue;
    let end = start;
    const links = [];
    while (end < lines.length) {
      const match = lines[end].match(linkPattern);
      if (match) links.push({ label: match[1].replace(/\\([\[\]\\])/g, "$1"), index: end });
      else if (lines[end].trim() !== "") break;
      end += 1;
    }
    if (links.length === 0) continue;
    let previousHeading = end - 1;
    const matchesHeadings = links.every(({ label }) => {
      const heading = headings.find(({ text, index }) => index > previousHeading && text === label);
      if (!heading) return false;
      previousHeading = heading.index;
      return true;
    });
    if (matchesHeadings) {
      let rangeStart = start;
      while (rangeStart > 0 && lines[rangeStart - 1].trim() === "") rangeStart -= 1;
      if (rangeStart > 0 && /^#{1,6}\s*$/.test(lines[rangeStart - 1])) rangeStart -= 1;
      let rangeEnd = end;
      if (rangeEnd < lines.length && /^#{1,6}\s*$/.test(lines[rangeEnd])) rangeEnd += 1;
      while (rangeEnd < lines.length && lines[rangeEnd].trim() === "") rangeEnd += 1;
      candidates.push({
        lines,
        start: rangeStart,
        end: rangeEnd,
        contentStart: start,
        contentEnd: end,
        linkCount: links.length,
      });
    }
    start = Math.max(start, end - 1);
  }
  return candidates.sort((left, right) => right.linkCount - left.linkCount || left.start - right.start)[0];
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
  const remotePrefixIsEmpty = remote.lines
    .slice(0, remote.start)
    .every((line) => line.trim() === "" || /^#{1,6}\s*$/.test(line));
  if (remotePrefixIsEmpty) {
    return `${generatedTableOfContents(markdown)}\n\n${markdown}`;
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
  const remoteRange = native.lines
    .slice(native.contentStart, native.contentEnd)
    .filter((line) => line.trim() !== "")
    .join("\n\n");
  return `${markdown.slice(0, generated.start)}${remoteRange}${markdown.slice(generated.end)}`;
}

export function hasGeneratedTableOfContents(markdown) {
  return Boolean(markerRange(markdown));
}
