# Roadmap

This roadmap describes the intended direction of the project. It is ordered by
dependency and risk rather than by promised release dates.

## Completed foundation

- Keep registered Google Docs/Markdown and Google Sheets/CSV pairings
  synchronized through the background service.
- Apply routine paragraph, list, link, table, status, and standalone-image
  changes while preserving unchanged document ranges.
- Download remote inline images into portable sibling asset directories and
  push local standalone images through short-lived private R2 staging.
- Create and pair Google Docs from Markdown and Google Sheets from one or more
  CSV files through Finder Quick Actions.

The image implementation, storage convention, safety rules, live-validation
results, and remaining work are documented in the [image synchronization design](design/image-sync.md).

## Now: operational hardening

- Keep Google Docs and Markdown pairings convergent under routine local and
  remote edits.
- Add actionable image-sync logs and health checks without exposing secrets or
  signed staging URLs.
- Exercise retry, timeout, crash-recovery, partial-upload, and R2-cleanup paths.
- Continue live validation with screenshot-heavy documents containing both
  text paragraphs and supported standalone-image paragraphs.
- Continue live validation of incremental paragraph, list, link, table, and
  status updates.

## Next: safer conflicts and pairing controls

- Add explicit unpairing and a command that lists every registered pairing.
- Improve conflict visibility while retaining the current
  later-modification-wins policy for text-only documents.
- Create recoverable conflict copies and user-visible notifications when both
  sides change incompatibly.
- Refine the current document-level image conflict stop into per-image
  baselines if routine use shows that the coarse check is too restrictive.

## Next: application namespace migration

- Introduce `io.github.rsheyd.google-docs-markdown-sync` identifiers with
  dual-read Keychain compatibility and non-destructive credential copying.
- Make the service installer replace legacy launchd jobs without allowing old
  and new daemons to run together, while retaining rollback-safe credentials.
- Remove legacy identifiers only after a documented compatibility window and
  an explicit cleanup path.

The phases, rollback guarantees, affected identifiers, and validation plan are
documented in the [namespace migration plan](design/namespace-migration.md).

## Later: broader fidelity

- Add explicit orphaned-asset review and cleanup tooling.
- Evaluate support for floating images, cropping, rotation, drawings, and
  linked charts after inline image synchronization is reliable.
- Support safe mutations of mixed text-and-image paragraphs and image-bearing
  full document rebuilds.

## Later: folder auto-sync

- Evaluate opt-in synchronization of whole folders containing Markdown and CSV
  files, with a preview before initial enrollment.
- Define repository-local include and exclude rules so generated files,
  dependencies, fixtures, vendored content, hidden directories, and other
  unsuitable files are not paired accidentally.
- Keep folder enrollment visible and reviewable in each workspace manifest,
  and define predictable behavior for new, moved, renamed, and deleted files.
- Establish Drive organization, API-load limits, conflict recovery, and bulk
  unpairing before enabling unattended discovery or remote document creation.

## Out of scope for the current roadmap

- General-purpose Google Drive mirroring.
- Permanent public hosting of document images.
- Pixel-perfect round-tripping of every Google Docs visual object.
- Synchronizing unpaired documents or arbitrary workspace files outside an
  explicitly configured folder auto-sync scope.
