# AGENTS.md

## Project guidance

- Prefer atomic paragraph/list range patches; preserve unchanged document
  ranges, and use full rebuild only for changed table structure.
- Keep local-change handling debounced and all sync passes single-flight; use
  bounded exponential backoff for remote errors.
- Keep credentials, OAuth tokens, and machine-specific secrets out of Git.
- Keep tracked workspace pairing files portable: use relative Markdown paths
  and exclude hashes, revisions, timestamps, and tokens.
- Prefer a standard Markdown AST and explicit, testable Google Docs update
  requests over ad hoc text replacement.
- Update user-facing documentation in the same pass when changing visible sync
  behavior, defaults, supported content, commands, setup, or operational
  workflows. Route formatting semantics to `docs/formatting.md`, setup changes to
  `docs/installation.md`, and commands or service behavior to `docs/operations.md`; keep the
  README summary and links current when the broader product description changes.
- Update this file map whenever durable project files are added or renamed.
- Increase the version for a release containing user-visible changes and record those changes under that exact version in `CHANGELOG.md`; do not use an Unreleased section. Multiple changes developed for the same not-yet-released version should be consolidated under that version rather than triggering a new version for every change. Minor documentation, planning, template-copy, test-only, and internal-maintenance changes do not require a version bump unless they accompany a release.

## File map

- `README.md`: Product concept, intended workflow, scope, and design principles.
- `docs/installation.md`: Prerequisites, Google authorization, first pairing, Finder and
  Raycast setup, R2 image staging, and pairing manifest reference.
- `docs/operations.md`: Service management, logs, heartbeat, timing, recovery, and
  troubleshooting guidance.
- `docs/formatting.md`: User-facing Markdown-to-Google-Docs formatting rules,
  examples, normalization behavior, and migration workflow.
- `docs/faq.md`: Answers to common questions about sharing and synchronization.
- `CONTRIBUTING.md`: Development, validation, and post-change service restart
  instructions.
- `CHANGELOG.md`: User-visible changes organized by application release.
- `docs/roadmap.md`: Ordered product and engineering direction, with links to
  detailed feature plans.
- `docs/design/image-sync.md`: Design and phased implementation plan for R2-backed two-way
  inline image synchronization.
- `docs/design/namespace-migration.md`: Compatibility and rollout plan for replacing the
  legacy application, launchd, and Keychain namespace.
- `docs/design/scalable-wake-safe-sync.md`: Design and phased implementation plan for incremental remote polling, bounded concurrency, reconciliation, and sleep-safe sync lifecycle handling.
- `docs/design/managed-folder-sync.md`: Exploratory product and engineering
  design for explicitly enrolled local folder trees and bounded Drive subtrees.
- `PROJECT-STATUS.md`: Untracked working status, decisions, blockers, and next
  steps.
- `docs/images/`: User-facing documentation images referenced by project guides.
- `local-only/`: Git-excluded personal drafts, outreach material, and other
  machine-local working files.
- `local-only/openmagpie-gdms-setup.md`: Local runbook for using OpenMagpie to
  find and review public discussions where GDMS may be relevant.
- `.gitignore`: Generated dependency/build output exclusions.
- `LICENSE`: MIT license governing use and redistribution.
- `package.json`: Node service package, scripts, and runtime dependencies.
- `package-lock.json`: Locked Node service dependency graph.
- `scripts/create-github-release.sh`: Create the newest changelog release on GitHub after previewing and committing it.
- `src/`: Synchronization service, Google API integration, pairing registry,
  Markdown, image, R2 staging, migrations, and CSV conversion, Docs and Sheets adapters,
  CLI, launch-at-login and Finder Quick Action installers, and independent
  weekly Resend health heartbeat.
- `src/formatting.js`: Shared Google Docs paragraph-formatting rules and measurements.
- `src/recovery.js`: Safe local backup naming and Drive-trash restoration helpers for pairing recovery.
- `src/toc.js`: Generated Markdown representation and canonicalization for native Google Docs tables of contents.
- `src/macos.js`: Best-effort macOS integration for opening created Google URLs.
- `src/network.js`: Google API reachability gating and post-sleep network-settling helpers.
- `src/drive-changes.js`: Paginated Google Drive change discovery, cursor validation, and pairing filtering.
- `cloudflare/image-gateway-worker.js`: HMAC-authenticated, short-lived image
  fetch gateway backed by the private R2 staging bucket.
- `test/`: Node unit tests for portable manifests, Markdown conversion,
  synchronization, and heartbeat checks.
- `test/network.test.js`: Offline pause/resume and post-sleep network-settling coverage.
- `test/recovery.test.js`: Recovery backup collision and Drive restoration coverage.
- `test/dependencies.test.js`: Locked transitive-dependency security and compatibility invariants.
- `raycast-extension/`: Optional Raycast extension for active-browser document
  pairing.
- `examples/google-docs-sync.example.json`: Inert example workspace pairing
  file; its name intentionally does not match the live manifest scanner.
