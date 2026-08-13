# Changelog

All notable changes to this project are documented in this file.

## [0.3.1] - 2026-08-13

### Added

- Add a CSV Finder Quick Action that prompts for a spreadsheet name, safely
  groups same-directory CSV selections into a new collision-resistant local
  directory, creates one Google Sheets tab per file, and registers the result
  for ongoing two-way synchronization.
- Add a `create-sheet` CLI command for the same CSV-to-Google-Sheets workflow.

## [0.3.0] - 2026-08-11

### Added

- Add a Finder Quick Action installer so local-only Markdown files can create
  and pair Google Docs directly from Finder's right-click menu, including the
  bundle registration metadata and Services refresh required by macOS.

### Changed

- Derive the default workspace root from the current user's home directory,
  remove personal Raycast preference defaults, and require an explicit weekly
  heartbeat recipient.
- Use portable paths and example addresses throughout the public README.
- Standardize on **GDMS** as the human-facing shorthand for the project while
  retaining existing package names, paths, manifests, and service identifiers.
- Render ordinary Markdown paragraphs with consistent visual spacing in Google
  Docs without adding empty paragraphs or changing Markdown syntax.

- Represent Markdown and Google Docs inline images as explicit structural
  content with positions, remote object identity, dimensions, and source
  properties.
- Teach the incremental planner to preserve unchanged image-bearing blocks
  when both document representations contain corresponding structural image
  nodes.
- Download Google Docs inline PNG, JPEG, and GIF images into content-addressed
  sibling asset directories and replace native export placeholders with
  portable relative Markdown links.
- Include local asset bytes in change detection, watch managed asset files, and
  move asset directories with their paired Markdown files.
- Add private Cloudflare R2 staging with Keychain-backed credentials, an
  HMAC-authenticated Worker using 15-minute URLs, eager object deletion, and
  cleanup on URL generation or Google update failures.
- Insert, replace, and delete standalone Google Docs images from Markdown while
  preserving display dimensions on replacement.
- Stop with an image conflict when both sides changed since the shared
  document-level synchronization baseline.

### Safety

- Require a one-to-one match between native Markdown image placeholders and
  Docs API inline objects before materializing a pull.
- Refuse mixed text-and-image paragraph mutations and image-bearing full
  rebuilds until those layouts have dedicated request planning.

## [0.2.2] - 2026-08-11

### Changed

- Show Google Docs sync-status local file paths relative to the user's `~/dev`
  when the paired file is under that shared development root.

## [0.2.1] - 2026-08-11

### Changed

- Separate the managed Google Docs sync status from document content with two
  blank lines and a divider.
- Render the managed Google Docs sync status in italic, muted dark-gray text so
  it reads as automated metadata rather than document content.
