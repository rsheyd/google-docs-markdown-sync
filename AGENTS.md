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
  workflows. Route formatting semantics to `FORMATTING.md`, setup changes to
  `INSTALL.md`, and commands or service behavior to `OPERATIONS.md`; keep the
  README summary and links current when the broader product description changes.
- Update this file map whenever durable project files are added or renamed.
- Increase the version for user-visible changes and record them under that exact version in `CHANGELOG.md`; do not use an Unreleased section. Minor documentation, planning, template-copy, test-only, and internal-maintenance changes do not require a version bump unless they accompany a release. 

## File map

- `README.md`: Product concept, intended workflow, scope, and design principles.
- `INSTALL.md`: Prerequisites, Google authorization, first pairing, Finder and
  Raycast setup, R2 image staging, and pairing manifest reference.
- `OPERATIONS.md`: Service management, logs, heartbeat, timing, recovery, and
  troubleshooting guidance.
- `FORMATTING.md`: User-facing Markdown-to-Google-Docs formatting rules,
  examples, normalization behavior, and migration workflow.
- `CONTRIBUTING.md`: Development, validation, and post-change service restart
  instructions.
- `CHANGELOG.md`: User-visible changes organized by application release.
- `ROADMAP.md`: Ordered product and engineering direction, with links to
  detailed feature plans.
- `IMAGE-SYNC.md`: Design and phased implementation plan for R2-backed two-way
  inline image synchronization.
- `NAMESPACE-MIGRATION.md`: Compatibility and rollout plan for replacing the
  legacy application, launchd, and Keychain namespace.
- `PROJECT-STATUS.md`: Untracked working status, decisions, blockers, and next
  steps.
- `outreach/`: Durable drafts for project announcements and community posts.
- `.gitignore`: Generated dependency/build output exclusions.
- `LICENSE`: MIT license governing use and redistribution.
- `package.json`: Node service package, scripts, and runtime dependencies.
- `package-lock.json`: Locked Node service dependency graph.
- `src/`: Synchronization service, Google API integration, pairing registry,
  Markdown, image, R2 staging, migrations, and CSV conversion, Docs and Sheets adapters,
  CLI, launch-at-login and Finder Quick Action installers, and independent
  weekly Resend health heartbeat.
- `cloudflare/image-gateway-worker.js`: HMAC-authenticated, short-lived image
  fetch gateway backed by the private R2 staging bucket.
- `test/`: Node unit tests for portable manifests, Markdown conversion,
  synchronization, and heartbeat checks.
- `raycast-extension/`: Optional Raycast extension for active-browser document
  pairing.
- `examples/google-docs-sync.example.json`: Inert example workspace pairing
  file; its name intentionally does not match the live manifest scanner.
