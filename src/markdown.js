import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

const parser = unified().use(remarkParse).use(remarkGfm);
export const INLINE_IMAGE_MARKER = "\uFFFC";
export const PARAGRAPH_SPACE_BELOW_PT = 8;
const GOOGLE_IMAGE_REFERENCE_PREFIX = "gdocs-image-reference:";

function normalizeGoogleImageReferences(markdown) {
  return markdown.replace(
    /!\[([^\]]*)\]\[(image\d+)\]/gi,
    (_match, alt, identifier) =>
      `![${alt}](${GOOGLE_IMAGE_REFERENCE_PREFIX}${identifier})`,
  );
}

function renderInlineNodes(nodes, inherited = {}) {
  let text = "";
  const styles = [];
  const images = [];

  function append(value, style) {
    const start = text.length;
    text += value;
    if (value && Object.keys(style).length) {
      styles.push({ start, end: text.length, style });
    }
  }

  function visit(node, style) {
    const merged = { ...style };
    if (node.type === "strong") merged.bold = true;
    if (node.type === "emphasis") merged.italic = true;
    if (node.type === "delete") merged.strikethrough = true;
    if (node.type === "link") merged.link = node.url;

    if (node.type === "text" || node.type === "inlineCode") {
      append(node.value, merged);
    } else if (node.type === "break") {
      append("\n", merged);
    } else if (node.type === "image" || node.type === "imageReference") {
      const offset = text.length;
      append(INLINE_IMAGE_MARKER, {});
      images.push({
        offset,
        alt: node.alt ?? "",
        ...(node.type === "image"
          ? node.url.startsWith(GOOGLE_IMAGE_REFERENCE_PREFIX)
            ? { reference: node.url.slice(GOOGLE_IMAGE_REFERENCE_PREFIX.length) }
            : {
                url: node.url,
                ...(node.title ? { title: node.title } : {}),
              }
          : { reference: node.identifier ?? node.label }),
        ...(merged.link ? { link: merged.link } : {}),
      });
    } else if (node.children) {
      for (const child of node.children) visit(child, merged);
    }
  }

  for (const node of nodes ?? []) visit(node, inherited);
  return { text, styles, ...(images.length ? { images } : {}) };
}

function listItemInline(item) {
  const parts = [];
  for (const child of item.children ?? []) {
    if (child.type === "paragraph" || child.type === "heading") {
      parts.push(renderInlineNodes(child.children));
    }
  }
  if (!parts.length) return { text: "", styles: [] };
  let text = "";
  const styles = [];
  const images = [];
  for (const [index, part] of parts.entries()) {
    if (index) text += "\n";
    const offset = text.length;
    text += part.text;
    styles.push(
      ...part.styles.map((range) => ({
        ...range,
        start: range.start + offset,
        end: range.end + offset,
      })),
    );
    images.push(
      ...(part.images ?? []).map((image) => ({
        ...image,
        offset: image.offset + offset,
      })),
    );
  }
  return { text, styles, ...(images.length ? { images } : {}) };
}

function splitInlineLines(inline) {
  const lines = [];
  let start = 0;
  for (const text of inline.text.split("\n")) {
    const end = start + text.length;
    const images = (inline.images ?? [])
      .filter((image) => image.offset >= start && image.offset < end)
      .map((image) => ({ ...image, offset: image.offset - start }));
    lines.push({
      text,
      styles: inline.styles
        .filter((range) => range.end > start && range.start < end)
        .map((range) => ({
          ...range,
          start: Math.max(range.start, start) - start,
          end: Math.min(range.end, end) - start,
        })),
      ...(images.length ? { images } : {}),
    });
    start = end + 1;
  }
  return lines;
}

function appendTextLines(blocks, inline, properties) {
  const lines = splitInlineLines(inline);
  for (const line of lines) {
    blocks.push({
      ...properties,
      ...line,
    });
  }
}

function appendList(blocks, list, nestingLevel = 0) {
  for (const item of list.children ?? []) {
    appendTextLines(blocks, listItemInline(item), {
      type: "listItem",
      ordered: Boolean(list.ordered),
      nestingLevel,
    });
    for (const child of item.children ?? []) {
      if (child.type === "list") appendList(blocks, child, nestingLevel + 1);
    }
  }
}

function headingInline(node) {
  const inline = renderInlineNodes(node.children);
  const match = inline.text.match(/\s+\{#([^}]+)\}$/);
  if (!match) return { inline, headingFragment: undefined };
  const text = inline.text.slice(0, match.index);
  return {
    inline: {
      text,
      styles: inline.styles
        .filter((range) => range.start < text.length)
        .map((range) => ({
          ...range,
          end: Math.min(range.end, text.length),
        })),
      ...(inline.images?.length
        ? {
            images: inline.images.filter((image) => image.offset < text.length),
          }
        : {}),
    },
    headingFragment: `#${match[1]}`,
  };
}

export function parseMarkdown(markdown) {
  const tree = parser.parse(normalizeGoogleImageReferences(markdown));
  const blocks = [];
  let previousEndLine = 0;
  let previousBlockEnd = 0;
  for (const node of tree.children) {
    const startLine = node.position?.start.line ?? previousEndLine + 1;
    if (
      previousEndLine &&
      startLine > previousEndLine + 1 &&
      previousBlockEnd > 0 &&
      ["text", "listItem"].includes(blocks[previousBlockEnd - 1]?.type)
    ) {
      blocks[previousBlockEnd - 1].paragraphSpaceBelow =
        PARAGRAPH_SPACE_BELOW_PT;
    }
    const blankLines = previousEndLine
      ? Math.max(0, startLine - previousEndLine - 2)
      : 0;
    for (let index = 0; index < blankLines; index += 1) {
      blocks.push({
        type: "text",
        paragraphStyle: "NORMAL_TEXT",
        text: "",
        styles: [],
      });
    }

    if (node.type === "heading") {
      const { inline, headingFragment } = headingInline(node);
      appendTextLines(blocks, inline, {
        type: "text",
        paragraphStyle: `HEADING_${node.depth}`,
        ...(headingFragment ? { headingFragment } : {}),
      });
    } else if (node.type === "paragraph") {
      appendTextLines(blocks, renderInlineNodes(node.children), {
        type: "text",
        paragraphStyle: "NORMAL_TEXT",
      });
    } else if (node.type === "list") {
      appendList(blocks, node);
    } else if (node.type === "table") {
      blocks.push({
        type: "table",
        rows: node.children.map((row) =>
          row.children.map((cell) => renderInlineNodes(cell.children)),
        ),
      });
    } else if (node.type === "blockquote") {
      const value = node.children
        .filter((child) => child.type === "paragraph")
        .map((child) => renderInlineNodes(child.children).text)
        .join("\n");
      appendTextLines(blocks, { text: value, styles: [] }, {
        type: "text",
        paragraphStyle: "NORMAL_TEXT",
      });
    } else if (node.type === "code") {
      appendTextLines(blocks, { text: node.value, styles: [] }, {
        type: "text",
        paragraphStyle: "NORMAL_TEXT",
      });
    } else if (node.type === "thematicBreak") {
      blocks.push({
        type: "text",
        paragraphStyle: "NORMAL_TEXT",
        text: "---",
        styles: [],
      });
    }
    previousEndLine = node.position?.end.line ?? startLine;
    previousBlockEnd = blocks.length;
  }
  return blocks;
}
