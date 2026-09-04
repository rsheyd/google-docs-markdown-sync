# Install and configure GDMS

This guide installs GDMS from a source checkout, authorizes Google access, and
creates the first pairing. GDMS currently targets macOS and requires Node.js 22
or newer.

## Prerequisites

Required for every installation:

- macOS;
- Node.js 22 or newer and npm;
- a Google account; and
- a Google Cloud project with the Drive, Docs, and Sheets APIs enabled.

Optional components depend on the workflow:

- Safari or a supported Chromium browser, plus Raycast, for pairing the active
  browser document;
- Cloudflare R2 for adding or replacing local images in Google Docs; and
- Resend for the independent weekly health email.

## Install dependencies

Clone or download the repository, enter its directory, and run:

```sh
npm install
npm link
```

`npm link` installs the `gdms` command as a global symlink to this checkout.
Confirm the command and both CLI/daemon versions with `gdms --version`. Before
the service is installed, the daemon line reports `not running`. GDMS runs
directly from this checkout. Moving or deleting the checkout later
will break the installed LaunchAgent and Finder Quick Actions until they are
reinstalled from the new location.

## Choose sync locations

GDMS begins with no assumed sync location on a fresh installation. Add each project tree or document archive explicitly:

```sh
gdms location add --path "$HOME/dev"
gdms location add --path "/path/to/gdrive/Roman"
```

Adding a location scans only that selected tree for existing portable manifests and records them in the machine-local manifest index. List or rescan the configured locations at any time:

```sh
gdms location list
gdms location scan
```

Routine synchronization loads the manifest index directly and does not recursively scan configured locations. Use `gdms location scan --path PATH` after copying an existing paired repository into a location or when deliberately rebuilding discovery for one tree.

An existing installation migrates its former `workspaces.json` index and `GOOGLE_DOCS_SYNC_ROOT` setting automatically without deleting the old index. The `--sync-location` CLI option selects the location that owns the manifest; the former `--workspace` spelling remains accepted as a compatibility alias.

## Authorize Google

Create an OAuth 2.0 Desktop application in Google Cloud with the Google Drive,
Google Docs, and Google Sheets APIs enabled. Download its client JSON outside
the repository to the default location:

```text
~/Library/Application Support/google-docs-markdown-sync/oauth-client.json
```

For another location, set:

```sh
export GOOGLE_DOCS_SYNC_OAUTH_CLIENT="/absolute/path/to/client_secret.json"
```

Then authorize GDMS:

```sh
gdms auth
```

The service requests Drive access (including moving explicitly paired Docs to
trash), Docs access for same-document updates,
and Sheets access for same-spreadsheet updates. Refresh tokens are stored in
the macOS Keychain. Google OAuth apps left in external **Testing** status issue
refresh tokens that expire after seven days; an unattended synchronization service
should use an appropriately configured production consent screen.

Existing pre-Sheets installations must run `gdms auth` again to grant the
Sheets scope.

## Install the background service

```sh
gdms install-service
```

This creates and starts a per-user LaunchAgent. The service watches local
changes and polls Google automatically after login. Confirm connectivity with:

```sh
gdms heartbeat
```

The heartbeat requires at least one pairing. If none exists yet, continue with
the next section first.

The daemon records its loaded version in local runtime state. Future versioned
source updates cause it to exit cleanly, after which LaunchAgent `KeepAlive`
automatically starts the new code.

## Pair your first document

### Start from Markdown

Create a Google Doc from an existing Markdown file and register the pairing:

```sh
gdms create \
  --file "notes/example.md" \
  --name "Example"
```

The sync location defaults to the file's directory. If `--name` is omitted, the
title is derived from the filename with the current month appended.

### Start from a Google Doc

```sh
gdms pair \
  --url "https://docs.google.com/document/d/DOCUMENT_ID/edit" \
  --sync-location "$HOME/dev/example-project" \
  --file "notes/example.md"
```

### Start from CSV files

Create a Google Sheet with one tab per selected CSV. The files must share a
parent directory and are moved into a new paired subdirectory:

```sh
gdms create-sheet \
  --file "Summary.csv" \
  --file "Transactions.csv" \
  --name "Budget"
```

### Start from a Google Sheet

```sh
gdms pair-sheet \
  --url "https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit" \
  --sync-location "$HOME/dev/example-project" \
  --directory "data/budget"
```

## Optional deletion propagation

After creating at least one Markdown/Google Docs pairing, enable automatic
deletion once for every existing and future pairing on this Mac:

```sh
gdms configure-deletion \
  --grace-period-minutes 60 \
  --to "you@example.com"
```

Add `--from "Google Docs Sync <sync@your-verified-domain>"` if Resend requires
a verified sender. The non-secret global policy is stored in
`~/Library/Application Support/google-docs-markdown-sync/settings.json`, not in
individual sync-location manifests.

Store a Resend API token in macOS Keychain. Keeping `-w` last prompts securely
instead of putting the token in shell history or process arguments:

```sh
security add-generic-password -U \
  -s com.roman.google-docs-markdown-sync -a resend-api -w
```

The running service reads this global setting on every sync pass, so enabling
or disabling it does not require reinstalling or restarting the service.

The policy is opt-in for this GDMS installation. Until it is enabled, GDMS
continues restoring a missing Markdown file from its Google Doc. Disable it
globally at any time with:

```sh
gdms configure-deletion --disable
```

