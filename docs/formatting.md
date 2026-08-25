# Markdown formatting in Google Docs

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

GDMS applies list formatting to the list range rather than inserting literal
number or bullet characters. Editing the Markdown list may therefore normalize
manually customized Google Docs list glyphs within the changed range.

## Headings and other paragraph styles

Markdown headings use the corresponding native Google Docs named styles,
`Heading 1` through `Heading 6`. The universal block-gap rule controls spacing
below the heading when Markdown contains a blank line; other aspects of the
heading's appearance come from the Google Doc's named-style definition.

Ordinary Markdown paragraphs use `Normal text`. Bold, italic, strikethrough,
and links are applied as inline styles where supported.

Markdown blockquotes use `Normal text` with a modest left indent. Separate quoted paragraphs and explicit hard line breaks remain separate paragraphs in Google Docs; no additional decorative styling is applied.

## Tables of contents

An ordinary static Markdown table of contents is regular synchronized content.
For example, `[Planning](#planning)` is sent to Google Docs as a heading link
and is not rewritten by GDMS.

When the Google Doc contains a native Google Docs table of contents, GDMS keeps
that native element in Google Docs and represents it locally as a generated
Markdown range:

```md
<!-- gdms:generated-toc:start | auto-generated from headings; edit headings, not this list -->

**Table of Contents**

[Planning](#planning)

[Communication](#communication)

<!-- gdms:generated-toc:end -->
```

The entries are generated from the Markdown headings. Edit the headings rather
than the generated list; GDMS replaces changes inside the marked range during
the next sync. The markers are invisible in rendered Markdown, and the visible
content remains a normal linked table of contents.

The local generated list and the native Google Docs table of contents are
independent views. GDMS does not rewrite the native element or its links. After
heading changes synchronize, refresh the native table of contents in Google
Docs if you want its displayed entries updated immediately. To remove a native
table of contents, delete it in Google Docs; removing only the generated local
range does not request that structural deletion.

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

Google Docs' native Markdown export normally defines much of the supported
round-trip subset. If Drive rejects a large document with its export-size
limit, GDMS serializes supported headings, paragraphs, lists, tables, inline
styles, links, and images from the Google Docs API instead. Advanced layout,
floating images, drawings, and other Docs-only visual effects are not
represented by either path. Tables also have structural spacing requirements
of their own and do not yet use the universal text-block gap rule.

See the [README](../README.md#supported-content-and-important-limits) for the full
supported-content summary and current limitations.
