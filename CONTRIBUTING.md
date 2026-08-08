# Contributing

- [Contributing](#contributing)
  - [Before making a change](#before-making-a-change)
  - [Bump the version](#bump-the-version)
  - [Validate the change](#validate-the-change)
  - [Make the change affect future syncing](#make-the-change-affect-future-syncing)
  - [Confirm the service is running](#confirm-the-service-is-running)


## Before making a change

Install dependencies with Node.js 22 or newer:

```sh
npm install
```

Keep changes focused on the supported synchronization model described in
`README.md`. In particular, Google Docs' native Markdown export defines the
supported Markdown subset, and updates should preserve the paired Google Doc
rather than replace it.

For Google Sheets, CSV files are the supported content boundary. Preserve the
spreadsheet and sheet IDs; formatting, charts, comments, filters, and protected
ranges are not represented in CSV.

Add or update tests for behavior changes. The synchronization planner can be
tested without writing to a live Google Doc.

## Bump the version

The synchronization service and Raycast extension currently share one semantic
version. Choose the next patch, minor, or major version and update both packages
without creating an automatic Git commit or tag:

```sh
release_version=0.2.0
npm version "$release_version" --no-git-tag-version
npm --prefix raycast-extension version "$release_version" --no-git-tag-version
```

These commands update `package.json` and `package-lock.json` in both the project
root and `raycast-extension/`. Confirm that the package versions agree:

```sh
npm pkg get version
npm --prefix raycast-extension pkg get version
```

Review the resulting diff and include all four package and lock files in the
version-bump commit. Do not change the numeric `version` fields in
`google-docs-sync.json`, `.google-sheets-sync.json`, or their examples; those
are data-format schema versions, not application release versions.

## Validate the change

Run the complete project check:

```sh
npm run check
```

This checks the service's JavaScript, runs the Node test suite, and type-checks
the Raycast extension.

For a quick service-only test run:

```sh
npm test
```

To inspect a proposed update without changing a Google Doc:

```sh
npm run cli -- plan --document-id DOCUMENT_ID
```

## Make the change affect future syncing

The LaunchAgent runs the source files in this checkout directly. There is no
separate build, package, or deployment step for synchronization-service
changes. However, an already-running Node process does not reload changed
source files.

After changing anything under `src/`, restart the installed service with:

```sh
npm run install-service
```

That command rewrites the LaunchAgent configuration, stops the existing
daemon, and starts it again with the current source. Existing Google
authorization and document pairings remain in place.

If the service is running manually with `npm run sync`, stop it with
<kbd>Control</kbd>+<kbd>C</kbd> and run `npm run sync` again instead.

No restart is needed after changes limited to tests, documentation, examples,
or Markdown files being synchronized. Local Markdown edits are picked up
automatically by the running service.

The managed Markdown footer, Google Doc footer, spreadsheet `↔ Sync Status`
tab, and local `SYNC-STATUS.md` are synchronization UI, not user content. Keep
them excluded from canonical content hashes and tab/CSV reconciliation, and
preserve the self-repair behavior when changing synchronization code.

Changes under `raycast-extension/` do not require restarting the sync daemon.
Run the extension in Raycast development mode to load those changes:

```sh
cd raycast-extension
npm run dev
```

## Confirm the service is running

After restarting, make a small edit to a paired Markdown file and confirm it
appears in the same Google Doc. For a non-writing connectivity check, run:

```sh
npm run heartbeat
```

Service output and errors are written under:

```text
~/Library/Application Support/google-docs-markdown-sync/
```

Do not commit OAuth clients, tokens, API keys, logs, or other
machine-specific secrets.
