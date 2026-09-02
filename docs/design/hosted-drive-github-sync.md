# Hosted Google Drive–GitHub synchronization

## Status

This document describes a potential hosted product derived from GDMS. It is not part of the current local application roadmap or an implementation commitment. The offshoot would reuse GDMS's conversion, pairing, conflict, and reconciliation concepts while replacing its local-filesystem endpoint with a bounded folder in a GitHub repository.

A related [hosted Drive sidecar design](hosted-drive-sidecar-sync.md) keeps both the Google-native and Markdown/CSV representations in the same Drive folder tree instead of using GitHub.

## Product concept

A user connects a Google account, installs a GitHub App, selects one Google Drive folder, and selects one folder within a public or private GitHub repository. The service continuously synchronizes the two bounded trees:

```text
Google Drive folder                    GitHub repository folder
├── Notes/                             ├── Notes/
│   └── Plan (Google Doc)       ↔      │   └── plan.md
└── Data/                              └── Data/
    └── Budget (Google Sheet)   ↔          └── budget/
                                               ├── Summary.csv
                                               └── Forecast.csv
```

Google Docs map to Markdown files. Google Sheets map to directories containing one CSV file per sheet tab, following GDMS's current spreadsheet abstraction. Google Drive subfolders map to repository subdirectories. The first release should support two-way creation, content updates, renames, and moves, while deliberately postponing automatic deletion.

The product remains a bounded document synchronizer rather than a general Drive or Git mirror. Only the selected Drive subtree and repository folder are in scope. Unsupported Google files and repository content outside the selected path are ignored.

## Relationship to GDMS

The hosted service should extract and reuse platform-neutral GDMS modules for Markdown conversion, Google Docs incremental updates, Sheets/CSV conversion, canonical content hashing, and conflict classification. It should not reuse assumptions about local paths, filesystem watchers, launchd, Keychain, Raycast, or machine-local sync-location registries.

GDMS's portable-manifest principle remains useful, but the hosted product needs its own manifest and service-state contract. A manifest committed within the selected repository folder may record stable Google object IDs and relative repository paths. OAuth credentials, GitHub installation IDs, revisions, hashes, jobs, incidents, and audit records remain encrypted service-side state and must never enter the repository manifest.

The local GDMS product and hosted offshoot should share a conversion library rather than one application depending directly on the other's daemon or storage layout.

## Recommended infrastructure

The initial service can use a conventional managed Google Cloud stack without Kubernetes or permanent virtual machines:

| Responsibility | Product |
| --- | --- |
| Web application, API, OAuth callbacks, and webhook ingress | Google Cloud Run service |
| Durable asynchronous synchronization queue | Google Cloud Tasks |
| Synchronization execution | Separate Google Cloud Run worker service |
| Tenants, connections, pairings, revisions, jobs, conflicts, and audit events | Cloud SQL for PostgreSQL |
| Google refresh tokens, GitHub App private key, webhook secrets, and application secrets | Secret Manager, optionally protected with customer-managed Cloud KMS keys |
| Periodic reconciliation and Google notification-channel renewal | Cloud Scheduler |
| Short-lived conflict and recovery artifacts | Cloud Storage |
| Structured logs, metrics, traces, dashboards, and alerts | Cloud Logging and Cloud Monitoring |
| Container images | Artifact Registry |
| Build and deployment | Cloud Build or GitHub Actions with workload identity federation |
| Repository authorization and change delivery | GitHub App installation tokens and webhooks |
| Document authorization and change delivery | Google OAuth, Drive notifications and changes feed, Docs API, and Sheets API |

Cloud Run services are appropriate because webhook handlers return quickly and ordinary synchronization tasks should be short and idempotent. Exceptionally large reconciliations can be partitioned into resumable tasks rather than relying on one long request. Cloud Run Jobs may later handle bulk migrations or deliberate whole-tree audits, but are unnecessary for the normal event path.

## Component and event flow

```text
Google Drive notification ─┐
                           ├──▶ webhook API ──▶ durable task queue
GitHub push webhook ────────┘                       │
                                                   ▼
                                           pairing sync worker
                                      ┌────────────┴────────────┐
                                      ▼                         ▼
                              Google Workspace APIs        GitHub APIs
                                      └────────────┬────────────┘
                                                   ▼
                                       baseline and audit state
```

Webhook handlers authenticate the sender, store a deduplicated event marker, enqueue the affected connection or pairing, and return without performing synchronization. Google Drive notifications indicate that changes are available rather than containing the complete change, so the worker reads the Drive changes feed. GitHub push events identify the repository, branch, commit, and candidate paths.

