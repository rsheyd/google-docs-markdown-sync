# Formatting in Google Docs and Sheets

## Google Sheets formatting

CSV files represent cell values and formulas only. Google Sheets remains the source of truth for presentation and native spreadsheet structure, including number and date formats, fonts, colors, borders, conditional formatting, validation, notes, protected ranges, frozen rows and columns, filters, charts, and native tables.

GDMS applies local CSV changes with typed, value-only cell updates. It does not ask Sheets to reinterpret every CSV field as newly entered text, so existing date, currency, percentage, duration, and other number formats remain attached to changed cells. Cells removed from a CSV have only their values cleared.

Native Google Sheets tables remain native and keep their names, column types, validation, header and footer settings, colors, and banding. When a CSV adds rows or columns beyond an existing table boundary, GDMS expands that table to contain the new data. It does not automatically shrink a table when CSV content becomes smaller, avoiding the removal of intentional blank table rows or footer behavior.

A formatting-only change in Google Sheets advances the synchronized remote revision without rewriting an unchanged CSV file. Because CSV has no formatting representation, local edits cannot create, delete, or restyle native Sheets features.

Each paired spreadsheet directory contains one visible `GDMS.md` sidecar. Its readable section summarizes synchronization status and recorded structure; its marked JSON block stores the portable tab mapping, number formats, compact ranges for bold, italic, underline, and strikethrough text, column types, and native-table definitions. GDMS manages this file and excludes it from CSV content comparison. Existing hidden `.google-sheets-sync.json` and `SYNC-STATUS.md` files are combined into `GDMS.md` during synchronization.

Normal CSV pushes never reapply the recorded text styles, so a newer formatting edit made directly in Sheets is not overwritten by stale metadata. GDMS uses the saved ranges when it creates a replacement tab from recorded CSV metadata. Other visual properties—including fonts, sizes, colors, borders, alignment, and conditional formatting—remain Sheets-only.

## Google Docs formatting

GDMS treats Markdown structure as the source of truth for supported Google Docs
formatting. It uses native Google Docs paragraph styles and lists, plus targeted
paragraph spacing, rather than inserting decorative empty paragraphs.

## Blank lines create visual block gaps

A standard blank line between top-level Markdown blocks creates one 8-point
visual gap in Google Docs. The gap belongs to the block before the blank line.

For example:

```md
### Planning and platform setup

- Short kickoff conversation
- Review and selection
```

The Heading 3 paragraph receives 8 points of space below it. The list items stay
compact because there are no blank lines between them.

The same rule applies between supported text-based top-level blocks:

- paragraph → paragraph;
- heading → paragraph or list;
- paragraph or list → heading;
- list → paragraph or another top-level block; and
- blockquotes, code blocks, and thematic breaks → the following block.

The final block in a Markdown file does not receive trailing spacing merely
because it is the final block.

## Line breaks and additional blank lines

A hard line break inside one Markdown paragraph does not create a visual block
gap:

```md
First line  
Second line
```

One blank line is ordinary Markdown block separation and becomes the standard
8-point gap. Additional blank lines are preserved as explicit empty paragraphs,
so deliberately larger separations remain visible.

Blank lines inside a list do not currently create separate spacing between list
items. GDMS keeps list internals compact and applies the block gap only after the
final item when another top-level block follows.

## Lists

Consecutive ordered Markdown items become one native Google Docs numbered list,
so their displayed markers continue as `1`, `2`, `3`, and so on. Unordered
Markdown items become native Google Docs bullets. Nested items retain their
nesting level.

GDMS applies list formatting to the list range rather than inserting literal number or bullet characters. Editing the Markdown list may therefore normalize manually customized Google Docs list glyphs within the changed range.

List paragraphs are also normalized to `Normal text` so an adjacent heading's named style cannot leak into the list and export as heading markers inside bullets.
This applies to both newly inserted and already-existing list items; heading styles are reserved for explicit Markdown heading syntax.

## Headings and other paragraph styles

Markdown headings use the corresponding native Google Docs named styles,
`Heading 1` through `Heading 6`. The universal block-gap rule controls spacing
below the heading when Markdown contains a blank line; other aspects of the
heading's appearance come from the Google Doc's named-style definition.

