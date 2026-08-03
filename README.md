# Google Docs/Sheets ↔ Markdown/CSV Sync

A personal macOS tool for pairing native Google Docs with Markdown files and
Google Sheets with CSV directories in local Codex workspaces.

- [Google Docs ↔ Markdown Sync](#google-docs--markdown-sync)
  - [Intended experience](#intended-experience)
  - [Version-one behavior](#version-one-behavior)
  - [Components](#components)
  - [Pairing files](#pairing-files)
  - [Synchronization semantics](#synchronization-semantics)
  - [Google authorization](#google-authorization)
  - [Commands](#commands)
  - [Product principles](#product-principles)


## Intended experience

1. Create and edit a document with `docs.new`.
2. Press a global keyboard shortcut.
3. Search for a project folder under `/Users/roman/dev` with autocomplete.
4. Confirm or edit the suggested Markdown filename.
5. The tool creates the `.md` file and remembers the pairing.
6. Later edits automatically synchronize in both directions.

Only explicitly paired documents are synchronized. Repositories, source files,
and dependencies are not copied to Google Drive.

Google Sheets pairings use one local directory per spreadsheet and one CSV file
per tab. Formulas are written to CSV in their `=...` form and sent back with
`USER_ENTERED` semantics. Raw values and formulas round-trip; formatting,
charts, comments, filters, notes, validation, and protected ranges remain in
Google Sheets and are not represented locally. Adding or deleting a CSV adds or
deletes its corresponding tab. A spreadsheet must always retain at least one
CSV tab.

Every pairing also carries a human-readable managed sync status. Google Docs
show a small status section at the bottom, while the paired Markdown file shows
an equivalent footer with a link back to the Doc. Google Sheets use a dedicated
`↔ Sync Status` tab and a local `SYNC-STATUS.md` file. These artifacts show the
last successful sync time and direction, are excluded from content comparison,
and are recreated on a later sync pass if deleted. Removing a status artifact
does not unpair its document or spreadsheet.

## Version-one behavior

Google Docs' native Markdown export defines the Google Docs → Markdown subset.
The service saves that export without applying its own placeholder or
normalization rules.

Markdown → Google Docs supports the structures produced by the native export,
including headings, paragraphs, ordered and unordered lists, links, bold,
italics, and simple tables. The service compares Markdown blocks with the
current Google Doc and applies changed paragraph/list ranges in one atomic API
batch, retaining the document ID and URL. Unchanged ranges are left in place.
Markdown fragment links to headings become native Google Docs heading links.
The native export's `{#fragment}` heading suffixes are retained as sync metadata
and are not inserted as visible document text. When a changed sync pass creates
new headings, the service applies content first and then resolves the
Google-assigned heading IDs in a second atomic batch.

Native Google Docs tables of contents round-trip through the Markdown export
without being rebuilt or duplicated. Their exported Markdown range is
preserved as read-only because the Docs API does not expose a request for
creating or updating a native table of contents. A ToC authored in Markdown is
represented instead as ordinary text or list items with working native heading
links.

A single blank line separates Markdown blocks without creating an empty Google
Docs paragraph. Each additional consecutive blank line becomes one explicit
empty paragraph. Markdown hard breaks become adjacent Google Docs paragraphs.

Comments and suggestions are not represented in Markdown. Content that Google
omits from its Markdown export can be lost if its surrounding Markdown range is
subsequently changed. Incremental updates reduce disruption to anchored
comments and suggestions by preserving unchanged ranges, but comments anchored
inside a replaced range can still be affected.

Changed table structure currently falls back to a full-document rebuild because
Google Docs table indexes cannot be safely patched with the paragraph differ.
Unchanged tables are preserved during edits elsewhere.

For the first version, simultaneous-edit conflict handling is deliberately out
of scope. The implementation should nevertheless record synchronization
metadata so conflict handling can be added later without changing the pairing
model.

## Components

- A personal Raycast extension provides the global shortcut, reads the active
  Chrome Google Doc or Sheet URL, searches folders below `/Users/roman/dev`,
  and registers the chosen Markdown filename or CSV directory.
- A Node background service watches paired Markdown files locally and polls
  paired Google Docs.
- The Drive API's `files.export` endpoint supplies native Markdown.
- The Docs API updates the body of the same document from a parsed Markdown AST.
- The Sheets API reads formulas and values and updates the existing spreadsheet.
- A user LaunchAgent starts the service after login.

## Pairing files

Each participating workspace tracks a visible `google-docs-sync.json` file:

```json
{
  "version": 1,
  "pairings": [
    {
      "documentId": "GOOGLE_DOCUMENT_ID",
      "documentUrl": "https://docs.google.com/document/d/GOOGLE_DOCUMENT_ID/edit",
      "markdownPath": "notes/example.md",
      "name": "Example"
    },
    {
      "type": "spreadsheet",
      "spreadsheetId": "GOOGLE_SPREADSHEET_ID",
      "spreadsheetUrl": "https://docs.google.com/spreadsheets/d/GOOGLE_SPREADSHEET_ID/edit",
      "directoryPath": "data/budget",
      "name": "Budget"
    }
  ]
}
```

Paths are relative to the pairing file. Do not put OAuth tokens, content
hashes, revision IDs, or timestamps in this tracked file.

Each spreadsheet directory contains `.google-sheets-sync.json`, a portable tab
ID-to-filename map maintained by the service, and the human-readable managed
`SYNC-STATUS.md`. Do not edit the JSON file manually.

Machine-specific runtime state is stored under:

`~/Library/Application Support/google-docs-markdown-sync/`

OAuth refresh tokens are stored in the macOS Keychain.

## Synchronization semantics

- A missing local Markdown file is initialized from the native export after one
  polling grace interval, allowing filesystem moves to be recognized first.
- Local file changes are detected every 250 ms, debounced for 750 ms, and then
  synchronized immediately.
- Moving a paired Markdown file anywhere within the same workspace
  automatically updates its relative path in the pairing file. Moves that copy
  and delete the file, cross filesystems, or leave the workspace are not
  auto-adopted.
- Google Docs changes are polled every 5 seconds.
- Google Sheets changes use the same polling, debounce, single-flight, and
  latest-modification-wins behavior as Docs.
- Managed status artifacts are excluded from synchronized content and hashes.
  If only a status artifact is missing or edited, the service repairs it rather
  than treating that edit as document content.
- Local and remote passes are serialized so they cannot update shared state
  concurrently.
- Failed remote polls back off exponentially, with jitter, to a maximum
  60-second delay.
- A remote-only change pulls the native export.
- When a paired Google Doc title changes, its Markdown file is renamed in the
  same directory using the Raycast lowercase kebab-case naming convention, and
  the tracked pairing is updated. The rename is skipped if its destination
  already exists.
- A local-only change incrementally updates changed ranges in the same Google
  Doc.
- If both sides changed, the side with the later filesystem/Drive modification
  timestamp wins.
- Writes are hashed and revision-tracked to avoid feedback loops.
- Conflict copies and interactive conflict resolution are deferred.

## Google authorization

Create an OAuth 2.0 Desktop application in a Google Cloud project with the
Google Drive, Google Docs, and Google Sheets APIs enabled. Download its client
JSON outside the repository. The default location is:

`~/Library/Application Support/google-docs-markdown-sync/oauth-client.json`

For another location, set:

```sh
export GOOGLE_DOCS_SYNC_OAUTH_CLIENT="/absolute/path/to/client_secret.json"
```

The service requests read access to Drive, Docs access for same-document
updates, and Sheets access for same-spreadsheet updates. Existing installations
must run `npm run auth` once after upgrading to grant the new Sheets scope.
Google OAuth apps left in external “Testing” status issue refresh tokens that
expire after seven days; an unattended personal daemon should use an
appropriately configured production consent screen.

Run the initial authorization:

```sh
npm install
npm run auth
```

## Commands

```sh
# Create and pair a Google Doc from an existing Markdown file. The workspace
# defaults to the file's directory. The Doc title defaults to the filename with
# hyphens changed to spaces, each word capitalized, and the current month
# appended (for example, "Example Note - Aug 2026").
npm run cli -- create \
  --file "notes/example.md" \
  --name "Example"

# Register the active document after obtaining its URL
npm run cli -- pair \
  --url "https://docs.google.com/document/d/DOCUMENT_ID/edit" \
  --workspace "/Users/roman/dev/example-project" \
  --file "notes/example.md"

# Pair a spreadsheet as one CSV file per tab
npm run cli -- pair-sheet \
  --url "https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit" \
  --workspace "/Users/roman/dev/example-project" \
  --directory "data/budget"

# Run one synchronization pass
npm run sync:once

# Preview the Google Docs update plan without writing
npm run cli -- plan --document-id DOCUMENT_ID

# Explicitly push a paired spreadsheet directory
npm run cli -- push --spreadsheet-id SPREADSHEET_ID

# Remove only generated empty paragraphs from a paired Google Doc. The command
# refuses to write if it detects any non-spacing content difference.
npm run cli -- cleanup-spacing --document-id DOCUMENT_ID

# Run continuously
npm run sync

# Install and start the per-user LaunchAgent
npm run install-service
```

## Weekly health heartbeat

An independent LaunchAgent can send a weekly success email after confirming
that the synchronization daemon is running and every paired Google Doc can be
read through the API. Because this process is separate from the sync daemon,
the absence of its expected email is a dead-man warning.

The Resend API token is stored in macOS Keychain under service
`com.roman.google-docs-markdown-sync`, account `resend-api`; it is never placed
in the repository or LaunchAgent plist. Install the Monday 9:00 AM local-time
heartbeat with:

```sh
npm run install-heartbeat -- --to "s.roman@gmail.com"
```

Run an immediate health check and send a test email with:

```sh
npm run heartbeat -- --to "s.roman@gmail.com"
```

The default sender is `Google Docs Sync <onboarding@resend.dev>`. If Resend
requires a verified custom sender, reinstall with
`--from "Google Docs Sync <sync@your-verified-domain>"`.

Optional timing overrides:

```sh
export GOOGLE_DOCS_SYNC_DEBOUNCE_MS=750
export GOOGLE_DOCS_SYNC_INTERVAL_MS=5000
export GOOGLE_DOCS_SYNC_REQUEST_TIMEOUT_MS=30000
```

The request timeout prevents a stalled Google API or OAuth request from
blocking the single-flight sync queue indefinitely. Timed-out passes use the
same bounded retry backoff as other remote failures.

The Raycast extension lives in `raycast-extension/`. Install its dependencies
and register it with Raycast in development mode:

```sh
cd raycast-extension
npm install
npm run dev
```

Keep that command running while using the development extension. `npm run
build` only compiles the extension; it does not register the command in
Raycast's Extensions settings.

Raycast extensions cannot declare a default global hotkey / shortcut. Assign one manually:

1. Open Raycast Settings.
2. Select **Extensions**.
3. Search for **Google Docs and Sheets Sync** or **Pair Google Doc or Sheet**.
4. Select **Pair Google Doc or Sheet**.
5. Record a hotkey in the **Hotkey** field.

Recommended hotkey: **Command–Shift-M**.

With a Google Doc or Sheet active in Chrome, press that hotkey and choose a
workspace folder. For a Doc, confirm the suggested Markdown filename. For a
Sheet, confirm the directory that will contain one CSV file per tab.

## Product principles

- Creating a document should continue to start with `docs.new`.
- Registration should take only one shortcut and one folder selection.
- Synchronization should feel automatic after registration.
- The Google Doc remains the rich review surface; Markdown remains the
  Codex-friendly local representation.
- Pairing configuration should be visible to Codex and portable with the
  workspace; credentials and runtime bookkeeping should not be.