All events converge on the same reconciliation workflow. Cloud Tasks provides delivery and retry; PostgreSQL supplies authoritative job state and a transaction or advisory lock that permits only one active reconciliation per folder pairing. Duplicate or rapidly repeated events are coalesced. Each operation is idempotent because webhook delivery, task execution, and API responses may be duplicated or interrupted.

Cloud Scheduler periodically enqueues reconciliation for every active connection to recover missed events, detect drift, and renew expiring Google notification channels. Routine event-driven synchronization remains targeted; periodic work must be rate-limited and partitioned by tenant.

## Connection and pairing model

The web application guides the user through:

1. Signing in to the service.
2. Authorizing Google with offline access to the minimum required Drive, Docs, and Sheets scopes.
3. Installing the GitHub App on selected repositories with the minimum repository permissions required for contents, metadata, pull requests, and webhooks.
4. Selecting one Drive folder by stable folder ID.
5. Selecting one GitHub repository, branch, and folder path.
6. Previewing the initial mapping, name normalization, unsupported objects, existing content, and potential collisions.
7. Choosing a GitHub write policy and confirming initial reconciliation.

A folder-pairing record should contain the tenant, Google connection, Drive root ID, GitHub installation and repository IDs, target branch, repository root path, write policy, notification cursors, status, and timestamps. Child-pairing records should contain stable Google object IDs, repository-relative paths, object types, Google revisions, Git commit and blob identifiers, canonical hashes, and conflict status.

Paths are mutable presentation state, not identity. Google file IDs identify remote Workspace objects. Git commit and blob identifiers provide concurrency baselines, while an internal child-pairing ID links the two sides across moves and renames.

## Two-way synchronization semantics

Every worker begins by reading current state from both services and comparing it with the last verified common baseline:

- A Google-only content change converts the Doc or Sheet and commits the resulting Markdown or CSV changes to GitHub.
- A GitHub-only content change converts the Markdown or CSV representation and applies an incremental update to the existing Google object.
- A one-sided rename or move updates the other tree while preserving the stable child identity.
- A newly created supported Google object creates the corresponding repository representation.
- A newly created supported repository representation creates the corresponding Google object in the correct Drive folder.
- A deletion on either side records a pending deletion incident but does not delete or trash the counterpart in the first release.
- Incompatible changes on both sides create a conflict and stop automatic writes for that child until resolution.

The baseline advances only after both sides have been read back or otherwise verified. Workers use the expected Google revision and Git branch/blob state as compare-and-swap guards so an edit arriving during synchronization cannot be silently overwritten.

Folder creation, rename, and movement require an explicit path normalization policy. Duplicate Google names are legal within one Drive folder but conflicting repository paths are not; initial mapping and later reconciliation must surface those collisions rather than choosing one object implicitly.

## GitHub write policy

The recommended default is a dedicated synchronization branch with one continuously updated pull request. This preserves repository review, branch protection, automated checks, and an understandable audit trail. An optional direct-commit mode can target repositories where the user explicitly accepts immediate updates.

Single-file Markdown changes may use GitHub's repository contents API. Multi-file changes, including a Sheet's CSV files, image assets, moves, and manifest updates, should create Git blobs and a tree, create one commit, and advance the branch reference only after the complete tree is ready. The worker must reject a stale expected branch head and reconcile again instead of force-updating it.

Commits created by the service need recognizable authorship and metadata so their webhook deliveries can be treated as confirmation rather than new user edits. Loop prevention must still depend on verified commit and content baselines, not merely on author names or commit messages.

## Conflicts and recovery

The service must not use latest-timestamp-wins when both sides changed. It should preserve the Google export, repository version, last common baseline, relevant revisions, and a human-readable explanation. The web application can then offer side-by-side comparison and explicit choices to keep Google, keep GitHub, or upload a manually merged Markdown or CSV representation.

Conflict and recovery artifacts should be short-lived, encrypted, tenant-scoped, and access-controlled. Resolution writes must run through the same guarded synchronization workflow rather than bypassing concurrency checks.

Automatic deletion is postponed, but deletion signals still require durable treatment. The first release should mark the child as missing on one side, stop synchronization for it, and provide non-destructive restore or unpair choices. Later deletion support requires grace periods, previews, Drive trash handling, reversible CSV-tab recovery, and explicit policy per folder pairing.

## Security and privacy boundary

The hosted service can read and modify selected private Google and GitHub content, so its trust boundary must be explicit. Required controls include:

- minimum OAuth scopes and GitHub App permissions;
- encryption of every refresh token and private credential at rest;
- short-lived GitHub installation tokens;
- verified Google channel identifiers and GitHub webhook signatures;
- tenant isolation in every database, queue, cache, log, and object key;
- no credentials, document bodies, signed URLs, or private repository content in normal logs;
- short default retention for transient document content and recovery artifacts;
- auditable connection, synchronization, conflict-resolution, and revocation events;
- complete account disconnection and tenant-data deletion workflows; and
- no execution of repository code or rendering of untrusted Markdown as active HTML.

