# Operating GDMS

## Service management

The installed LaunchAgent runs source files from this checkout directly. After
changing anything under `src/`, or after changing R2 configuration, restart it:

```sh
npm run install-service
```

The command rewrites the LaunchAgent configuration, stops the existing daemon,
and starts it again. Authorization and pairings are preserved. Documentation,
tests, examples, and synchronized content changes do not require a restart.

For temporary foreground operation:

```sh
npm run sync
```

Stop it with <kbd>Control</kbd>+<kbd>C</kbd>. Do not run a foreground daemon at
the same time as the LaunchAgent.

Run one synchronization pass without starting the daemon:

```sh
npm run sync:once
```

## Health checks

Confirm that the daemon is running and that every paired Google Doc and Sheet
is readable:

```sh
npm run heartbeat
```

This command sends email only when a recipient is provided or configured. For
a non-writing preview of a Google Docs update plan:

```sh
npm run cli -- plan --document-id DOCUMENT_ID
```

To push one pairing explicitly:

```sh
npm run cli -- push --document-id DOCUMENT_ID
npm run cli -- push --spreadsheet-id SPREADSHEET_ID
```

## Logs

Service output and errors are stored in:

```text
~/Library/Application Support/google-docs-markdown-sync/service.log
~/Library/Application Support/google-docs-markdown-sync/service-error.log
```

Inspect recent entries with:

```sh
tail -n 50 "$HOME/Library/Application Support/google-docs-markdown-sync/service.log"
tail -n 50 "$HOME/Library/Application Support/google-docs-markdown-sync/service-error.log"
```

Machine-specific runtime state is stored in the same application-support
directory. OAuth and R2 credentials are stored in macOS Keychain.

## Weekly health heartbeat

An independent LaunchAgent can send a weekly success email after checking the
sync daemon and every paired Google Doc and Sheet. Because it is separate from
the daemon, a missing expected email acts as a dead-man warning.

Store a Resend API token in Keychain under service
`com.roman.google-docs-markdown-sync`, account `resend-api`, then install the
Monday 9:00 AM local-time heartbeat:

```sh
npm run install-heartbeat -- --to "you@example.com"
```

Run an immediate check and test email with:

```sh
npm run heartbeat -- --to "you@example.com"
```

The default sender is `Google Docs Sync <onboarding@resend.dev>`. If Resend
requires a verified sender, reinstall with:

```sh
npm run install-heartbeat -- --to "you@example.com" \
  --from "Google Docs Sync <sync@your-verified-domain>"
```

## Synchronization timing

Defaults are a 250 ms local stat interval, a 750 ms debounce, a five-second
Google polling interval, and a 30-second request timeout. Optional overrides:

```sh
export GOOGLE_DOCS_SYNC_DEBOUNCE_MS=750
export GOOGLE_DOCS_SYNC_INTERVAL_MS=5000
export GOOGLE_DOCS_SYNC_REQUEST_TIMEOUT_MS=30000
```

Local and remote passes are serialized. Remote failures retry with exponential
backoff and jitter up to 60 seconds. The request timeout prevents a stalled
Google API or OAuth request from blocking the queue indefinitely.

## Synchronization semantics

- A missing local Markdown file is initialized from Google native export after
  one polling grace interval so filesystem moves can be recognized first.
- Moving a paired Markdown file within its workspace updates the manifest.
  Moves that copy and delete the file, cross filesystems, leave the workspace,
  or collide with an existing destination are not adopted automatically.
- Renaming a paired Google Doc renames its Markdown file in the same directory
  using lowercase kebab case, unless the destination already exists.
- A local-only change updates the same Google document. A remote-only change
  updates the local representation.
- Simultaneous text-only changes use the later filesystem or Drive
  modification time. Image-bearing documents stop with a conflict when both
  sides changed from the shared baseline.
- Writes are hashed and revision-tracked to prevent feedback loops. Pairings
  share one single-flight synchronization queue.

Google Docs native Markdown export defines the supported pull representation.
On push, GDMS applies changed paragraph and list ranges in descending order in
one atomic Docs batch. Unchanged ranges and tables remain in place. A changed
table structure falls back to a full body rebuild unless the document contains
images, in which case GDMS refuses the unsafe rebuild.

Ordinary Markdown paragraphs receive 8 pt of visual spacing in Google Docs
without creating Markdown-visible blank paragraphs. Each additional
consecutive blank line becomes an explicit empty Docs paragraph. Markdown hard
breaks become adjacent paragraphs without the added spacing. Headings, lists,
tables, and managed status content retain their native spacing.

Markdown fragment links become native Docs heading links. New headings require
a second atomic batch after Google assigns their heading IDs. Native Google
Docs tables of contents are preserved as read-only exported ranges because the
Docs API cannot create or update them. A table of contents authored in Markdown
becomes ordinary linked text or list items instead.

Comments and suggestions are not represented in Markdown. Incremental updates
preserve anchors in unchanged ranges, but an anchor inside a replaced range can
be affected. Content omitted by Google's native Markdown export can be lost if
its surrounding range is later replaced from Markdown.

## Managed status artifacts

Google Docs show a small managed status section and Markdown files show an
equivalent footer with a link back to the Doc. Sheets use a `↔ Sync Status` tab
and local `SYNC-STATUS.md`. They show the last successful synchronization time
and direction and are excluded from content comparison.

Deleting or editing a status artifact does not unpair the document. GDMS
repairs it on a later pass. Explicit unpairing is not implemented yet.

## Recovery and troubleshooting

### The service is not running

Run `npm run install-service`, then inspect the error log. The LaunchAgent uses
absolute paths to this checkout and its Node executable, so reinstall it after
either path changes.

### Authorization stops working after seven days

Google OAuth applications in external **Testing** mode issue expiring refresh
tokens. Configure the consent screen appropriately for an unattended personal
service, then run `npm run auth` again.

### A synchronization pass reports an image conflict

GDMS stops when both sides of an image-bearing document changed since their
shared baseline. Compare the Google Doc with the Markdown file and its asset
directory before choosing which content to retain. GDMS does not yet create an
automatic conflict copy.

### A Markdown image cannot be pushed

Confirm that the image is in the Markdown file's managed sibling asset
directory, is PNG, JPEG, or GIF, and appears in a standalone image paragraph.
Local additions and replacements also require the private R2 bucket and Worker
configuration from [INSTALL.md](INSTALL.md#configure-image-staging).

### A table edit is refused

Changed table structure requires a full Docs body rebuild. GDMS refuses that
rebuild when the document contains images. Make the table change in Google Docs
or separate the image-bearing content before retrying.

### Remove generated spacing paragraphs

The cleanup command refuses to write when any non-spacing content differs:

```sh
npm run cli -- cleanup-spacing --document-id DOCUMENT_ID
```

## Moving an installation

After moving this checkout or changing the Node executable, reinstall the
LaunchAgent and Finder Quick Actions:

```sh
npm run install-service
npm run install-finder-action
```

Workspace manifests use relative paths and remain portable. Runtime state and
Keychain credentials remain under the current macOS user account.
