# AGENTS.md

## Project guidance

- Keep the first version focused on reliable two-way synchronization using
  Google Docs' native Markdown export as the supported-subset boundary.
- Preserve the paired Google Doc ID and URL when pushing Markdown changes.
- Prefer atomic paragraph/list range patches; preserve unchanged document
  ranges, and use full rebuild only for changed table structure.
- Keep local-change handling debounced and all sync passes single-flight; use
  bounded exponential backoff for remote errors.
- Keep credentials, OAuth tokens, and machine-specific secrets out of Git.
- Keep tracked workspace pairing files portable: use relative Markdown paths
  and exclude hashes, revisions, timestamps, and tokens.
- Prefer a standard Markdown AST and explicit, testable Google Docs update
  requests over ad hoc text replacement.
- Update this file map whenever durable project files are added or renamed.

## File map

- `README.md`: Product concept, intended workflow, scope, and design principles.
- `CONTRIBUTING.md`: Development, validation, and post-change service restart
  instructions.
- `CHANGELOG.md`: User-visible changes organized by application release.
- `PROJECT-STATUS.md`: Untracked working status, decisions, blockers, and next
  steps.
- `.gitignore`: Generated dependency/build output exclusions.
- `package.json`: Node service package, scripts, and runtime dependencies.
- `package-lock.json`: Locked Node service dependency graph.
- `src/`: Synchronization service, Google API integration, pairing registry,
  Markdown and CSV conversion, Docs and Sheets adapters, CLI, launch-at-login
  installer, and independent weekly Resend health heartbeat.
- `test/`: Node unit tests for portable manifests, Markdown conversion,
  synchronization, and heartbeat checks.
- `raycast-extension/`: Personal Raycast extension for active-document pairing.
- `examples/google-docs-sync.example.json`: Inert example workspace pairing
  file; its name intentionally does not match the live manifest scanner.