OAuth verification, privacy disclosures, data-retention policy, incident response, abuse controls, backups, and regional data handling are product requirements rather than post-launch hardening tasks.

## Initial delivery phases

### Phase 0: shared engine extraction and contract

- Extract conversion, canonicalization, and conflict logic from local filesystem orchestration.
- Define the hosted manifest, database model, supported content contract, naming rules, and GitHub write policies.
- Validate Google Drive folder and change-feed behavior, GitHub branch protection, duplicate names, Sheets/CSV mapping, and required OAuth scopes.

### Phase 1: connected preview and one-time synchronization

- Build account onboarding, Google folder selection, GitHub App installation, repository-folder selection, and a complete dry-run preview.
- Import one bounded tree in either selected direction without ongoing webhooks.
- Create guarded Git commits and incremental Google updates while recording verified baselines.

### Phase 2: event-driven two-way synchronization

- Add Google Drive notifications, GitHub push webhooks, Cloud Tasks, serialized workers, and periodic reconciliation.
- Support two-way creation, content changes, renames, and moves for Docs/Markdown and Sheets/CSV.
- Add conflict preservation, resolution UI, operational dashboards, quotas, retry controls, and connection recovery.
- Treat deletions as non-destructive incidents rather than propagated operations.

### Phase 3: production hardening

- Complete OAuth verification, security review, tenant deletion, backup restoration, audit export, rate-limit testing, and webhook-loss exercises.
- Add subscription, usage metering, support tooling, service-level objectives, and incident-response procedures if the product is offered commercially.
- Validate public and private repositories, organizations, branch-protected repositories, shared Drives, large folder trees, and partially accessible content.

### Later: recoverable deletion and broader fidelity

- Add opt-in, grace-period deletion propagation with previews and recovery.
- Extend image and richer formatting support as the shared GDMS engine matures.
- Consider a hybrid agent mode for customers who do not want document contents processed by a hosted worker.

## Principal risks

- **Simultaneous edits:** Two-way synchronization can overwrite work unless both Google and GitHub writes use verified baselines and stop on divergence.
- **Folder ambiguity:** Duplicate Drive names, unsupported objects, and many-to-one normalized paths can make a tree impossible to represent faithfully in Git.
- **Webhook reliability:** Notifications can be duplicated, delayed, or missed, requiring idempotent tasks and periodic reconciliation.
- **Feedback loops:** Service-generated commits and Google writes generate new events and must converge through baseline checks.
- **Credential exposure:** A breach could expose access to private documents and repositories; narrow permissions, encryption, isolation, revocation, and minimal retention are foundational.
- **API quotas and cost:** Large folders or high-frequency edits can create expensive reconciliation and conversion workloads; quotas and per-tenant backpressure are necessary.
- **Branch workflow mismatch:** Pull-request mode is safer but not instantaneous on the repository's default branch; direct mode is immediate but bypasses review.
- **Product coupling:** Sharing application-specific daemon code would make both products harder to evolve; only platform-neutral synchronization modules should be shared.

## Open decisions

- Is the initial GitHub write policy always pull-request based, user-selectable, or direct for personal repositories?
- Does the service support one folder pairing per repository path, or multiple non-overlapping pairings?
- How are duplicate Google names represented deterministically in repository paths?
- Does one Google Sheet always map to a CSV directory, and how are empty or renamed tabs represented?
- Which side supplies metadata such as titles when filenames and Google titles diverge?
- What conflict-resolution experience is sufficient for Markdown formatting and multi-tab Sheets?
- What content-retention promise is both operationally practical and credible to privacy-sensitive users?
- Should a later hybrid mode keep conversion and plaintext content on a user-controlled agent?

## References

- [Google Drive push notifications](https://developers.google.com/workspace/drive/api/guides/push)
- [Google Drive change tracking](https://developers.google.com/workspace/drive/api/guides/about-changes)
- [Google OAuth for web-server applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [GitHub App webhooks](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps)
- [GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [GitHub repository contents API](https://docs.github.com/en/rest/repos/contents)
- [GitHub Git database API](https://docs.github.com/en/rest/git)
- [Cloud Run request timeouts](https://docs.cloud.google.com/run/docs/configuring/request-timeout)
- [Cloud SQL for PostgreSQL high availability](https://docs.cloud.google.com/sql/docs/postgres/configure-ha)
- [Secret Manager encryption](https://docs.cloud.google.com/secret-manager/docs/encryption)
