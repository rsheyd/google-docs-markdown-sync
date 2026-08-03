export const MARKDOWN_STATUS_START = "<!-- google-docs-sync:status:start -->";
export const MARKDOWN_STATUS_END = "<!-- google-docs-sync:status:end -->";
export const DOC_STATUS_TITLE = "↔ Markdown sync status";
export const SHEET_STATUS_TITLE = "↔ Sync Status";
export const SHEET_STATUS_FILE = "SYNC-STATUS.md";

function displayTime(iso) {
  if (!iso) return "Not yet synchronized";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

function directionLabel(writer, spreadsheet = false) {
  if (writer === "markdown") return "Markdown → Google Docs";
  if (writer === "google-docs") return "Google Docs → Markdown";
  if (writer === "csv") return "CSV → Google Sheets";
  if (writer === "google-sheets") return "Google Sheets → CSV";
  return spreadsheet ? "Google Sheets ↔ CSV" : "Google Docs ↔ Markdown";
}

export function stripMarkdownStatus(markdown) {
  const start = markdown.indexOf(MARKDOWN_STATUS_START);
  if (start < 0) return markdown;
  const end = markdown.indexOf(MARKDOWN_STATUS_END, start);
  if (end < 0) return markdown.slice(0, start).trimEnd() + "\n";
  return (
    markdown.slice(0, start) +
    markdown.slice(end + MARKDOWN_STATUS_END.length)
  ).trimEnd() + "\n";
}

export function hasMarkdownStatus(markdown) {
  return markdown.includes(MARKDOWN_STATUS_START) && markdown.includes(MARKDOWN_STATUS_END);
}

export function stripDocumentStatus(markdown) {
  return stripRemoteDocumentStatus(stripMarkdownStatus(markdown));
}

export function documentStatusMarkdown(pairing, state) {
  const url = pairing.documentUrl ?? `https://docs.google.com/document/d/${pairing.documentId}/edit`;
  const content = stripDocumentStatus(state.content ?? "").trimEnd();
  const status = [
    MARKDOWN_STATUS_START,
    "---",
    `*${DOC_STATUS_TITLE}*`,
    `*Last successful sync: ${displayTime(state.lastSuccessfulSync)} · ${directionLabel(state.lastWriter)}*`,
    `*[Google Doc](${url}) · Local file: \`${pairing.markdownPath}\`*`,
    MARKDOWN_STATUS_END,
  ].join("\n");
  return `${content}${content ? "\n\n" : ""}${status}\n`;
}

export function remoteDocumentStatusMarkdown(pairing, state) {
  return [
    "---",
    `*${DOC_STATUS_TITLE}*`,
    `*Last successful sync: ${displayTime(state.lastSuccessfulSync)} · ${directionLabel(state.lastWriter)}*`,
    `*Local file: \`${pairing.markdownPath}\`*`,
  ].join("\n");
}

export function stripRemoteDocumentStatus(markdown) {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const plain = (line) => line.trim().replace(/^[_*]+|[_*]+$/g, "").trim();
  const titleIndex = lines.findLastIndex((line) => plain(line) === DOC_STATUS_TITLE);
  if (
    titleIndex < 0 ||
    !lines.slice(titleIndex + 1).some((line) =>
      plain(line).startsWith("Last successful sync:"),
    )
  ) {
    return markdown;
  }
  let start = titleIndex;
  while (start > 0 && !lines[start - 1].trim()) start -= 1;
  if (start > 0 && /^\\?---\s*$/.test(lines[start - 1].trim())) start -= 1;
  return `${lines.slice(0, start).join("\n").trimEnd()}\n`;
}

export function hasRemoteDocumentStatus(document) {
  const content = document.body?.content ?? document.tabs?.[0]?.documentTab?.body?.content ?? [];
  return content.some((element) =>
    (element.paragraph?.elements ?? []).some((part) =>
      String(part.textRun?.content ?? "").includes(DOC_STATUS_TITLE),
    ),
  );
}

export function spreadsheetStatusMarkdown(pairing, state) {
  const url = pairing.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${pairing.spreadsheetId}/edit`;
  return [
    "# ↔ Google Sheets sync status",
    "",
    `- Spreadsheet: [${pairing.name ?? "Google Sheet"}](${url})`,
    `- Local directory: \`${pairing.directoryPath}\``,
    `- Last successful sync: ${displayTime(state.lastSuccessfulSync)}`,
    `- Direction: ${directionLabel(state.lastWriter, true)}`,
    "",
    "This file is managed by google-docs-markdown-sync. Deleting it does not unpair the spreadsheet.",
    "",
  ].join("\n");
}

export function spreadsheetStatusValues(pairing, state) {
  return [
    ["↔ Google Sheets sync status", ""],
    ["Last successful sync", displayTime(state.lastSuccessfulSync)],
    ["Direction", directionLabel(state.lastWriter, true)],
    ["Local directory", pairing.directoryPath],
    ["Managed by", "google-docs-markdown-sync"],
  ];
}
