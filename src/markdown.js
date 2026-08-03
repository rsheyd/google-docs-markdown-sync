import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

const parser = unified().use(remarkParse).use(remarkGfm);

function renderInlineNodes(nodes, inherited = {}) {
  let text = "";
  const styles = [];

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
    } else if (node.type === "image") {
      append(node.alt ? `[${node.alt}]` : "", merged);
    } else if (node.children) {
      for (const child of node.children) visit(child, merged);
    }
  }

  for (const node of nodes ?? []) visit(node, inherited);
  return { text, styles };
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
  }
  return { text, styles };
}

function splitInlineLines(inline) {
  const lines = [];
  let start = 0;
  for (const text of inline.text.split("\n")) {
    const end = start + text.length;
    lines.push({
      text,
      styles: inline.styles
        .filter((range) => range.end > start && range.start < end)
        .map((range) => ({
          ...range,
          start: Math.max(range.start, start) - start,
          end: Math.min(range.end, end) - start,
        })),
    });
    start = end + 1;
  }
  return lines;
}

function appendTextLines(blocks, inline, properties) {
  for (const line of splitInlineLines(inline)) {
    blocks.push({ ...properties, ...line });
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
    },
    headingFragment: `#${match[1]}`,
  };
}

export function parseMarkdown(markdown) {
  const tree = parser.parse(markdown);
  const blocks = [];
  let previousEndLine = 0;
  for (const node of tree.children) {
    const startLine = node.position?.start.line ?? previousEndLine + 1;
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
  }
  return blocks;
}
