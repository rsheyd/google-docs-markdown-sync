# Hosted Google Drive sidecar synchronization

## Status

This document describes a potential hosted product derived from GDMS. It is not part of the current local application roadmap or an implementation commitment. The offshoot would continuously synchronize native Google Docs and Sheets with ordinary Markdown and CSV sidecar files stored beside them in the same bounded Google Drive folder tree.

## Product concept

A user connects a Google account and selects one Google Drive folder. The service inventories only that subtree and maintains paired editable and portable representations:

```text
Selected Google Drive folder
├── Project Plan                 Google Doc
├── Project Plan.md              Markdown sidecar
├── Budget                       Google Sheet
├── Budget - Summary.csv         CSV sidecar for the Summary tab
├── Budget - Forecast.csv        CSV sidecar for the Forecast tab
└── Research/
    ├── Findings                 Google Doc
    └── Findings.md              Markdown sidecar
```

The first release should support two-way creation, content updates, renames, and folder moves. Automatic deletion should be postponed: if either representation disappears, the service records an incident and pauses that pairing without deleting or trashing its counterpart.

The product remains a bounded document synchronizer rather than a general Drive backup or mirror. Only the explicitly selected Drive subtree is in scope. Unsupported Google files and ordinary uploaded files that do not match the configured sidecar policy are ignored.

## Why this offshoot is distinct

Unlike local GDMS, this product has no required local filesystem, launchd daemon, Raycast extension, machine-local sync-location registry, or Keychain state. Unlike the [hosted Drive–GitHub offshoot](hosted-drive-github-sync.md), both representations live in Google Drive and therefore share one folder graph, identity system, authorization relationship, changes feed, and provider API.

That makes the infrastructure and reconciliation boundary simpler, but it provides no Git commits, pull requests, branch protection, or repository publishing workflow. Its strongest uses are portable sidecars, cloud-based indexing and retrieval, Drive for desktop access, Markdown-aware tools, data export, and preserving editable non-Google representations near their source documents.

The local product and both hosted offshoots should share platform-neutral conversion, canonicalization, update-planning, and conflict-classification modules rather than depending on one another's orchestration or storage implementation.

## Representation model

Google Docs map to adjacent Markdown blob files with the same normalized base name and a `.md` extension. A Google Sheet maps to one CSV blob per tab because CSV itself cannot represent multiple tabs. The initial naming recommendation is `Sheet title - Tab title.csv`, with stable Drive file IDs retained so later title changes do not break identity.

An alternative is a sibling directory such as `Budget CSV/` containing `Summary.csv` and `Forecast.csv`. The directory model avoids crowded parent folders and filename collisions, while the adjacent-file model more literally keeps sidecars next to the Sheet. The choice must be explicit before implementation and reversible through a migration plan.

Drive permits duplicate filenames within one folder, so names cannot establish pairing identity. The service should store stable IDs for the Google-native file and every sidecar blob. It may also write private application properties to aid recovery, but the service database remains authoritative for synchronization baselines and must tolerate properties being removed or copied.

## Recommended infrastructure

The initial service can use a managed Google Cloud stack without Kubernetes or permanent virtual machines:

| Responsibility | Product |
| --- | --- |
| Web application, API, OAuth callbacks, and Drive notification ingress | Google Cloud Run service |
| Durable asynchronous synchronization queue | Google Cloud Tasks |
| Synchronization execution | Separate Google Cloud Run worker service |
| Tenants, Drive roots, pairings, IDs, revisions, jobs, conflicts, and audit events | Cloud SQL for PostgreSQL |
| Google OAuth refresh tokens and webhook/application secrets | Secret Manager, optionally protected with customer-managed Cloud KMS keys |
| Periodic reconciliation and notification-channel renewal | Cloud Scheduler |
| Short-lived conflict and recovery artifacts | Cloud Storage |
| Structured logs, metrics, traces, dashboards, and alerts | Cloud Logging and Cloud Monitoring |
| Container images | Artifact Registry |
| Build and deployment | Cloud Build or GitHub Actions with workload identity federation |
| Document access and change delivery | Google OAuth, Drive notifications and changes feed, Drive file upload/download, Docs API, and Sheets API |

Webhook handlers should return quickly and place authenticated event markers onto Cloud Tasks. Cloud Run workers then perform bounded, idempotent reconciliation. Large initial inventories or deliberate whole-tree audits can later use partitioned Cloud Run Jobs, but normal synchronization should remain targeted.

## Component and event flow

```text
Google Drive notification
          │
          ▼
   Cloud Run webhook API
          │
          ▼
      Cloud Tasks
          │
          ▼
 Cloud Run sync worker
   ┌──────┴────────┐
   ▼               ▼
Docs/Sheets APIs   Drive blob upload/download
   └──────┬────────┘
          ▼
  PostgreSQL baseline and audit state
```

Google Drive notifications indicate that changes are available rather than carrying the complete changed content. The worker reads the Drive changes feed from the last committed page token, filters events to selected roots and known pairings, and reconciles affected objects. Both Google-native files and uploaded Markdown or CSV blobs appear through the same Drive change mechanism.

