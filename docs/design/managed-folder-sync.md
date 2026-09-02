# Managed folder synchronization

## Status

This document records a potential future GDMS feature for review. It is not an
implementation commitment, and none of the behavior below is currently
available. The design should be revisited after operational hardening,
conflict recovery, pairing controls, and the application namespace migration.

## Product intent

A user selects a local folder with a Finder Quick Action or CLI command and
explicitly enrolls the complete folder tree in GDMS. GDMS creates a
corresponding Google Drive folder tree and continuously manages Markdown and
CSV content beneath the enrolled root.

The feature should extend GDMS's explicit-pairing model rather than turn GDMS
into a general-purpose Drive mirror. Only a deliberately enrolled local root
and its corresponding Drive subtree are in scope. Ordinary file and
spreadsheet pairings remain the default workflow.

The proposed mental model is:

```text
one managed local root ↔ one bounded Google Drive subtree
each Markdown file    ↔ one Google Doc
each CSV directory    ↔ one Google Sheet, with one CSV per tab
```

A managed folder is not a sync location. A sync location is a machine-local directory registered with this GDMS installation; a managed folder is a portable, manifest-controlled subtree inside one registered sync location. Initial enrollment must require containment within a registered location or explicitly offer to register an appropriate parent first. The same sync location may contain ordinary pairing manifests and multiple non-nested managed-folder manifests.

Using one Sheet per CSV directory is the leading recommendation, not yet a
settled requirement. It preserves GDMS's existing spreadsheet abstraction,
avoids encoding recursive paths into globally unique tab names, and makes the
Drive tree understandable. An alternative is one Sheet for the entire managed
root with relative CSV paths stored as tab identities; that option should be
evaluated before implementation.

## Fit with GDMS

Managed folders fit GDMS if enrollment stays explicit, scope stays bounded,
and destructive changes remain conservative and recoverable. The design
continues these existing principles:

- Portable, inspectable pairing manifests inside sync locations identify the local and remote objects under management; the sync-location registry itself remains machine-local configuration.
- Stable Google IDs are authoritative; filenames and titles are not identities.
- Runtime hashes, revisions, filesystem identities, timestamps, operation
  journals, and credentials remain outside Git.
- Synchronization passes remain single-flight, local changes remain debounced,
  and transient remote failures use bounded exponential backoff.
- Unchanged document ranges are preserved and existing document and
  spreadsheet adapters remain the content-sync primitives.
- Missing local content is not interpreted as intentional deletion until move
  detection and a configured grace period have elapsed.

The feature adds greater ownership and risk than an ordinary pairing. GDMS
would create child pairings in response to filesystem activity, reconcile two
editable folder trees, and potentially perform many related remote operations.
For that reason, managed folders need an explicit pairing type and stronger
safety and recovery rules rather than being implemented as a thin bulk-create
command.

## Enrollment and scope

The anticipated entry points are a **Sync folder with GDMS** Finder Quick
Action and an equivalent CLI command. Initial enrollment should:

1. Recursively inventory supported local files and directories.
2. Show a preview of the Docs, Sheets, tabs, and Drive folders that would be
   created or adopted.
3. Detect existing ordinary pairings, nested managed roots, duplicate names,
   unsupported paths, and ambiguous CSV groupings.
4. Require explicit confirmation before making Google changes.
5. Create or identify one Drive folder as the remote boundary.
6. Register completed child objects incrementally so an interrupted run can be
   resumed without creating duplicates.
7. Register the managed-folder manifest in the machine-local manifest index so ordinary daemon loading finds it without recursively scanning the surrounding sync location.

All `.md` and `.csv` files recursively beneath the enrolled root are intended
to be included. No general user-authored include/exclude language is currently
proposed. GDMS must nevertheless ignore its own operational artifacts and
files that cannot safely represent user content, including:

