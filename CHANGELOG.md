# Changelog

All notable changes to this project are documented in this file.

## [0.8.1] - 2026-08-20

### Changed

- Rename the CSV Finder Quick Action to **Combine & Sync CSVs with New Google
  Sheet (GDMS)** so its new-spreadsheet, one-tab-per-CSV, ongoing-sync behavior
  is clear, remove the legacy ambiguously named workflow, and open the Quick
  Actions pane after installation so both GDMS actions can be enabled together.
- Escape action names in generated service plists so the ampersand in the CSV
  action name does not prevent macOS from registering it.
- Rename the Markdown Finder Quick Action to **Sync MDs with New Google Docs
  (GDMS)** so its accepted file type and one-new-Doc-per-file behavior are clear,
  and remove the previous workflow name when reinstalling the actions.
- Open a newly created Sheet or single Markdown-created Doc from Finder in the
  default browser; for multi-Markdown batches, avoid opening many tabs and show
  a completion notification instead. Add the reusable `--open` option to
  `gdms create` and `gdms create-sheet`.

## [0.8.0] - 2026-08-14

### Added

- Fall back to Google Docs API serialization when Drive refuses a native
  Markdown export because the document exceeds its export-size limit, covering
  supported headings, paragraphs, lists, inline styles, links, tables, and
  images during pairing and later pulls.
- Add `gdms recover --document-id ID --workspace PATH --file FILE` to restore
  the original Google Doc from Drive trash, preserve existing Markdown and
  managed assets under collision-safe timestamped backup names, recreate the
  pairing at its desired relative path, clear the deletion tombstone, and
  verify the recovered state.
- Add an operational recovery runbook and include an exact recovery command in
  new deletion-notification emails.

### Safety

- Restore the previous workspace manifest when an initial document pairing
  fails, so an error does not leave a new pairing entry without its Markdown
  file, and surface the CLI's specific stderr in the Raycast failure toast.
- Verify the original Drive file is accessible and outside trash before
  replacing the requested local path, and never overwrite local recovery
  content without first moving it and its assets to backup siblings.

## [0.7.2] - 2026-08-14

### Added

- Add resumable, per-document formatting migrations with all-pairs and
  single-document targeting, a non-writing dry run, failure isolation, and
  applied-version tracking in local runtime state.
- Add migration `0.3.2` to repair list spacing and ordered lists whose numbering
  was previously restarted for every item, and migration `0.4.1` to reconcile
  universal block-boundary spacing.
- Add an explicit `delete` command that moves a paired Google Doc to Drive
  trash, deletes its local Markdown and managed assets, removes the pairing,
  and emails a recovery notice.
- Add a machine-local global, opt-in `trash-after-grace-period` policy with
  durable missing-file timers, move/restoration cancellation, resumable trash
  state, and idempotent Resend notification retries.
- Add a globally linked `gdms` executable as the primary user interface, with
  first-class `help`, `--help`, `version`, and `--version` forms.
- Add a consolidated command reference covering arguments, effects, and write
  scope for every GDMS command.
- Show per-pairing current/total progress and a final action summary for
  `gdms sync-once`, using an in-place terminal line and stable redirected
  output.
- Record the running daemon version, PID, and start time in machine-local state.
- Compare the loaded daemon version with `package.json` before each polling
  cycle and exit cleanly on a change so LaunchAgent `KeepAlive` loads the new
  code automatically.

### Changed

- Keep ordered Markdown list items in one Google Docs numbering sequence
  instead of restarting every item at one, and add standard paragraph spacing
  after the final list item without adding space between items.
- Treat a standard blank line between top-level Markdown blocks as one
  universal visual gap while keeping hard breaks and list items compact.
- Request Drive write authorization for recoverable trash operations. Existing
  installations must authorize again after upgrading.
- Prefer `gdms` throughout user documentation while retaining npm scripts as
  development and recovery fallbacks.
- Make `gdms sync-once` exit unsuccessfully after completing the pass when any
  pairing reports an error.
- Replace user-facing `defer` logs with policy-aware `missing-local` messages,
  report the exact maximum move-detection wait and remaining deletion grace
  time, and make trash completion explicit.
- Prefix every background-daemon output and error message with an ISO 8601
  timestamp using the machine's current UTC offset while keeping interactive
  `sync-once` progress concise.
- Make `gdms --version` and `gdms version` report both the checked-out CLI
  version and the live daemon version, including a short-lived restart-pending
  warning when they differ.
- Use `~/dev` as the conventional default for repositories and Codex
  workspaces, preserve an explicit `GOOGLE_DOCS_SYNC_ROOT` in the installed
  service, and keep the root configurable in Raycast.
- Generalize the Raycast pairing workflow for Safari and common Chromium
  browsers, remove its machine-specific Node path, and use project-oriented
  author and workspace wording.
- Replace user-specific absolute paths in test fixtures and describe the
  phased migration away from legacy `com.roman` service identifiers.

### Fixed

- Let missing-file move detection proceed once its deadline is reached even
  when a full sync pass takes longer than the detection window, and never run
  move detection again after the durable deletion grace period has started.
- Clear completed deletion tombstones when the same Google Doc is paired again
  so an old deadline cannot affect the new pairing.

### Safety

- Keep missing-file restoration as the default, require a configured deletion
  email recipient before automatic trash, and limit deletion propagation to
  Markdown/Google Docs pairings for now.

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
