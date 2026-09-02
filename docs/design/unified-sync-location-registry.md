# Unified sync-location registry

## Decision

GDMS should replace the special discovery-root model and separate Raycast location storage with one GDMS-owned registry of explicitly configured sync locations. The CLI, daemon, and Raycast extension should use that registry as their shared source of truth. Routine synchronization should load known manifests directly; recursive searching should occur only when a location is added, when the user explicitly requests discovery, or when rebuilding a missing manifest index from intact location configuration.

## Implementation status

Both phases were implemented in version 0.8.8. The CLI, daemon, and Raycast use the shared registry; existing service and Raycast state migrate non-destructively; explicit scans maintain the derived index; and service logs use the standard macOS Logs directory.

## Why change

The current design gives `~/dev` a privileged role even though it is a personal convention rather than a standard macOS directory. It also divides configuration between the daemon's Application Support index and Raycast LocalStorage. That split makes it harder to explain which folders GDMS manages, gives different onboarding paths to project repositories and document archives, and retains a background discovery concept after routine polling has already moved to direct indexed manifest loading.

Users should be able to register a project folder, a broad document archive, or another local tree through the same interface and receive the same pairing, browsing, watching, reconciliation, rename, and recovery behavior. Configuration should describe user intent; the manifest index should remain derived state.

## Terminology

- A **sync location** is an explicitly configured local directory beneath which GDMS may discover and pair supported files. Examples include `/Users/roman/dev` and a local Google Drive archive ending in `/Roman`.
- A **pairing manifest** is a portable `google-docs-sync.json` stored within a sync location. Its paths remain relative to the manifest directory.
- The **manifest index** is a machine-local, rebuildable list of known manifest paths.
- **Discovery** is an explicit or lifecycle-triggered scan of configured sync locations. There is no permanently privileged discovery root.

The existing `--workspace` CLI spelling remains a deprecated compatibility alias for `--sync-location`. Historical changelog entries and the existing machine-local `workspaces.json` filename need not be rewritten without a migration reason.

## Sources of truth

GDMS should keep user configuration and derived state separate:

1. `sync-locations.json` is authoritative for the local directories the user has enrolled.
2. Portable `google-docs-sync.json` files are authoritative for pairings.
3. `manifest-index.json` is a rebuildable performance cache that maps the enrolled locations to known manifests.
4. `state.json` remains authoritative only for machine-local synchronization baselines, Drive cursors, incidents, and daemon identity.

Raycast LocalStorage must not remain an independent source of truth. Raycast should call shared GDMS registry operations or read and write the same validated registry through a narrow interface.

## macOS storage layout

Machine-local configuration belongs under the existing standard Application Support directory:

```text
~/Library/Application Support/google-docs-markdown-sync/
├── sync-locations.json
├── manifest-index.json
├── settings.json
├── runtime.json
└── state.json
```

OAuth refresh tokens, R2 secrets, and email credentials remain in the macOS Keychain. Logs should move to `~/Library/Logs/google-docs-markdown-sync/` in the second phase. Rebuildable caches, if introduced, belong under `~/Library/Caches/google-docs-markdown-sync/`. LaunchAgent property lists remain under `~/Library/LaunchAgents/`.

Absolute sync-location paths are intentionally machine-specific and must not be written into portable pairing manifests or Git-tracked files.

## Proposed registry formats

`sync-locations.json` records user choices and should use stable location IDs so a path change can be represented without conflating identity and location:

```json
{
  "version": 1,
  "locations": [
    {
      "id": "LOCATION_ID",
      "path": "/Users/example/dev"
    },
    {
      "id": "LOCATION_ID",
      "path": "/Users/example/Library/CloudStorage/ExampleDrive/Roman"
    }
  ]
}
```

`manifest-index.json` records only derived paths and their owning location IDs:

```json
{
  "version": 1,
  "manifests": [
    {
      "locationId": "LOCATION_ID",
      "path": "/Users/example/dev/project/google-docs-sync.json"
    }
  ]
}
```

Writes to both files must be atomic. Registry mutations must be single-flight or protected against concurrent read-modify-write loss when Raycast and CLI commands run while the daemon is active.

## Runtime behavior

### Adding a location

Adding a location validates and normalizes the selected directory, rejects duplicates and unsafe overlaps according to an explicit policy, writes the registry atomically, and performs a one-time manifest scan with visible progress. A large cloud-backed location must not be recursively enumerated during ordinary Raycast browsing or daemon polling.

The overlap policy should allow a broad location such as `/Users/example/dev` to contain independently manifested projects while preventing the same manifest from being indexed twice. Nested configured locations should either be rejected with a clear explanation or canonicalized to one owner; silent double ownership is not acceptable.

### Routine daemon polling

The daemon reads the configured locations and manifest index, validates that indexed manifests still exist, loads pairings directly, refreshes watchers for explicitly paired paths and assets, and polls the Google Drive changes feed. It does not recursively scan configured locations on the five-second loop.

### Finding existing pairings

`gdms location scan` and a Raycast **Find Existing Pairings** action rescan one or all configured locations. This operation is intended for a newly cloned repository, content copied into a location, setup on a new Mac, or recovery after index loss. It reports locations scanned, manifests found, stale entries removed, inaccessible directories, and elapsed time.

If `manifest-index.json` is absent or invalid while `sync-locations.json` remains valid, GDMS may rebuild the index before starting ordinary synchronization. The rebuild must be visible in logs and must not silently broaden the scan beyond configured locations.