- pairing manifests and managed status files;
- spreadsheet tab-map metadata;
- Markdown image asset directories;
- hidden operating-system files such as `.DS_Store`;
- temporary editor and atomic-write files; and
- nested managed-folder manifests, which should be rejected rather than
  silently skipped.

Symlink behavior requires an explicit decision. The safest initial behavior is
to reject symlinked files and directories so enrollment cannot escape the
managed root or introduce cycles.

## Portable manifest and runtime state

The managed-root rule belongs in a visible manifest inside the enrolled local
folder. The precise schema should be designed alongside migration support; a
conceptual shape is:

```json
{
  "version": 2,
  "managedFolder": {
    "driveFolderId": "GOOGLE_DRIVE_FOLDER_ID",
    "driveFolderUrl": "https://drive.google.com/drive/folders/GOOGLE_DRIVE_FOLDER_ID",
    "csvMapping": "sheet-per-directory"
  },
  "pairings": [
    {
      "type": "document",
      "documentId": "GOOGLE_DOCUMENT_ID",
      "markdownPath": "subfolder/note.md"
    },
    {
      "type": "spreadsheet",
      "spreadsheetId": "GOOGLE_SPREADSHEET_ID",
      "directoryPath": "data"
    }
  ]
}
```

This example is illustrative. A version-2 manifest is not necessarily
required; a backward-compatible folder-rule field may be preferable. The
chosen format must keep paths relative and portable and must exclude hashes,
revisions, timestamps, filesystem inode data, pending operations, and tokens.

The manifest index remains derived state: deleting it and explicitly scanning the containing sync location must rediscover the managed-folder manifest without reconstructing any portable pairing data. The stable machine-local sync-location ID may associate an indexed manifest with its configured location, but it must not become the portable identity of the managed folder. The Drive folder ID and manifest-relative structure provide the durable cross-machine identity.

Paths cannot be the sole identity because paths change during renames and
moves. Google object IDs provide stable remote identity. Runtime state should
also retain local filesystem identity when available so GDMS can distinguish a
move from deletion followed by creation. Copy-and-delete moves, moves while
the daemon is stopped, and cross-filesystem moves need recovery heuristics and
must fail safely when identity is ambiguous.

## Local-to-Google behavior

Ongoing managed-folder synchronization necessarily observes the enrolled subtree, but it must not restore broad recursive sync-location polling. The daemon should attach scoped filesystem watchers to enrolled managed roots, maintain incremental inventory state, and reserve complete subtree walks for enrollment, explicit reconciliation, or recovery. Unrelated portions of a broad location such as `~/dev` or a cloud archive must remain outside that work.

### Directories and Markdown

- Creating a local subfolder creates the corresponding Drive folder.
- Creating a Markdown file creates and registers a Google Doc in the
  corresponding Drive folder.
- Renaming Markdown renames the existing Google Doc, consistent with current
  pairing behavior.
- Moving Markdown within the managed root moves the existing Doc to the
  corresponding Drive folder and updates its portable relative path.
- Moving a local subfolder moves the corresponding Drive folder without
  recreating its children.
- Moving content outside the managed root is treated as a possible deletion,
  subject to move detection and the deletion grace period.

### CSV and Sheets

The leading mapping is one local CSV directory to one Google Sheet, with one
CSV per tab. Under that model:

- The first CSV in a directory creates a Sheet in the corresponding Drive
  folder.
- Additional CSV files in that directory create tabs in the same Sheet.
- Renaming a CSV renames its existing tab while preserving tab identity.
- Moving a CSV within one directory is a rename. Moving it between directories
  transfers its content to the destination Sheet and removes it from the
  source only after the destination write and verification succeed.
- An empty CSV directory needs a defined policy: retain an empty paired Sheet,
  begin a deletion grace period, or remove only the pairing. Retaining it is
  the safest initial behavior.