Ordinary Markdown paragraphs use `Normal text`. Bold, italic, strikethrough,
and links are applied as inline styles where supported.

Markdown blockquotes use `Normal text` with a modest left indent. Separate quoted paragraphs and explicit hard line breaks remain separate paragraphs in Google Docs; no additional decorative styling is applied.

## Tables

GFM tables synchronize as native Google Docs tables. When every Google Docs column has a fixed width, GDMS records those API-native point widths in an invisible HTML comment immediately before the table:

```md
<!-- gdms:table-column-widths: 90pt, 270pt, 180pt -->
| Dates | Work | Input |
| --- | --- | --- |
```

The marker remains invisible in rendered Markdown. Editing its point values updates only the corresponding Google Docs column widths; it does not rebuild an otherwise unchanged table. Each value must be at least `5pt`, as required by the Google Docs API, and the number of values must equal the number of table columns. A marker must immediately precede its table.

Tables whose columns use Google Docs' evenly distributed mode do not receive width metadata. To begin managing their widths from Markdown, add a valid fixed-width marker or resize the columns in Google Docs so the API reports fixed widths.

Explicit breaks inside table cells use inline HTML `<br>` elements because a physical Markdown newline would end the table row. Consecutive breaks remain consecutive, so an empty paragraph between two populated cell paragraphs round-trips as `<br><br>`. Inline bold, italic, strikethrough, links, and images retain their positions across these breaks. Automatic visual wrapping is not stored as breaks; Google Docs recalculates it from the synchronized column width.

## Tables of contents

An ordinary static Markdown table of contents is regular synchronized content. For example, `[Planning](#planning)` is sent to Google Docs as a heading link and is not rewritten by GDMS.

GDMS identifies a native table of contents from the Google Docs document structure, then locates its Markdown export by matching the exported heading links to the document headings. A nearby `Table of Contents` label is ordinary user-authored content: GDMS preserves it but does not use it to detect the native element or generate another label. The native element appears locally as a generated Markdown range:

```md
<!-- gdms:generated-toc:start | auto-generated from headings; edit headings, not this list -->

[Planning](#planning)

[Communication](#communication)

<!-- gdms:generated-toc:end -->
```

The entries are generated from the Markdown headings. Edit the headings rather than the generated list; GDMS replaces changes inside the marked range during the next sync. The markers are invisible in rendered Markdown, and the visible content remains a normal linked table of contents.

The local generated list and the native Google Docs table of contents are independent views. GDMS does not rewrite the native element or its links. After heading changes synchronize, refresh the native table of contents in Google Docs if you want its displayed entries updated immediately. To remove a native table of contents, delete it in Google Docs; removing only the generated local range does not request that structural deletion.

## Synchronization and normalization

GDMS stores visual block separation as Google Docs paragraph `space below`, not
as generated empty paragraphs. This keeps list numbering stable and produces a
cleaner two-way Markdown representation.

On a later synchronization pass, GDMS may reconcile supported paragraph spacing
even when the text itself has not changed. Manual Google Docs spacing that
disagrees with the paired Markdown blank lines can therefore be normalized. GDMS
uses targeted paragraph or list ranges and does not rebuild unrelated content.

Formatting migrations apply newly introduced rules to existing pairs. Preview
pending migrations before applying them:

```sh
npm run cli -- migrate --all --dry-run
npm run cli -- migrate --all
```

See the [operations guide](operations.md#apply-formatting-migrations) for targeting one
document, resumability, and failure behavior.

## Current boundaries

Google Docs' native Markdown export normally defines much of the supported round-trip subset. If Drive rejects a large document with its export-size limit, GDMS serializes supported headings, paragraphs, lists, tables, inline styles, links, and images from the Google Docs API instead. Advanced layout, floating images, drawings, and other Docs-only visual effects are not represented by either path. Fixed table column widths are the supported exception to general advanced layout: GDMS preserves them with the metadata described above. Tables also have structural spacing requirements of their own and do not yet use the universal text-block gap rule.

See the [README](../README.md#supported-content-and-important-limits) for the full
supported-content summary and current limitations.