If the entire Application Support registry is lost, GDMS cannot infer arbitrary prior paths. Onboarding should ask the user to select sync locations again and then reconstruct pairings from their portable manifests.

### Removing a location

Removing a location stops monitoring pairings owned by that location and removes its derived index entries. It must not delete local files, manifests, Google Docs, Google Sheets, or synchronization state without a separate explicit operation. The UI should preview how many pairings will stop syncing and explain that adding the location again restores discovery from the unchanged portable manifests.

## CLI and Raycast interface

The CLI should provide:

```text
gdms location list
gdms location add PATH
gdms location remove PATH
gdms location scan [PATH]
```

Names may be adjusted to fit the existing parser, but list, add, remove, and scan must be independently scriptable and return actionable errors. Destructive pairing deletion must remain separate from location removal.

Raycast should show one **Sync Locations** list backed by the GDMS registry. Users can add one or more directories with the native folder picker, browse each location lazily, remove a location with an explicit explanation, and run **Find Existing Pairings**. The CLI path, Node path, and OAuth client path remain hidden technical configuration derived from `runtime.json`, which `gdms install-service` maintains.

## Migration and compatibility

Migration must be idempotent, non-destructive, and safe to repeat after interruption:

1. Read the existing Application Support `workspaces.json` manifest paths and derive candidate sync locations from their manifest parents.
2. Read the configured `GOOGLE_DOCS_SYNC_ROOT`, if present, as a migration candidate only; do not treat `~/dev` as a universal default on a fresh installation.
3. Merge normalized candidates without duplicates, write `sync-locations.json` atomically, build `manifest-index.json`, and retain `workspaces.json` for rollback during the compatibility window.
4. Continue accepting `--workspace` as an alias for `--sync-location` and keep reading the old index until migration has succeeded and been recorded.
5. Import existing Raycast LocalStorage locations during Phase 2 through a one-time Raycast migration path or explicit user confirmation if the storage cannot be read safely from GDMS.

The migration must not recursively scan the user's home directory, guess cloud-storage roots, or enroll paths merely because they contain Markdown files.

Rollback to the preceding release should remain possible because the old index is retained and portable manifests are unchanged. Cleanup of obsolete registry files should be a later explicit action after a compatibility window.

## Implementation phases

### Phase 1: shared registry foundation

- Add validated, atomic `sync-locations.json` and `manifest-index.json` readers and writers.
- Implement idempotent migration from `workspaces.json` and `GOOGLE_DOCS_SYNC_ROOT`.
- Add CLI list, add, remove, and scan operations.
- Make the daemon load pairings through the shared registry and derived index without a privileged discovery root.
- Retain old-index reads and `--workspace` compatibility for rollback.
- Cover fresh setup, repeated migration, concurrent registry writes, missing locations, inaccessible cloud folders, index reconstruction, removal without deletion, and rollback.

Phase 1 should preserve the current Raycast behavior until the shared registry and migration are proven independently.

### Phase 2: unified UI and filesystem cleanup

- Move Raycast from LocalStorage to the shared GDMS registry.
- Add unified add, browse, remove, and **Find Existing Pairings** actions.
- Remove obsolete discovery-root and separate project/archive settings.
- Move service logs to the standard macOS Logs directory with compatibility-aware installer behavior.
- Update onboarding, operations, recovery instructions, status output, and troubleshooting.
- Perform host-level validation with at least one project-tree location and one large cloud-backed archive.

## Risks and mitigations

- **Registry loss:** Portable manifests remain authoritative; reselecting locations and scanning rebuilds the index.
- **Concurrent writes:** Use atomic writes plus serialization or compare-and-retry semantics for registry mutations.
- **Large scans:** Scan only explicitly selected locations, never on the routine poll loop, show progress, skip known dependency/cache directories, and allow cancellation.
- **Cloud placeholders and permissions:** Report inaccessible paths without deleting registry entries or treating content as deleted; require local availability only for files that are actively paired.
- **Nested locations:** Define ownership deterministically and prevent duplicate manifest processing.
- **Interrupted migration:** Leave old state intact until the new registry and index have both been validated.
- **Removing a location:** Treat removal as stopping management, never as deleting paired content.
- **Older scripts:** Keep the `--workspace` alias and document the preferred replacement during the compatibility window.

## Acceptance criteria

- A fresh installation assumes no personal directory such as `~/dev`.
- Raycast, CLI commands, and the daemon display the same ordered set of sync locations.
- Adding `/Users/example/dev` or a cloud-backed `/Roman` archive uses the same registry and capabilities.
- Adding or explicitly scanning a location discovers existing portable manifests beneath only that location.
- Routine five-second polling performs no recursive sync-location scan.
- Removing a location stops monitoring without deleting local or remote content.
- Deleting `manifest-index.json` and restarting reconstructs it from intact sync-location configuration with visible reporting.
- Losing all machine-local registry state leads to guided reselection rather than an unbounded filesystem search.
- Existing `workspaces.json` data and `--workspace` scripts continue to work throughout the compatibility window.
- Full automated tests and host-level Raycast/LaunchAgent checks pass with both a project tree and a large document archive.

## Non-goals

- Automatically synchronizing every Markdown or CSV file beneath a location.
- Mirroring an entire local folder tree into Google Drive.
- Guessing user directories or scanning the whole home directory.
- Changing the portable pairing-manifest schema solely for terminology.
- Deleting content when a location is removed.

Folder-wide automatic enrollment remains a separate feature governed by the [managed-folder synchronization design](managed-folder-sync.md).