Cloud Scheduler periodically enqueues reconciliation to recover missed notifications, renew expiring notification channels, verify folder containment, and detect drift. PostgreSQL transaction or advisory locks permit only one active reconciliation for a pairing or affected folder scope. Duplicate events are coalesced, and every operation is idempotent because notifications, tasks, and API responses can be repeated or interrupted.

## Onboarding and configuration

The web application guides the user through:

1. Signing in to the service.
2. Authorizing Google with offline access to the minimum required Drive, Docs, and Sheets scopes.
3. Selecting one Drive root by stable folder ID.
4. Choosing a sidecar naming policy and whether unpaired native or sidecar files should create counterparts automatically.
5. Previewing supported objects, proposed pairs, collisions, duplicate names, unsupported content, and write operations.
6. Selecting the authoritative direction for initial enrollment when both representations already exist.
7. Confirming initial reconciliation.

A root record should contain the tenant, Google connection, Drive root ID, sidecar policy, creation policy, change cursor, channel state, status, and timestamps. Pairing records should contain stable native and sidecar Drive IDs, object type, relative folder context, Google document or spreadsheet revisions, sidecar blob revisions, canonical hashes, tab identities, and conflict status.

Configuration is service-side and machine-independent. A small visible manifest inside the selected Drive root could make the relationship inspectable and portable, but it is optional because the sidecars and native files already share one provider. If introduced, it must contain only stable IDs, relative presentation paths, and policy—not OAuth credentials, revisions, hashes, incidents, or tenant secrets.

## Two-way synchronization semantics

Every worker reads current state for both representations and compares it with the last verified common baseline:

- A Google Doc-only change updates the paired Markdown blob.
- A Markdown-only change applies an incremental update to the paired Google Doc.
- A Google Sheet-only change updates the affected tab's CSV blob.
- A CSV-only change updates the paired Sheet tab.
- A one-sided native-file rename renames its sidecar or sidecars according to policy.
- A one-sided sidecar rename may rename the native object only when pairing identity and the naming transformation are unambiguous.
- Moving either representation within the selected tree moves its counterpart while preserving stable file IDs.
- A newly created supported Google Doc or Sheet may create its sidecar representation.
- A newly created Markdown or conforming CSV sidecar may create its Google-native counterpart if automatic creation is enabled.
- A deletion records a non-destructive missing-side incident and pauses the pairing in the first release.
- Incompatible changes to both representations create a conflict and stop automatic writes until resolution.

The baseline advances only after both sides have been read back or otherwise verified. Workers use expected Google document or spreadsheet revisions and expected Drive blob revisions as concurrency guards. An edit that arrives during synchronization causes a fresh reconciliation rather than an overwrite.

Service-generated changes produce new Drive events. Loop prevention must use stable file IDs, verified revisions, operation IDs, and canonical content hashes; timestamps and filenames alone are insufficient.

## Tree, naming, and pairing behavior

Folder membership is determined by stable parent IDs and ancestry beneath the selected root. A folder or file moved outside that root becomes a non-destructive out-of-scope incident. A file moved back before resolution can resume its existing pairing.

The service needs deterministic normalization for Google titles that are invalid, ambiguous, or inconvenient as Markdown and CSV filenames. Duplicate Google names, case-folding collisions, reserved characters, and a user-created blob occupying a proposed sidecar name must be surfaced in preview or conflict state rather than silently overwritten.

The service must distinguish generated sidecars from unrelated `.md` and `.csv` files. Stable database pairings are authoritative. Optional Drive application properties or a root manifest may improve recovery, but filename patterns alone cannot authorize writes.

For Sheets, each tab must retain a stable tab identity independently of its CSV filename. Tab creation, rename, reordering, and deletion can then be distinguished from CSV file creation, rename, and disappearance. Automatic tab deletion remains postponed until a reversible recovery artifact and grace-period policy exist.

## Conflicts and recovery

The service must not use last-modified-time-wins when both sides changed. It should preserve the native export, sidecar content, last common baseline, relevant revisions, and a human-readable explanation. The web application can offer explicit choices to keep the Google-native version, keep the sidecar, or upload a manually merged representation.

Conflict and recovery artifacts should be encrypted, tenant-scoped, access-controlled, and retained only for a documented short period. Resolution writes run through the same guarded workflow as ordinary synchronization.

Deletion signals initially pause synchronization and offer restore, replace, or unpair actions. Later automatic deletion requires an opt-in policy, grace period, preview, Drive trash restoration, and CSV-tab recovery. A missing sidecar must never cause immediate deletion of a Google Doc or Sheet.

## Permissions and sharing

Creating a sidecar in the same Drive folder generally places it within the same folder boundary, but file-level permissions and externally owned content can differ. The service must check effective capabilities before every write and cannot assume that access to a parent implies permission to modify every child.

The first version should preserve each file's existing permission model and avoid attempting to mirror arbitrary file-level sharing changes. The UI should explain when collaborators can edit the Google-native file but cannot see or modify its sidecar, or vice versa. Shared Drives, shortcuts, externally owned files, and partially accessible subtrees require explicit validation before support is claimed.

