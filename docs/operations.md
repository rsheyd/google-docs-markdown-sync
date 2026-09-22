# Operating GDMS

## Command reference

Install the `gdms` command from the source checkout with `npm link`. Use
`gdms --help` for compact terminal help and `gdms --version` to print the
checked-out version. The npm scripts remain available as development
fallbacks, but `gdms` is the supported user-facing interface.

| Command | Required arguments | Writes | Purpose |
| --- | --- | --- | --- |
| `gdms auth` | — | Keychain | Authorize Google Drive, Docs, and Sheets access. |
| `gdms create` | `--file FILE` | Local + Google | Create and pair a Google Doc from Markdown; optionally pass `--sync-location`, `--name`, and `--open`. |
| `gdms pair` | `--url URL --sync-location PATH --file FILE` | Local + Google | Pair an existing Google Doc and create its Markdown representation; optionally pass `--name`. |
| `gdms create-sheet` | One or more `--file FILE.csv` | Local + Google | Group CSV files, create a Google Sheet, and pair its tabs; optionally pass `--name` and `--open`. |
| `gdms pair-sheet` | `--url URL --sync-location PATH --directory DIR` | Local + Google | Pair an existing Google Sheet with a CSV directory. |
| `gdms plan` | `--document-id ID` | None | Preview the incremental Google Docs update plan. |
| `gdms push` | `--document-id ID` or `--spreadsheet-id ID` | Local + Google | Push one local pairing immediately and refresh managed status. |
| `gdms delete` | `--file FILE` or `--document-id ID`, plus `--yes` | Local + Google | Move a paired Doc to Drive trash, delete local Markdown/assets, unpair, and email. Docs only. |
| `gdms recover` | `--document-id ID --sync-location PATH --file FILE` | Local + Google | Restore the same Doc from trash, preserve local content, re-pair, and verify. Docs only. |
| `gdms location list` | — | None | List configured sync locations and their indexed manifest counts. |
| `gdms location add` | `--path PATH` | Local registry | Add one sync location and scan it once for portable pairing manifests. |
| `gdms location remove` | `--path PATH` | Local registry | Stop monitoring one location without deleting local or Google content. |
| `gdms location scan` | Optional `--path PATH` | Local registry | Rebuild manifest discovery for one or all configured sync locations. |
| `gdms cleanup-spacing` | `--all` or `--document-id ID` | Local state + Google | Remove legacy generated empty paragraphs from every paired Doc or one selected Doc. |
| `gdms migrate` | `--all` or `--document-id ID` | Local state + Google | Apply pending formatting migrations; add `--dry-run` for no writes. |
| `gdms configure-deletion` | `--grace-period-minutes N --to EMAIL` or `--disable` | Local settings | Configure automatic deletion globally; optionally pass `--from SENDER`. Docs only. |
| `gdms configure-checkboxes` | `--enable` or `--disable` | Local settings | Toggle export-verified native checklist conversion globally, off by default. Prints a warning that completion depends on Google’s export; ambiguous matches are skipped. Read on each sync pass; use `gdms sync-once` to process existing documents immediately. See [task-list semantics](formatting.md#lists). |
| `gdms configure-notifications` | Existing health-email recipient or `--to EMAIL` | Local settings + local system | Configure the shared email recipient, persistent-error delay, or error-email opt-out, then restart the sync service. |
| `gdms configure-r2` | `--account-id ID --bucket NAME --gateway-url URL` | Local settings | Store non-secret R2 image-staging configuration. |
| `gdms sync-once` | Optional repeatable `--file FILE` | Local + Google | Run one synchronization pass and exit, optionally limited to selected paired paths. |
| `gdms daemon` | — | Local + Google | Run the foreground synchronization loop. |
| `gdms install-service` | — | Local system | Install or restart the per-user synchronization LaunchAgent. |
| `gdms install-finder-action` | — | Local system | Install the Finder actions and open the Quick Actions pane where they can be enabled. |
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

The command rewrites the LaunchAgent configuration, stops the existing daemon, and starts it again. It prints each stage because stopping can briefly wait for an active synchronization pass to finish safely. Authorization and pairings are preserved. After 0.7.0, ordinary versioned source updates restart automatically. Documentation, tests, examples, and synchronized content changes do not require a restart.

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

Pass one or more paired Markdown paths to reconcile only those files immediately:

```sh
gdms sync-once --file /path/to/one.md --file /path/to/two.md
```

This is the command used by the **Sync Paired File Now (GDMS)** Finder Quick Action. Every explicitly selected path must already have a pairing. A targeted no-change check refreshes the successful-sync timestamp; ordinary automatic no-change polling remains write-free.

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

GDMS first moves the Google Doc to recoverable Drive trash, then deletes the local Markdown file and its managed asset directory, removes the pairing, and sends the configured Resend notification. Omitting `--yes` performs no writes. If the command is interrupted, GDMS resumes from its saved deletion phase and original local path. A retry verifies an in-progress trash operation with Drive before continuing, and repeated local deletions are harmless when part of the cleanup already completed. This command and automatic deletion propagation currently apply only to Markdown/Google Docs pairings, not Sheets/CSV pairings.

## Documents trashed in Google Drive

When Google Drive explicitly reports a paired Doc as trashed, GDMS immediately moves its local Markdown and managed asset directory into a unique dated folder under `.gdms-recovery/` beside the original Markdown file, then removes the pairing. All local content is preserved, including unsynced edits. There is no grace period or automatic expiration of recovery folders, and GDMS does not sync their contents. The archived Markdown retains its old status footer as historical information; it is no longer actively paired.

GDMS sends one configured deletion email with the recovery location and retries failed delivery. A deletion email recipient must be configured for cleanup to proceed. Interrupted cleanup resumes from its saved recovery location without overwriting an existing backup. A 404, lost access, or network failure never authorizes this cleanup: the local files and pairing remain intact and normal error reporting continues. A permanently deleted Doc that only returns 404 therefore still requires manual unpairing.

Restoring a Doc in Drive does not automatically restore its pairing. Review the recovery folder for unsynced edits, then use `gdms recover` below to restore/re-pair the Google copy at the original path. Merge any needed archived edits into the newly paired Markdown afterward; the recovery command does not import the archived copy. This behavior applies to Docs/Markdown only, not Sheets/CSV.

## Recover an accidentally trashed pairing

Use `recover` when a move, rename, or deletion caused GDMS to move the original
Google Doc to Drive trash and remove its pairing:

```sh
gdms recover \
  --document-id DOCUMENT_ID \
  --sync-location "/absolute/path/to/sync-location" \
  --file "new/folder/note.md"
```

The command uses the original Google Doc ID. It checks the Drive file, restores
it from trash when necessary, and verifies `trashed: false`. If the requested
Markdown path or matching `.assets` directory already exists, GDMS moves them
to collision-safe timestamped siblings such as
`note.recovery-backup-20260814T173045Z.md` and
`note.recovery-backup-20260814T173045Z.assets`. It then exports the restored
Doc, registers the new relative path in `google-docs-sync.json`, clears the old
deletion tombstone, and verifies the local file and pairing.

When a backup was created, compare it with the newly exported Markdown. Merge
any local-only changes into the paired file, then push explicitly:

```sh
gdms push --document-id DOCUMENT_ID
gdms sync-once
```

Do not use `gdms create` for recovery; it creates a second Google Doc with a
different ID. Do not edit the manifest by hand as a substitute for restoring
the Drive file. A manual fallback is to disable deletion propagation, preserve
the local Markdown/assets, restore the original Doc in Drive, run `gdms pair`
at the desired path, compare and merge the backup, push, verify, and then
re-enable the previous deletion policy.

## Native checklist conversion

Markdown task-list syncing works without enabling conversion. To additionally convert native Google Docs checklists into GDMS text markers, run:

```sh
gdms configure-checkboxes --enable
```

**Conversion may turn completed tasks into open ones.** Conversion uses the state in Google’s Markdown export, which has not yet been verified for completed native tasks. It requires a unique text match and skips ambiguous items; glyph metadata alone is insufficient. The command prints this warning. This global, machine-local setting is stored as `autoConvertNativeCheckboxes` in `~/Library/Application Support/google-docs-markdown-sync/settings.json`; it is off by default and does not belong in portable pairing manifests.

The setting is read on each sync pass, so no service restart is required. Existing quiet documents may wait until reconciliation; run `gdms sync-once` to process all pairings immediately, or `gdms sync-once --file /absolute/path/to/paired.md` for one file. Conversion occurs when pulling or when content is unchanged; pending local pushes take precedence. Review the converted tasks and replace `o]` with `x]` for completed items.

To stop future conversions:

```sh
gdms configure-checkboxes --disable
```

Disabling the setting does not undo prior conversions or disable ordinary Markdown task syncing. See [checklist behavior, detection limits, and rationale](formatting.md#checklists).

## Apply formatting migrations

For the formatting rules these migrations reconcile, see
[formatting guide](formatting.md).

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
~/Library/Logs/google-docs-markdown-sync/service.log
~/Library/Logs/google-docs-markdown-sync/service-error.log
```

Reinstalling the service moves legacy log files from Application Support when the corresponding new log file does not already exist. Configuration, runtime state, and registries remain under Application Support.

Every daemon output and error entry begins with an ISO 8601 timestamp using
the Mac's current UTC offset, for example
`2026-08-14T11:42:08-04:00`. Interactive `gdms sync-once` progress remains
untimestamped because it is already observed live.

The daemon records each pairing failure once instead of repeating it on every
polling cycle. It preserves the current failure and sent-email marker across
service restarts, and treats timeout, abort, DNS, connection-reset, rate-limit,
and Google server errors as one temporary-connectivity category. Log entries for
spreadsheet requests include the failed Google operation, elapsed milliseconds,
and available error code. Desktop banners are disabled by default because they
are transient and do not provide a dependable review queue.

Before scheduled polls and local-change syncs, the daemon checks whether the Google API hostname is reachable. When the Mac is offline or DNS is unavailable, it logs one `sync paused` entry and makes no Google requests, then resumes automatically after connectivity returns. An independent liveness monitor detects scheduling gaps that indicate likely laptop sleep, including sleep during active work. GDMS stops admitting new work, waits for admitted workers to settle, and rejects stale responses and uncommitted batch results before recording incidents or recovery notifications. Completed batch checkpoints remain durable. After networking settles for 15 seconds, synchronization resumes from the saved cursor, safely replaying incomplete work; Google or local content writes already completed before interruption cannot be rolled back. Failures during stable awake operation retain bounded backoff and persistent-error reporting.

Routine remote polling reads the Google Drive changes feed and synchronizes only paired files reported as changed, so a quiet cycle uses one paginated changes query rather than one request per pairing. The machine-local cursor advances only after targeted synchronization state is saved; a crash, sleep interruption, or changed-pairing error therefore replays the same changes safely. On first use, or when Google expires a cursor, GDMS obtains a fresh cursor and completes one full reconciliation before recording it; isolated reconciliation errors remain visible through normal pairing incidents but do not trap the daemon in repeated full scans. Changes to unpaired Drive files are ignored, and discovery failures are logged once at daemon level with bounded retry rather than reported as pairing incidents.

Full reconciliation uses batches of at most 20 pairings and logs committed progress between batches. Queued local changes and moves can run before the next batch; one bounded batch of incremental remote targets is also serviced between reconciliation batches. Within each batch, at most eight independent pairings execute concurrently. Shared state, manifest-changing renames, deletion progress, error/recovery notifications, and completion output remain controlled by a single coordinator in registry order. A delayed request can still hold up its batch; this is not a strict latency deadline. Google rate-limit and server errors reduce admission for the remaining batch and trigger exponential backoff capped at 60 seconds, in addition to the daemon's existing failed-cycle backoff.

`gdms sync-once` without `--file` explicitly checks every registered pairing; it is a full verification operation, not the background changes-feed poll. An unchanged result can involve extra requests when native-checkbox conversion is enabled, because conversion verifies Docs content against Google's Markdown export. For a sequential comparison, run `GOOGLE_DOCS_SYNC_CONCURRENCY=1 gdms sync-once`; valid concurrency values are integers from 1 through 8, with eight the default. Completion lines stay in pairing order, and per-pair durations exclude queue wait when worker computation completes directly. The single-flight queue is local to a process; stop the daemon before running an isolated whole-registry benchmark. Changing the daemon's environment requires restarting its LaunchAgent with that environment configured.

The measured motivation, ownership boundaries, and validation evidence are recorded in the [scheduler design](design/scalable-wake-safe-sync.md#september-2026-scheduler-implementation).

Installing the weekly health email also enables persistent sync-error email to
the same recipient. Errors that need attention use the configured delay, 15
minutes by default. Temporary connectivity failures wait at least 30 minutes
or the configured delay, whichever is longer.

For paired Markdown files, the managed footer also surfaces the current failure compactly on its first line as **Needs attention** or **Temporarily paused** while retaining the last successful sync time. A successful retry restores the normal footer title. Detailed diagnostics remain in the service error log.

Configure the shared recipient or delay directly with:

```sh
gdms configure-notifications --to "you@example.com"
gdms configure-notifications --error-email-delay-minutes 30
```

Disable only persistent-error email with
`gdms configure-notifications --disable-error-email`; weekly health email,
and deduplicated logs remain active. Re-enable it with `--enable-error-email`.
GDMS sends a recovery email only if it previously emailed the corresponding
persistent error. Desktop error/recovery banners can be explicitly enabled with
`gdms configure-notifications --enable-desktop-notifications` and disabled with
`--disable-desktop-notifications`. Advanced installations may override saved values
with `GOOGLE_DOCS_SYNC_ERROR_TO`, `GOOGLE_DOCS_SYNC_ERROR_FROM`, and
`GOOGLE_DOCS_SYNC_ERROR_EMAIL_DELAY_MS` in the service environment.

Inspect recent entries with:

```sh
tail -n 50 "$HOME/Library/Logs/google-docs-markdown-sync/service.log"
tail -n 50 "$HOME/Library/Logs/google-docs-markdown-sync/service-error.log"
```

Machine-specific runtime state is stored in the same application-support
directory. OAuth and R2 credentials are stored in macOS Keychain.

## Email notifications and weekly health heartbeat

An independent LaunchAgent can send a weekly success email after checking the
sync daemon and every paired Google Doc and Sheet. Because it is separate from
the daemon, a missing expected email acts as a dead-man warning.

Store a Resend API token in Keychain under service
`com.roman.google-docs-markdown-sync`, account `resend-api`, then install the
Monday 9:00 AM local-time heartbeat:

```sh
gdms install-heartbeat --to "you@example.com"
```

This stores one shared email recipient and sender in machine-local GDMS
settings. Persistent sync errors automatically use the same address after 15
minutes. Existing installations migrate the recipient from the older heartbeat
LaunchAgent the next time `gdms install-service` runs.

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

Defaults are a 250 ms local stat interval, a 750 ms debounce, a five-second Google changes-feed polling interval, a 15-second post-wake network-settling interval, a 30-second request timeout, and one complete reconciliation every 24 hours. A remote changes-feed hit first checks the pairing's lightweight Drive metadata. GDMS fetches the complete Docs structure or Sheets metadata and tab values after a local or remote change, when initializing the lightweight baseline, during reconciliation, or when status and formatting work requires the richer representation. Reconciliation runs through the same wake-safe, single-flight coordinator and records its completion time in machine-local state and weekly heartbeat output. Optional overrides:

```sh
export GOOGLE_DOCS_SYNC_DEBOUNCE_MS=750
export GOOGLE_DOCS_SYNC_INTERVAL_MS=5000
export GOOGLE_DOCS_SYNC_NETWORK_SETTLE_MS=15000
export GOOGLE_DOCS_SYNC_REQUEST_TIMEOUT_MS=30000
export GOOGLE_DOCS_SYNC_RECONCILIATION_INTERVAL_MS=86400000
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
- Moving a paired Markdown file within its sync location updates the manifest.
  Moves that copy and delete the file, cross filesystems, leave the sync location,
  or collide with an existing destination are not adopted automatically.
- Renaming a paired Google Doc renames its Markdown file in the same directory
  using lowercase kebab case, unless the destination already exists.
- A local-only change updates the same Google document. A remote-only change
  updates the local representation.
- Local CSV changes update only changed Google Sheets cell values. Existing cell formatting and native Sheets structure remain in Google Sheets; native tables expand when CSV data grows beyond their current bounds but do not shrink automatically.
- A Google Sheets formatting-only revision advances the remote baseline without rewriting unchanged CSV files.
- Simultaneous text-only changes use the later filesystem or Drive
  modification time. Image-bearing documents stop with a conflict when the
  local content, Google revision, and Drive modification time all changed from
  the shared baseline. Revision-token churn alone is not treated as an edit.
- Writes are hashed and revision-tracked to prevent feedback loops. Pairings
  share one single-flight synchronization queue.

Google Docs native Markdown export normally defines the supported pull
representation. When Drive refuses that export because the document exceeds
its export-size limit, GDMS falls back to serializing the same supported
paragraphs, headings, lists, inline styles, links, tables, and images from the
Google Docs API. Other export failures remain errors rather than silently
changing conversion paths.
On push, GDMS applies changed paragraph and list ranges in descending order in
one atomic Docs batch. Unchanged ranges and tables remain in place. A changed
table structure falls back to a full body rebuild unless the document contains
images, in which case GDMS refuses the unsafe rebuild.

Ordinary Markdown paragraphs receive 8 pt of visual spacing in Google Docs without creating Markdown-visible blank paragraphs. Each additional consecutive blank line becomes an explicit empty Docs paragraph instead of combining that paragraph with the 8 pt gap. Markdown hard breaks become adjacent paragraphs without the added spacing. Headings, lists, tables, and managed status content retain their native spacing.

Markdown fragment links become native Docs heading links. New headings require
a second atomic batch after Google assigns their heading IDs. A native Google
Docs table of contents is preserved because the Docs API cannot create or
update it. GDMS represents it locally with a marked, generated Markdown TOC;
an unmarked table of contents authored in Markdown remains ordinary linked
content. See the [formatting guide](formatting.md#tables-of-contents).

Comments and suggestions are not represented in Markdown. Incremental updates
preserve anchors in unchanged ranges, but an anchor inside a replaced range can
be affected. Content omitted by Google's native Markdown export can be lost if
its surrounding range is later replaced from Markdown.

When content and revision tracking indicate that a pairing is unchanged, GDMS
still reconciles inline formatting and paragraph spacing from Markdown using
format-only Docs API requests. This repairs style drift without replacing text.

## Managed status artifacts

Google Docs show a small managed status section and Markdown files show an
equivalent footer with a link back to the Doc. Sheets use a `↔ Sync Status` tab
and local `GDMS.md`. The local file combines human-readable status with a marked, machine-readable block containing the portable tab map, number formats, column semantics, and native-table structure. It is excluded from CSV content comparison. Legacy `.google-sheets-sync.json` and `SYNC-STATUS.md` files migrate atomically into `GDMS.md`.

Deleting or editing a status artifact does not unpair the document. GDMS
repairs it on a later pass unless the installation's opt-in deletion policy
reaches its grace-period deadline.

## Recovery and troubleshooting

### Raycast reports `Missing executable` after an update

The GDMS Raycast command is currently imported from this source checkout as a development extension. A Raycast update may remove or invalidate its generated command executable. Rebuild and re-import it:

```sh
cd /path/to/google-docs-markdown-sync/raycast-extension
npm install
npm run dev
```

Wait for `built extension successfully`, confirm that the command works, and then stop the development process with Control-C. The imported command remains available in Raycast; rerun `npm run dev` after extension source changes or if a later Raycast update produces the same error. `npm run build` validates the extension but does not import it into Raycast.

### The service is not running

Run `gdms install-service`, then inspect the error log. The LaunchAgent uses
absolute paths to this checkout and its Node executable, so reinstall it after
either path changes.

### Authorization stops working after seven days

Google OAuth applications in external **Testing** mode issue expiring refresh
tokens. Configure the consent screen appropriately for an unattended
synchronization service, then run `gdms auth` again.

### A large Google Doc cannot be exported

GDMS automatically uses its Google Docs API fallback when Drive reports
`exportSizeLimitExceeded`. Pairing and later pulls should continue without
splitting the document. The fallback covers GDMS's supported Markdown subset;
Docs-only layout and effects remain outside the round trip. If the initial
import fails for another reason, GDMS restores the sync-location manifest instead
of leaving a new pairing entry without its Markdown file. The Raycast command
shows the CLI's specific error output when further action is required.

### A synchronization pass reports an image conflict

GDMS stops when both sides of an image-bearing document changed since their
shared baseline. A Google revision-token change with an unchanged Drive
modification time is treated as normalization rather than a second-side edit.
If a prior push updated the document body before a later formatting step
failed, GDMS compares normalized remote content and image bytes with the local
snapshot and repairs the shared baseline when they match. For a genuine
conflict, compare the Google Doc with the Markdown file and its
asset directory before choosing which content to retain. GDMS does not yet
create an automatic conflict copy.

For a Google Doc with a native table of contents, GDMS generates the entries
inside the local `gdms:generated-toc` markers from the Markdown headings. Edits
inside that range are overwritten, excluded from change detection, and never
sent as static content. The native Docs element remains independent; refresh
it inside Google Docs after heading changes. Delete a native TOC in Google Docs
rather than removing only its local generated representation.

### A Markdown image cannot be pushed

Confirm that the image is in the Markdown file's managed sibling asset
directory, is PNG, JPEG, or GIF, and appears in a standalone image paragraph.
Local additions and replacements also require the private R2 bucket and Worker
configuration from the [installation guide](installation.md#configure-image-staging).

### A table edit is refused

Changed table structure requires a full Docs body rebuild. With image staging configured, GDMS can rebuild documents containing supported standalone image paragraphs and at most one image per table cell. A rebuilt cell image retains its position relative to the cell text but uses Google Docs' default image size. Cells containing multiple images remain unsupported; simplify those cells before retrying.

### Remove surplus spacing paragraphs

Normal Markdown pushes now remove surplus empty Docs paragraphs where the surrounding content matches unambiguously. For a paired Doc that needs cleanup before another local edit, the cleanup command refuses to write when any non-spacing content differs:

```sh
gdms cleanup-spacing --document-id DOCUMENT_ID
gdms cleanup-spacing --all
```

The command changes only paired Google Docs whose non-spacing content matches the local Markdown. `--all` checks every paired Doc, skips spreadsheet pairings, continues after individual errors, prints per-document progress and a final summary, and exits nonzero if any document could not be checked or cleaned.

## Moving an installation

After moving this checkout or changing the Node executable, reinstall the
LaunchAgent and Finder Quick Actions:

```sh
gdms install-service
gdms install-finder-action
```

Sync-location manifests use relative paths and remain portable. Runtime state and Keychain credentials remain under the current macOS user account.

Fresh installations have no assumed sync locations. Configure each desired tree explicitly:

```sh
gdms location add --path "$HOME/dev"
gdms location add --path "/path/to/document/archive"
```

GDMS stores authoritative machine-local location choices in `sync-locations.json` and the rebuildable manifest cache in `manifest-index.json` under Application Support. Routine five-second polling reads the index directly and never recursively scans configured locations. Adding a location scans it once; `gdms location scan [--path PATH]` performs later explicit discovery, and a missing or invalid manifest index is reconstructed from the intact location registry.

Removing a location stops monitoring its indexed pairings but does not delete Markdown, CSV, manifests, Google Docs, Google Sheets, or synchronization state. Adding and scanning the location again restores discovery from its portable manifests.

Existing installations migrate the legacy `workspaces.json` index and `GOOGLE_DOCS_SYNC_ROOT` setting idempotently. The legacy file remains untouched for rollback during the compatibility window.