If an accidental move or deletion reaches the end of the grace period, use
`gdms recover` with the original document ID instead of creating a replacement
Doc or editing the pairing manifest manually. Recovery preserves any local
Markdown and assets before re-exporting the same Doc. See
[Recover an accidentally trashed pairing](operations.md#recover-an-accidentally-trashed-pairing).

It currently applies only to
Markdown/Google Docs pairings; deleting a paired CSV directory never moves its
Google Sheet to trash.

## Finder Quick Actions

Install the Finder actions with:

```sh
gdms install-finder-action
```

For Markdown, Control-click one or more `.md` files and choose **Quick Actions
→ Sync MDs with New Google Docs (GDMS)**. GDMS creates one Google Doc per file and
registers each pairing. A single new Doc opens in the default browser. For a
multi-file selection, GDMS avoids opening many tabs and instead shows a
completion notification with the number of Docs created.

To synchronize existing pairings immediately, Control-click one or more paired `.md` files and choose **Quick Actions → Sync Paired File Now (GDMS)**. GDMS runs its normal two-way reconciliation only for the selected files, refreshes the successful-sync timestamp even when content is unchanged, and shows a completion dialog with the result. Failures show an error dialog, and an unpaired selection fails without creating a new Google Doc.

For Sheets, select one or more `.csv` files in the same directory and choose
**Quick Actions → Combine & Sync CSVs with New Google Sheet (GDMS)**. GDMS
prompts for a name, creates a collision-safe sibling directory, moves the files
into it, creates one tab per CSV, and pairs the files for ongoing two-way sync.
The new Google Sheet opens in the default browser.
If remote creation fails, the files remain together in the new directory so
the operation can be retried.

After installing, the Finder Quick Actions pane opens automatically. Turn on
**Sync MDs with New Google Docs (GDMS)**, **Sync Paired File Now (GDMS)**, and **Combine & Sync CSVs with New Google Sheet (GDMS)**, then click the pane's **Done** button.

If an action is not visible in Finder afterward, Control-click a compatible
`.md` or `.csv` file and choose **Quick Actions → Customize…**, then enable the
matching GDMS action.

Re-run the installer after moving the repository or changing the Node
executable because the workflows store absolute paths. The settings pane opens
again so you can confirm that the actions remain enabled.

## Raycast setup

The Raycast command reads the active Google Doc or Sheet from the frontmost Safari, Chrome, Chrome Beta, Chromium, Brave, or Microsoft Edge window. It reads the same sync-location registry as the CLI and daemon, supports adding or non-destructively removing locations, can explicitly find existing portable manifests, browses each location lazily, and registers the chosen local file or directory. On first use after upgrading, it imports its former Raycast-only location list into the shared registry and removes that duplicate setting only after migration succeeds.

```sh
cd raycast-extension
npm install
npm run dev
```

Keep the development command running while using the extension. `npm run build` compiles it but does not register it in Raycast. Run `gdms install-service` before using the Raycast command; installation records the CLI, Node, and OAuth file paths under Application Support so Raycast does not require separate technical preferences. Re-run the service installer after moving the repository, Node executable, or OAuth client file.

Raycast extensions cannot provide a default global hotkey. In Raycast
Settings, open **Extensions**, find **GDMS → Pair Google Doc or Sheet with
GDMS**, and assign a hotkey. The recommended shortcut is
**Command–Shift-M**.

## Configure image staging

This section is required only to add or replace local Markdown images in
Google Docs. Remote Docs images can be downloaded without it.

Create a private Cloudflare R2 bucket and a token restricted to object
read/write for that bucket. Do not enable permanent public access. Configure
the non-secret values:

```sh
gdms configure-r2 --account-id ACCOUNT_ID --bucket BUCKET_NAME \
  --gateway-url https://WORKER.ACCOUNT.workers.dev
```

Store the credentials in macOS Keychain. Keeping `-w` last prompts securely
instead of putting the secret in shell history or process arguments:

```sh
security add-generic-password -U \
  -s com.roman.google-docs-markdown-sync.r2-access-key -a r2 -w

security add-generic-password -U \
  -s com.roman.google-docs-markdown-sync.r2-secret-key -a r2 -w

security add-generic-password -U \
  -s com.roman.google-docs-markdown-sync.r2-gateway-secret -a r2 -w
```

Deploy `cloudflare/image-gateway-worker.js` as a module Worker. Bind the bucket
as `IMAGE_BUCKET`, store the same gateway secret in the encrypted Worker
binding `GATEWAY_SECRET`, enable its `workers.dev` or custom-domain route, and
disable Worker preview URLs. The runtime token needs only **Workers R2 Storage
Bucket Item Write** on this bucket.

Add an R2 lifecycle rule that deletes objects under
`google-docs-image-staging/` after one day. Eager cleanup normally removes
staged objects immediately; the lifecycle rule covers interrupted requests.
Restart GDMS after configuration:

```sh
gdms install-service
```

See the [image synchronization design](design/image-sync.md) for the transport design and safety model.

## Pairing manifest

Each participating sync location tracks `google-docs-sync.json`:

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

Paths are relative to the manifest. Do not add tokens, hashes, revisions, or timestamps. Spreadsheet directories also contain a managed, portable, visible `GDMS.md` file containing the tab map, supported Sheets formatting and table metadata, and human-readable synchronization status. Existing `.google-sheets-sync.json` and `SYNC-STATUS.md` sidecars migrate into that single file automatically.

Global deletion behavior is deliberately absent from this portable manifest.
Configure it once for the entire installation with
[`configure-deletion`](#optional-deletion-propagation).

Upgrading from GDMS 0.4.x or earlier requires running `gdms auth` once to
grant the Drive write scope used for trash operations, followed by
`gdms install-service` to refresh the background service configuration.

## Optional email notifications and weekly heartbeat

Continue with the
[operations guide](operations.md#email-notifications-and-weekly-health-heartbeat)
to install the independent weekly success email. The same saved recipient
receives persistent sync-error alerts by default.