## Security and privacy boundary

The service can read and modify private Drive content, so it is a trusted content processor. Required controls include:

- minimum Google OAuth scopes and incremental authorization where practical;
- encrypted refresh tokens and application secrets;
- verified Drive notification channel identifiers and unguessable channel tokens;
- tenant isolation in database rows, queue tasks, caches, logs, and object keys;
- no credentials, document bodies, signed URLs, or private filenames in ordinary logs unless explicitly required and redacted;
- short default retention for transient content and conflict artifacts;
- auditable authorization, synchronization, conflict-resolution, and revocation events;
- complete disconnection and tenant-data deletion workflows; and
- no rendering of untrusted Markdown as active HTML.

OAuth verification, privacy disclosures, retention policy, abuse controls, backups, incident response, and regional data handling are launch requirements.

## Initial delivery phases

### Phase 0: product and representation contract

- Extract platform-neutral GDMS conversion, canonicalization, and conflict logic.
- Choose the Sheets sidecar layout, naming policy, creation policy, manifest strategy, and supported content contract.
- Validate Drive changes, blob revisions, application properties, duplicate names, moves, permissions, Shared Drives, and API scopes.

### Phase 1: connected preview and one-time synchronization

- Build Google authorization, root-folder selection, sidecar-policy setup, and a complete dry-run preview.
- Import one bounded tree in a selected initial direction.
- Create Markdown and CSV blobs or Google-native counterparts while recording stable IDs and verified baselines.

### Phase 2: event-driven two-way synchronization

- Add Drive notifications, Cloud Tasks, serialized workers, and periodic reconciliation.
- Support two-way creation, content changes, renames, and moves for Docs/Markdown and Sheets/CSV.
- Add conflict preservation, resolution UI, operational dashboards, quotas, retry controls, and connection recovery.
- Treat deletions and moves outside the selected tree as non-destructive incidents.

### Phase 3: production hardening

- Complete OAuth verification, security review, tenant deletion, backup restoration, audit export, load testing, and notification-loss exercises.
- Validate personal Drives, Shared Drives, externally owned objects, duplicate names, large trees, and partially accessible content.
- Add subscription, usage metering, support tooling, service-level objectives, and incident-response procedures if offered commercially.

### Later: recoverable deletion and broader fidelity

- Add opt-in, grace-period deletion propagation with previews and recovery.
- Extend image and richer formatting support as the shared GDMS engine matures.
- Consider user-selectable hidden sidecar directories or alternate serialization formats.

## Principal risks

- **Simultaneous edits:** Two-way synchronization can overwrite work without revision guards and conflict stops.
- **Feedback loops:** Every service write generates another Drive event and must converge through verified baselines.
- **Duplicate names:** Drive allows folder siblings that cannot map cleanly to unique sidecar filenames.
- **Sidecar discoverability:** Visible generated files may clutter Drive; hidden subfolders reduce clutter but weaken the "next to the source" concept.
- **Sheets mapping:** Multi-tab Sheets require multiple CSV blobs and stable tab-to-file identity.
- **Permission asymmetry:** Native files and sidecars may not have identical effective access even in the same folder.
- **Credential exposure:** A breach could expose private Drive content; narrow scopes, encryption, isolation, revocation, and minimal retention are foundational.
- **API quotas and cost:** Large roots or frequent edits can make conversion and reconciliation expensive without quotas and per-tenant backpressure.
- **Product coupling:** Only platform-neutral GDMS modules should be shared; cloud orchestration must remain independent of the local daemon.

## Open decisions

- Should Sheet tabs use adjacent `Sheet - Tab.csv` files or a sibling sidecar directory?
- Should newly discovered Google-native files automatically create sidecars?
- Should newly discovered Markdown and CSV blobs automatically create native counterparts?
- Is a visible root manifest worthwhile, or is service-side pairing state sufficient?
- How should duplicate Google names and case-insensitive filename collisions be represented?
- Should a sidecar rename change the Google title, or should Google-native titles remain authoritative?
- How should file-level sharing differences be displayed and resolved?
- What conflict-resolution experience is sufficient for formatting-heavy Markdown and multi-tab Sheets?
- What content-retention promise is operationally practical and credible?

## References

- [Google Drive API](https://developers.google.com/workspace/drive/api/reference/rest/v3)
- [Create and manage Drive files](https://developers.google.com/workspace/drive/api/guides/create-file)
- [Google Drive push notifications](https://developers.google.com/workspace/drive/api/guides/push)
- [Google Drive change tracking](https://developers.google.com/workspace/drive/api/guides/about-changes)
- [Google Workspace export formats](https://developers.google.com/workspace/drive/api/guides/ref-export-formats)
- [Google OAuth for web-server applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Cloud Run request timeouts](https://docs.cloud.google.com/run/docs/configuring/request-timeout)
- [Cloud SQL for PostgreSQL high availability](https://docs.cloud.google.com/sql/docs/postgres/configure-ha)
- [Secret Manager encryption](https://docs.cloud.google.com/secret-manager/docs/encryption)
