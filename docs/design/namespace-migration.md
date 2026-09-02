# Application namespace migration

GDMS currently uses `com.roman.google-docs-markdown-sync` for launchd jobs and
macOS Keychain services. The durable replacement is
`io.github.rsheyd.google-docs-markdown-sync`.

This migration must preserve unattended synchronization, OAuth authorization,
R2 access, heartbeat email delivery, and rollback to an older checkout. The
legacy identifiers remain active until the compatibility implementation is
released; adding this plan does not rename a running service.

## Identifier inventory

| Purpose | Legacy identifier | New identifier |
| --- | --- | --- |
| Sync launchd label and plist | `com.roman.google-docs-markdown-sync` | `io.github.rsheyd.google-docs-markdown-sync` |
| Heartbeat launchd label and plist | `com.roman.google-docs-markdown-sync.heartbeat` | `io.github.rsheyd.google-docs-markdown-sync.heartbeat` |
| OAuth and Resend Keychain service | `com.roman.google-docs-markdown-sync` | `io.github.rsheyd.google-docs-markdown-sync` |
| R2 access-key service | `com.roman.google-docs-markdown-sync.r2-access-key` | `io.github.rsheyd.google-docs-markdown-sync.r2-access-key` |
| R2 secret-key service | `com.roman.google-docs-markdown-sync.r2-secret-key` | `io.github.rsheyd.google-docs-markdown-sync.r2-secret-key` |
| R2 gateway-secret service | `com.roman.google-docs-markdown-sync.r2-gateway-secret` | `io.github.rsheyd.google-docs-markdown-sync.r2-gateway-secret` |

Application Support paths, manifest names, environment variables, package
names, and CLI commands are already project-oriented and do not need to move.

## Phase 1: compatibility release

Centralize both namespaces in one module and add tests covering every derived
label, plist path, and Keychain service. Keychain reads must try the new service
first and then the legacy service. When only a legacy value exists, copy it to
the new service with the same account name and leave the original untouched.
All subsequent writes go to the new service.

The copy must happen independently for OAuth, Resend, and each R2 secret so a
partially configured installation remains recoverable. Logs may identify the
migrated credential category, but must never contain credential values.

During this phase the installed launchd labels stay legacy. That separates the
credential migration from the process-manager migration and allows the new
dual-read code to be exercised without changing daemon identity.

## Phase 2: launchd cutover

Update both installers to write the new plist filenames and labels. Before
bootstrapping a new job, the installer must inspect and boot out both the new
and legacy labels and paths. It then bootstraps exactly one new job and verifies
that its label is loaded. The sync daemon and heartbeat job must be migrated
independently because users may install only one of them.

Do not delete legacy plist files until the corresponding new job has loaded successfully. After verification, remove only the known legacy plist file; do not touch other LaunchAgents. Application Support state and the standard `~/Library/Logs/google-docs-markdown-sync/` log directory stay in place.

Rollback remains possible because Phase 1 leaves legacy Keychain entries
intact. Reinstalling an older checkout can therefore restore the legacy
launchd label without requiring Google authorization or secret entry.

## Phase 3: compatibility window

Keep new-first, legacy-fallback Keychain reads for at least two subsequent
minor releases. Emit one concise migration warning when a fallback is used so
an installation that skipped the compatibility release is visible without
failing. Installation and troubleshooting documentation must cover direct
upgrades from legacy releases throughout this window.

The compatibility tests must include a fresh installation, legacy-only
credentials, partially migrated credentials, repeated installation,
interrupted launchd cutover, heartbeat-only installation, and rollback to the
last legacy release.

## Phase 4: explicit legacy cleanup

After the compatibility window, stop creating legacy entries but retain
fallback reads unless there is strong evidence that direct upgrades no longer
need them. Provide an explicit, previewable cleanup command for deleting the
known legacy Keychain services and plist files. Cleanup must never be automatic
and must report each exact item before requiring confirmation.

Only a later major release may remove fallback reads. That release must call
out the reauthorization and secret-entry consequences for users who skipped
all migration-capable versions.

## Release and validation requirements

Each phase is a user-visible change and requires a version increase plus an
entry under that exact version in [`CHANGELOG.md`](../../CHANGELOG.md). Before release, run the full
test suite, lint both generated plists with `plutil`, and perform a host-level
smoke test of `launchctl print` and Keychain migration. Host tests must use
disposable test service names until the final install test, and must never log
secret values.