Cross-spreadsheet tab moves are not atomic in Google APIs. Before removing the
source tab, GDMS must create and verify the destination tab and retain enough
recovery information to undo or resume a partially completed move.

## Google-to-local behavior

Remote changes must remain within the paired Drive subtree:

- Renaming or moving a paired Google Doc within the subtree renames or moves
  its Markdown file locally.
- Remote edits to paired Docs and Sheets continue through the existing content
  adapters.
- A Google Doc explicitly paired with a local directory already covered by a
  managed root is created at that local path, enrolled in the managed manifest,
  and moved into the sibling Drive folder.
- Remote Docs newly placed in the managed Drive subtree may eventually be
  adopted automatically and materialized as Markdown in the corresponding
  local folder.
- Remote Sheet tabs may eventually create, rename, move, or delete CSV files
  according to the selected CSV mapping.

Automatic adoption of arbitrary remote-created Docs and tabs should be phased
in after local-authoritative folder management is proven. An explicit **Add to
managed folder** action is a safer first release because it avoids adopting
shortcuts, unsupported Google file types, or objects placed in the folder by
another collaborator without understanding the local consequences.

Objects outside the paired Drive subtree must never be adopted merely because
they share a title or were previously located inside it.

## Deletion and recovery

Current automatic deletion is installation-wide, opt-in, and limited to
Markdown/Google Docs pairings. A missing Markdown file starts a move-detection
and grace-period workflow; only after that period can GDMS move the Google Doc
to Drive trash and send an idempotent notification. Managed-folder deletion
should inherit this safety model rather than make deletion propagation an
implicit consequence of enrollment.

Proposed behavior after explicit deletion propagation is enabled:

- A deleted Markdown file moves its paired Doc to Drive trash after the grace
  period.
- A deleted CSV removes its paired tab only after the grace period.
- A deleted local subfolder begins a single recoverable tree operation rather
  than independently racing deletion of every descendant.
- Reappearance or detected movement cancels pending deletion.
- Failed notification does not repeat or reverse a completed remote operation;
  notification delivery remains idempotent and retryable.

Sheet tabs do not have Drive's ordinary trash semantics. Before removing a tab,
GDMS should copy its values, formulas, stable metadata, and source context into
a recovery artifact or recovery spreadsheet. The recovery mechanism, retention
period, and explicit restore command must be designed and tested before CSV
deletion propagation ships.

Bulk unpairing must distinguish three operations: stop managing the tree while
leaving both sides intact, remove only local representations, and trash remote
content. Only the first should be a routine non-destructive default.

Removing the containing sync location is broader but still non-destructive: it pauses every ordinary pairing and managed folder indexed beneath that location without changing portable manifests or deleting local or Google content. Re-adding and scanning the location restores discovery. Stopping management of one managed folder must remain a separate, explicit operation.

## Partial operations and idempotency

Initial enrollment and later reconciliation can partially succeed because
each Drive folder, Doc, Sheet, tab, manifest update, and state update is a
separate operation. The implementation needs a bounded operation journal in
machine-local runtime state.

Each operation should have a stable idempotency key and explicit phases, such
as planned, remote-created, locally-recorded, verified, and complete. On
restart, GDMS should inspect remote IDs and local state before retrying. In
particular, a remote object that was created before a manifest write failed
must be adopted by ID rather than created again.

Successful entries should remain committed when an unrelated entry fails.
Transient API and quota errors should retry with bounded exponential backoff;
permanent or ambiguous errors should pause the affected entry without
blocking unrelated pairings.

## Conflicts and concurrent tree edits

The existing content-conflict rules remain applicable within each child
pairing. Folder management additionally needs explicit handling for:

- simultaneous local and remote moves of the same object;
- a local path occupied while a remote rename targets it;
- two remote objects with titles that map to the same Markdown or CSV name;
- case-only renames on case-insensitive local filesystems;
- a local delete concurrent with a remote edit;
- a directory move concurrent with a child move; and
- CSV tab transfers interrupted between destination creation and source
  removal.

