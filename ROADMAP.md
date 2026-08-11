# Roadmap

This roadmap describes the intended direction of the project. It is ordered by
dependency and risk rather than by promised release dates.

## Now: reliable core synchronization

- Keep Google Docs and Markdown pairings convergent under routine local and
  remote edits.
- Add explicit unpairing and a command that lists every registered pairing.
- Improve conflict visibility while retaining the current
  later-modification-wins policy.
- Continue live validation of incremental paragraph, list, link, table, and
  status updates.

## Next: two-way inline image synchronization

Synchronize screenshots and other inline images alongside each Markdown file.
Remote images will be downloaded into a portable sibling asset directory;
local images will be staged briefly in Cloudflare R2 so the Google Docs API can
fetch and copy them into the paired document.

Google Docs → Markdown image extraction and local asset management are live.
R2 staging and image-aware Markdown → Google Docs requests are implemented for
standalone image paragraphs. The private bucket, lifecycle rule, authenticated
Worker fetch gateway, and live add/replace/delete round trip are complete.

The implementation plan, storage convention, safety rules, and rollout phases
are documented in [IMAGE-SYNC.md](IMAGE-SYNC.md).

## Later: safer conflicts and broader fidelity

- Create recoverable conflict copies and user-visible notifications when both
  sides change incompatibly.
- Add explicit orphaned-asset review and cleanup tooling.
- Evaluate support for floating images, cropping, rotation, drawings, and
  linked charts after inline image synchronization is reliable.
- Improve operational diagnostics, health reporting, and recovery guidance.

## Out of scope for the current roadmap

- General-purpose Google Drive mirroring.
- Permanent public hosting of document images.
- Pixel-perfect round-tripping of every Google Docs visual object.
- Synchronizing unpaired documents or arbitrary workspace files.
