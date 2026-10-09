// Same-file header metadata. Keep body parsing independent from header content.
export function splitHeader(markdown) {
  const lines = markdown.split("\n");
  let fence;
  let start = -1;
  let end = -1;
  let pages;
  let alignment = "START";
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    const fenced = line.match(/^(`{3,}|~{3,})/);
    if (fenced) {
      if (!fence) fence = fenced[1];
      else if (fenced[1][0] === fence[0] && fenced[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (fence || !line.startsWith("<!-- gdms:header")) continue;
    if (line === "<!-- gdms:header:end -->") {
      if (start < 0 || end >= 0) throw new Error("Unexpected GDMS header end marker.");
      end = i;
      continue;
    }
    const match = line.match(/^<!-- gdms:header pages="(first|all)"(?: align="(START|CENTER|END|JUSTIFIED)")? -->$/);
    if (!match || start >= 0 || lines.slice(0, i).some(value => value.trim())) {
      throw new Error('Use one GDMS header block at the start of the file with pages="first" or pages="all".');
    }
    start = i;
    pages = match[1];
    alignment = match[2] ?? "START";
  }
  if (start < 0) return { body: markdown, header: null };
  if (end < 0) throw new Error("GDMS header block is missing its end marker.");
  return { header: { pages, alignment, markdown: lines.slice(start + 1, end).join("\n") + "\n" }, body: lines.slice(end + 1).join("\n").replace(/^\n+/, "") };
}

export function headerSource(document) {
  const source = document.body ? document : document.tabs?.[0]?.documentTab;
  if (!source) return null;
  const style = document.documentStyle ?? source.documentStyle ?? {};
  const headers = source.headers ?? document.headers ?? {};
  const populated = id => Boolean(id && headers[id]?.content?.some(element =>
    element.table || element.paragraph?.elements?.some(item => item.inlineObjectElement || item.textRun?.content?.trim()),
  ));
  const sectionBreaks = (source.body?.content ?? []).filter(element => element.sectionBreak);
  if (Object.keys(headers).length && (style.useEvenPageHeaderFooter || populated(style.evenPageHeaderId) || sectionBreaks.length > 1)) {
    throw new Error("GDMS headers do not support alternating-page or section-specific layouts.");
  }
  if (style.useFirstPageHeaderFooter && populated(style.defaultHeaderId)) {
    throw new Error("GDMS cannot represent different first-page and repeating headers together.");
  }
  const pages = style.useFirstPageHeaderFooter && style.firstPageHeaderId ? "first" : "all";
  const id = pages === "first" ? style.firstPageHeaderId : style.defaultHeaderId;
  if (!id || !headers[id] || !populated(id)) return null;
  const content = headers[id].content ?? [];
  if (content.some(element => !element.paragraph || element.paragraph.positionedObjectIds?.length || element.paragraph.elements?.some(item => (!item.textRun && !item.inlineObjectElement)))) {
    throw new Error("GDMS headers support paragraphs and inline images only.");
  }
  const alignments = [...new Set(content.filter(element => element.paragraph?.elements?.some(item => item.inlineObjectElement || item.textRun?.content?.trim())).map(element => element.paragraph.paragraphStyle?.alignment ?? "START"))];
  if (alignments.length > 1) throw new Error("GDMS headers currently require one paragraph alignment throughout the header.");
  return { id, pages, alignment: alignments[0] ?? "START", content, style, source };
}

export function headerDocument(document, header = headerSource(document)) {
  return header ? { ...document, ...header.source, body: { content: header.content }, headers: {}, documentStyle: {}, tabs: undefined } : null;
}

export function joinHeader(header, body) {
  if (!header) return body;
  const align = header.alignment && header.alignment !== "START" ? ` align="${header.alignment}"` : "";
  return `<!-- gdms:header pages="${header.pages}"${align} -->\n${header.markdown.trimEnd()}\n<!-- gdms:header:end -->\n\n${body}`;
}