Ambiguous structural conflicts should not use later-modification-wins. GDMS
should preserve both sides, stop the affected structural operation, and
produce an actionable conflict record. Conflict-copy and user-notification
work on the main roadmap is therefore a prerequisite for unattended managed
folders.

## Status, logging, and notifications

Managed folders need visibility at three levels:

- Structured service logs identify the managed root, local relative path,
  remote ID, operation, retry state, and error without exposing credentials or
  signed URLs.
- A human-readable status file in the managed root summarizes child pairings,
  pending enrollment, moves, deletions, conflicts, and failures.
- Deduplicated macOS notifications alert the user to actionable failures and
  provide a path to the status file or recovery command.

Persistent API failures must not produce a notification storm. A later
notification channel may reuse the existing email infrastructure, but managed
folder synchronization should not depend on email being configured.

## Proposed delivery phases

### Phase 0: finalize the product contract

- Choose one-Sheet-per-directory or one-Sheet-per-root CSV mapping.
- Define symlink, empty-directory, Google shortcut, and unsupported-file rules.
- Define remote adoption and bulk-unpairing behavior.
- Specify manifest compatibility and the operation journal.
- Threat-model destructive and cross-spreadsheet operations.

### Phase 1: previewable local enrollment

- Add folder inventory and dry-run output.
- Add the CLI entry point and Finder Quick Action.
- Create the Drive tree, Docs, Sheets, and tabs idempotently.
- Record resumable child pairings and show aggregate status.
- Do not automatically adopt remote-created objects or propagate deletion.

### Phase 2: ongoing local-authoritative structure

- Detect newly created local files and directories.
- Propagate local renames and moves while retaining object identities.
- Support safe CSV tab renames and recoverable cross-Sheet moves.
- Add operation-journal recovery, notifications, and quota/load controls.

### Phase 3: recoverable deletion

- Extend opt-in deletion policy to managed Docs and CSV tabs.
- Add tab recovery artifacts and restore commands.
- Add subtree deletion planning, preview, cancellation, and recovery.

### Phase 4: broader remote reconciliation

- Propagate remote Drive renames and moves into the local tree.
- Add explicit remote-object enrollment into a managed root.
- After sufficient live validation, evaluate automatic adoption of remote Docs
  and Sheet tabs placed inside the paired Drive subtree.

## Prerequisites and validation

Before implementation, GDMS should have explicit unpairing and pairing-list
commands, recoverable conflict copies, actionable notifications, and reliable
operation-level retry and recovery. The design should be validated against
Drive API behavior for folder moves, duplicate names, shortcuts, ownership,
shared drives, trashed parents, and partially accessible subtrees.

The existing sync-location registry, manifest index, explicit scan operation, and non-destructive location removal provide the machine-local enrollment foundation, but they do not replace pairing-level listing, unpairing, managed-folder status, or recovery controls.

Tests should cover initial preview and enrollment, interruption after every
remote write, daemon restart recovery, rename and move identity, copy-delete
moves, nested folder moves, duplicate titles, case-only renames, quota errors,
concurrent local and remote changes, deletion cancellation, CSV recovery, and
strict scope containment. Live validation should begin with disposable Drive
folders and accounts before any existing sync location is enrolled.

## Open decisions

- Should CSV map to one Sheet per local directory or one Sheet for the entire
  managed root?
- Are remote-created Docs adopted automatically, only through an explicit
  action, or through a per-root option?
- What recovery representation and retention period make tab deletion safely
  reversible?
- How are empty local directories and empty Sheets represented?
- Are Drive shortcuts, shared drives, and externally owned documents allowed?
- How should a managed root behave when only part of its Drive subtree remains
  accessible?
- Does managed-folder metadata extend the version-1 manifest or require a new
  version and migration?
- What rate and object-count limits keep polling and initial enrollment
  practical?

