# Operating GDMS

## Command reference

Install the `gdms` command from the source checkout with `npm link`. Use
`gdms --help` for compact terminal help and `gdms --version` to print the
checked-out version. The npm scripts remain available as development
fallbacks, but `gdms` is the supported user-facing interface.

| Command | Required arguments | Writes | Purpose |
| --- | --- | --- | --- |
| `gdms auth` | — | Keychain | Authorize Google Drive, Docs, and Sheets access. |
| `gdms create` | `--file FILE` | Local + Google | Create and pair a Google Doc from Markdown; optionally pass `--workspace` and `--name`. |
| `gdms pair` | `--url URL --workspace PATH --file FILE` | Local + Google | Pair an existing Google Doc and create its Markdown representation; optionally pass `--name`. |
| `gdms create-sheet` | One or more `--file FILE.csv` | Local + Google | Group CSV files, create a Google Sheet, and pair its tabs; optionally pass `--name`. |
| `gdms pair-sheet` | `--url URL --workspace PATH --directory DIR` | Local + Google | Pair an existing Google Sheet with a CSV directory. |
| `gdms plan` | `--document-id ID` | None | Preview the incremental Google Docs update plan. |
| `gdms push` | `--document-id ID` or `--spreadsheet-id ID` | Local + Google | Push one local pairing immediately and refresh managed status. |
| `gdms delete` | `--file FILE` or `--document-id ID`, plus `--yes` | Local + Google | Move a paired Doc to Drive trash, delete local Markdown/assets, unpair, and email. Docs only. |
| `gdms cleanup-spacing` | `--document-id ID` | Local state + Google | Remove legacy generated empty paragraphs from one Doc. |
| `gdms migrate` | `--all` or `--document-id ID` | Local state + Google | Apply pending formatting migrations; add `--dry-run` for no writes. |
| `gdms configure-deletion` | `--grace-period-minutes N --to EMAIL` or `--disable` | Local settings | Configure automatic deletion globally; optionally pass `--from SENDER`. Docs only. |
| `gdms configure-r2` | `--account-id ID --bucket NAME --gateway-url URL` | Local settings | Store non-secret R2 image-staging configuration. |
| `gdms sync-once` | — | Local + Google | Run one synchronization pass and exit. |
| `gdms daemon` | — | Local + Google | Run the foreground synchronization loop. |
| `gdms install-service` | — | Local system | Install or restart the per-user synchronization LaunchAgent. |
| `gdms install-finder-action` | — | Local system | Install the Markdown and CSV Finder Quick Actions. |
| `gdms heartbeat` | `--to EMAIL` unless configured | Email + Google reads | Check the daemon and pairings, then send a success email; optionally pass `--from`. |
| `gdms install-heartbeat` | `--to EMAIL` | Local system | Install the weekly heartbeat LaunchAgent; optionally pass `--from`. |
| `gdms version`, `gdms --version` | — | None | Print the CLI version and the live daemon version when running. |
| `gdms help`, `gdms --help` | — | None | Print compact command help. |

Run `npm run cli -- COMMAND` from the repository only when the global link is
unavailable. Development scripts such as `npm test` and `npm run check` remain
npm-only.

## Service management

The installed LaunchAgent runs source files from this checkout directly. The
daemon records its version and checks `package.json` before every polling
cycle. When the checked-out version changes, it exits cleanly and LaunchAgent
`KeepAlive` starts the new version within a few seconds.

Run this command once when upgrading to GDMS 0.7.0 to install the self-restart
safeguard, and whenever the LaunchAgent or runtime configuration itself
changes:

```sh
gdms install-service
```

The command rewrites the LaunchAgent configuration, stops the existing daemon,
and starts it again. Authorization and pairings are preserved. After 0.7.0,
ordinary versioned source updates restart automatically. Documentation, tests,
examples, and synchronized content changes do not require a restart.

Check both loaded and on-disk versions with:

```sh
gdms --version
```

A transient `restart pending` result means the old process has observed or is
about to observe the new package version. If it persists beyond one polling
cycle, run `gdms install-service`.

For temporary foreground operation:

```sh
gdms daemon
```

Stop it with <kbd>Control</kbd>+<kbd>C</kbd>. Do not run a foreground daemon at
the same time as the LaunchAgent.

Run one synchronization pass without starting the daemon:

```sh
gdms sync-once
```

