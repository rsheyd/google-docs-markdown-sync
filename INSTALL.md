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

- Google Chrome and Raycast for pairing the active browser document;
- Cloudflare R2 for adding or replacing local images in Google Docs; and
- Resend for the independent weekly health email.

## Install dependencies

Clone or download the repository, enter its directory, and run:

```sh
npm install
```

GDMS runs directly from this checkout. Moving or deleting the checkout later
will break the installed LaunchAgent and Finder Quick Actions until they are
reinstalled from the new location.

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
npm run auth
```

The service requests Drive read access, Docs access for same-document updates,
and Sheets access for same-spreadsheet updates. Refresh tokens are stored in
the macOS Keychain. Google OAuth apps left in external **Testing** status issue
refresh tokens that expire after seven days; an unattended personal service
should use an appropriately configured production consent screen.

Existing pre-Sheets installations must run `npm run auth` again to grant the
Sheets scope.

## Install the background service

```sh
npm run install-service
```

This creates and starts a per-user LaunchAgent. The service watches local
changes and polls Google automatically after login. Confirm connectivity with:

```sh
npm run heartbeat
```

The heartbeat requires at least one pairing. If none exists yet, continue with
the next section first.

## Pair your first document

### Start from Markdown

Create a Google Doc from an existing Markdown file and register the pairing:

```sh
npm run cli -- create \
  --file "notes/example.md" \
  --name "Example"
```

The workspace defaults to the file's directory. If `--name` is omitted, the
title is derived from the filename with the current month appended.

### Start from a Google Doc

```sh
npm run cli -- pair \
  --url "https://docs.google.com/document/d/DOCUMENT_ID/edit" \
  --workspace "$HOME/dev/example-project" \
  --file "notes/example.md"
```

### Start from CSV files

Create a Google Sheet with one tab per selected CSV. The files must share a
parent directory and are moved into a new paired subdirectory:

```sh
npm run cli -- create-sheet \
  --file "Summary.csv" \
  --file "Transactions.csv" \
  --name "Budget"
```

### Start from a Google Sheet

```sh
npm run cli -- pair-sheet \
  --url "https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit" \
  --workspace "$HOME/dev/example-project" \
  --directory "data/budget"
```

## Finder Quick Actions

Install both Finder actions with:

```sh
npm run install-finder-action
```

For Markdown, Control-click one or more `.md` files and choose **Quick Actions
→ Sync with Google Docs (GDMS)**. GDMS creates one Google Doc per file and
registers each pairing.

For Sheets, select one or more `.csv` files in the same directory and choose
**Quick Actions → Sync with Google Sheets (GDMS)**. GDMS prompts for a name,
creates a collision-safe sibling directory, moves the files into it, and
creates one tab per CSV. If remote creation fails, the files remain together in
the new directory so the operation can be retried.

Re-run the installer after moving the repository or changing the Node
executable because the workflows store absolute paths.

## Raycast setup

The Raycast command reads the active Chrome Google Doc or Sheet, searches
project folders below `~/dev`, and registers the chosen local file or
directory.

```sh
cd raycast-extension
npm install
npm run dev
```

Keep the development command running while using the extension. `npm run
build` compiles it but does not register it in Raycast.

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
npm run cli -- configure-r2 --account-id ACCOUNT_ID --bucket BUCKET_NAME \
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
npm run install-service
```

See [IMAGE-SYNC.md](IMAGE-SYNC.md) for the transport design and safety model.

## Pairing manifest

Each participating workspace tracks `google-docs-sync.json`:

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

Paths are relative to the manifest. Do not add tokens, hashes, revisions, or
timestamps. Spreadsheet directories also contain a managed portable
`.google-sheets-sync.json` tab map and a human-readable `SYNC-STATUS.md`.

## Optional weekly heartbeat

Continue with [OPERATIONS.md](OPERATIONS.md#weekly-health-heartbeat) to install
the independent success email and learn where to find service logs.
