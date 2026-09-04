# Changelog

All notable changes to this project are documented in this file.

## [0.8.9] - 2026-09-04

### Changed

- Apply CSV changes through typed, value-only Google Sheets updates so existing date, currency, percentage, duration, validation, conditional formatting, and other native cell properties remain intact.
- Preserve native Google Sheets tables during CSV synchronization, expanding their ranges for added CSV rows or columns without automatically shrinking them.
- Treat formatting-only Google Sheets revisions as metadata changes without rewriting unchanged local CSV files.
- Consolidate the hidden spreadsheet tab map and local status page into one visible `GDMS.md` file, automatically migrating legacy sidecars and recording portable number formats, column types, and native-table structure.
- Record compact Google Sheets bold, italic, underline, and strikethrough ranges in `GDMS.md`, and restore them when recreating a tab without overwriting live formatting during ordinary CSV pushes.

## [0.8.8] - 2026-09-02

### Changed

- Load registered sync-location manifests directly during routine daemon polling instead of recursively searching configured folders every five seconds.
- Describe manifest-owning folders as sync locations in user-facing documentation and Raycast, and replace separate project/archive preferences with one persistent, addable list whose locations all use the same lazy folder browser.
- Record the installed CLI, Node, and OAuth paths during service installation so Raycast can use them without exposing runtime plumbing as preferences.
- Use sync-location and discovery-root terminology throughout current code and documentation, prefer `--sync-location` in the CLI, and retain `--workspace` as a compatibility alias.
- Complete Phase 1 of the [unified sync-location registry design](docs/design/unified-sync-location-registry.md): add shared versioned location and manifest registries, migrate legacy discovery state without deleting it, add location-management CLI commands, reconstruct missing indexes from configured locations, and remove recursive discovery from daemon polling.
- Complete Phase 2 of the [unified sync-location registry design](docs/design/unified-sync-location-registry.md): make Raycast use the same registry with one-time migration, removal previews, and explicit pairing scans, and move service logs to the standard macOS Logs directory with compatibility migration.

## [0.8.7] - 2026-09-01

### Fixed

- Adopt moved Markdown files correctly when their workspace manifest also contains Google Sheets pairings, instead of leaving the old path pending deletion.

## [0.8.6] - 2026-08-31

### Added

- Round-trip fixed Google Docs table-column widths through invisible `gdms:table-column-widths` Markdown metadata using the API-native point values, and apply width-only edits without rebuilding table content.
- Round-trip explicit and consecutive line breaks inside table cells as inline Markdown `<br>` elements while preserving inline formatting across the breaks.
- Add a **Sync Paired File Now (GDMS)** Finder Quick Action and targeted `gdms sync-once --file FILE` support for immediately reconciling selected Markdown/Google Docs pairings, refreshing their successful-sync timestamps, and reporting the result in a completion or error dialog.

### Fixed

- Normalize inserted list paragraphs to `Normal text` so adjacent heading styles do not produce stray Markdown heading markers inside list items.
- Repair existing list paragraphs whose Google Docs named style disagrees with ordinary Markdown list syntax, while preserving inline bold and other text formatting.

## [0.8.5] - 2026-08-27

### Changed

- Represent Markdown blockquotes in Google Docs with a modest left indent while preserving separate quoted paragraphs and explicit hard line breaks.
- Show configuration, shutdown, and startup progress while installing or restarting the synchronization service.
- Pause scheduled and local-change synchronization without reporting pairing errors when the Google API hostname is unreachable, and resume automatically when connectivity returns.
- Detect polling timers delayed by likely laptop sleep and allow the network to settle before checking connectivity or issuing Google requests.
- Detect likely laptop sleep independently of polling, discard interrupted synchronization results before state and notification handling, wait 15 seconds for post-wake networking to settle, and start a fresh pass without sending sleep-induced error or recovery email.
- Poll unchanged Google Docs with one lightweight Drive metadata request, fetching the complete Docs structure only after a local change, remote Drive-version change, missing baseline, or status and formatting work that requires document details.
- Poll the Google Drive changes feed during routine daemon cycles and synchronize only paired Docs or Sheets reported as changed, keeping quiet polling cost constant as the pairing count grows.
- Save the Drive changes cursor only after targeted synchronization succeeds, replay uncommitted changes after interruption or restart, and recover an expired cursor through a complete reconciliation without creating per-pairing discovery incidents.
- Run a complete reconciliation every 24 hours, record its completion in machine-local state and heartbeat output, and retain sequential targeted processing after scale and live latency measurements showed no need for concurrent state mutation.

### Fixed

- Identify native Google Docs tables of contents from the Docs structure and their exported heading-link sequence instead of requiring a user-authored `Table of Contents` label. Preserve labels as ordinary content, handle Google's unlabeled empty-heading wrappers and extra export spacing, and recover a missing leading local TOC range even when the following heading changed.

## [0.8.4] - 2026-08-25

### Changed

- Poll only the lightweight Drive revision for unchanged Google Sheets
  pairings, fetching Sheets metadata and tab values only after a local or
  remote change.
- Classify sync failures as temporary connectivity or needing attention.
  Preserve active failure and sent-email markers across service restarts,
  group changing timeout and DNS messages into the same incident, and wait at
  least 30 minutes before emailing about temporary connectivity failures.
- Include the failed spreadsheet operation, elapsed time, and available error
  code in daemon diagnostics.

### Fixed

- Serialize same-file JSON writes and use collision-safe temporary filenames
  so overlapping runtime-state or pairing-index writes cannot race for the same
  temporary file and terminate the daemon.

## [0.8.3] - 2026-08-23

### Changed

- Represent native Google Docs tables of contents locally as marked Markdown
  TOCs generated from current headings. Ignore changes inside the generated
  range and preserve the native Docs element during pushes, while leaving
  unmarked static Markdown TOCs as ordinary synchronized content.

### Fixed

- Repair bold, italic, strikethrough, link, and paragraph-spacing drift during
  otherwise unchanged sync passes without replacing document text.

## [0.8.2] - 2026-08-23

### Fixed

- Avoid false image-conflict stops when Google changes only a document revision
  token without changing its Drive modification time, such as during native
  table-of-contents or metadata normalization.
- Treat a remote revision and modification-time change as metadata-only when
  normalized remote content and image bytes still match the shared baseline,
  allowing a concurrent local-only edit to push safely.
- Repair the shared baseline when a document-body update succeeded before a
  later table-of-contents reconciliation failed, comparing normalized remote
  images and bytes instead of incompatible raw Markdown and asset-aware hashes.
- Exclude native table-of-contents links from Markdown heading-link validation
  and rewriting because Google manages those ranges.
- Ignore API-only structural spacer paragraphs around and within native tables
  of contents while still refusing changes to their visible entries.
- Normalize a changed Markdown TOC back to the current remote-managed native
  TOC during a push, allowing valid body additions to synchronize without
  attempting an unsupported Google Docs TOC rewrite.
- Report each distinct daemon sync error once instead of repeating it every
  polling cycle, and announce when the affected pairing recovers.

### Added

- Keep desktop error/recovery notifications off by default because transient
  banners are not a durable operational record. Installing weekly health email
  stores one shared recipient and
  enables persistent sync-error email to that address after 15 minutes by
  default; add `gdms configure-notifications` for recipient, delay, and opt-out
  changes, plus automatic migration from existing heartbeat LaunchAgents. Send
  a recovery email only when the corresponding persistent-error email was sent.

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