The command reports the current pairing and total, replaces the in-progress
line with its result in an interactive terminal, and finishes with action
counts. Redirected output uses ordinary newline-delimited start and completion
records. If any pairing fails, the remaining pairings still run and the
command exits with a nonzero status after printing the summary.

Missing-file messages describe the current safety phase instead of exposing
the internal `defer` action. `missing-local` means GDMS is briefly checking for
a filesystem move and reports the maximum wait derived from the polling
interval, together with the configured deletion grace period. `pending-trash`
includes the remaining deletion grace
period; and `trash` confirms that Drive trash and unpairing completed.

## Health checks

Confirm that the daemon is running and that every paired Google Doc and Sheet
is readable:

```sh
gdms heartbeat
```

This command sends email only when a recipient is provided or configured. For
a non-writing preview of a Google Docs update plan:

```sh
gdms plan --document-id DOCUMENT_ID
```

To push one pairing explicitly:

```sh
gdms push --document-id DOCUMENT_ID
gdms push --spreadsheet-id SPREADSHEET_ID
```

To deliberately delete both sides of a Markdown/Google Docs pairing:

```sh
gdms delete --file /absolute/path/to/note.md --yes
# or
gdms delete --document-id DOCUMENT_ID --yes
```

GDMS first moves the Google Doc to recoverable Drive trash, then deletes the
local Markdown file and its managed asset directory, removes the pairing, and
sends the configured Resend notification. Omitting `--yes` performs no writes.
This command and automatic deletion propagation currently apply only to
Markdown/Google Docs pairings, not Sheets/CSV pairings.

## Apply formatting migrations

For the formatting rules these migrations reconcile, see
[FORMATTING.md](FORMATTING.md).

Preview pending targeted migrations across every paired Google Doc:

```sh
gdms migrate --all --dry-run
```

Apply them after reviewing the preview:

```sh
gdms migrate --all
```

Use `--document-id DOCUMENT_ID` instead of `--all` to target one pairing.
Migrations skip Google Sheets and versions already recorded for each document,
continue past individual failures, and never rebuild document content. Successful
writes update the stored remote revision so ordinary synchronization does not
mistake the formatting migration for a collaborator edit.

## Logs

Service output and errors are stored in:

```text
~/Library/Application Support/google-docs-markdown-sync/service.log
~/Library/Application Support/google-docs-markdown-sync/service-error.log
```

Every daemon output and error entry begins with an ISO 8601 timestamp using
the Mac's current UTC offset, for example
`2026-08-14T11:42:08-04:00`. Interactive `gdms sync-once` progress remains
untimestamped because it is already observed live.

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
gdms install-heartbeat --to "you@example.com"
```

Run an immediate check and test email with:

```sh
gdms heartbeat --to "you@example.com"
```

The default sender is `Google Docs Sync <onboarding@resend.dev>`. If Resend
requires a verified sender, reinstall with:

```sh
gdms install-heartbeat --to "you@example.com" \
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

- By default, a missing local Markdown file is initialized from Google native
  export after one polling grace interval so filesystem moves can be
  recognized first.
- The installation can globally opt in to `trash-after-grace-period` with
  `configure-deletion`. GDMS records the first
  observed absence durably, continues recognizing moves and restoration during
  the configured grace period, then moves the paired Doc to Drive trash,
  removes the pairing, and sends one idempotent email. A failed email remains
  queued for retry. This applies only to Markdown/Google Docs pairings.
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
repairs it on a later pass unless the installation's opt-in deletion policy
reaches its grace-period deadline.

## Recovery and troubleshooting

### The service is not running

Run `gdms install-service`, then inspect the error log. The LaunchAgent uses
absolute paths to this checkout and its Node executable, so reinstall it after
either path changes.

### Authorization stops working after seven days

Google OAuth applications in external **Testing** mode issue expiring refresh
tokens. Configure the consent screen appropriately for an unattended
synchronization service, then run `gdms auth` again.

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
gdms cleanup-spacing --document-id DOCUMENT_ID
```

## Moving an installation

After moving this checkout or changing the Node executable, reinstall the
LaunchAgent and Finder Quick Actions:

```sh
gdms install-service
gdms install-finder-action
```

Workspace manifests use relative paths and remain portable. Runtime state and
Keychain credentials remain under the current macOS user account.

The default workspace root is `~/Documents/GDMS`. To use another root, export
`GOOGLE_DOCS_SYNC_ROOT` and reinstall the service so launchd receives it:

```sh
export GOOGLE_DOCS_SYNC_ROOT="$HOME/projects"
gdms install-service
```
