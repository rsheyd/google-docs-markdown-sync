# Privacy-preserving telemetry design

## Status

This document records a proposed telemetry contract and phased implementation plan. GDMS does not currently collect or transmit telemetry. Implementation must begin with local-only aggregation and payload preview; no network submission should ship until the schema, consent text, receiver, retention policy, and public documentation have been reviewed together.

## Purpose

GitHub traffic and release downloads measure discovery and acquisition but cannot show whether an installation completes setup, remains active, synchronizes reliably, or uses particular workflows. Optional GDMS telemetry should answer only these product questions:

- How many opted-in installations are active?
- Do installations complete authorization and start the daemon?
- Are Google Docs, Google Sheets, images, Finder Quick Actions, and Raycast used?
- How often do synchronization passes succeed, make changes, stop safely, or fail?
- Which coarse error categories account for failures?
- Which GDMS versions and installation channels remain active?

Telemetry must not be used to reconstruct a user's documents, projects, collaborators, working schedule, or identity. It is directional product evidence rather than billing, security, or availability data; the unauthenticated client channel cannot guarantee that every submitted record is genuine.

## Product and privacy principles

- Telemetry is disabled by default and begins only after explicit consent.
- No daemon or other background process prompts for consent.
- A disabled installation makes no telemetry network request.
- Collection is a once-daily aggregate, not a stream of per-operation events.
- Local counters are updated off the synchronization critical path and contain no document content or identifiers.
- Telemetry submission never delays, fails, or changes a synchronization result.
- The client and receiver use explicit allowlists and reject unknown fields.
- Users can inspect the exact next payload, disable collection, reset the installation identifier, and request deletion of retained installation-level records.
- The public schema, retention period, receiver behavior, and source code ship before or with network submission.

## Consent and controls

The first suitable interactive setup command, such as `gdms authorize` or `gdms install-service`, may offer telemetry once when attached to a TTY. Homebrew installation must remain non-interactive, and an unattended daemon must treat an absent decision as disabled.

Suggested consent text:

> Help improve GDMS by sending a once-daily usage summary. It contains the GDMS version, coarse feature usage, and categorized success/failure counts—never document content, names, paths, IDs, or Google account information. Telemetry is disabled by default.

The prompt should link to the public schema and privacy documentation, accept an explicit yes or no, and record that the question was answered so later commands do not nag. These commands provide durable control:

```text
gdms telemetry enable
gdms telemetry disable
gdms telemetry status
gdms telemetry preview
gdms telemetry reset-id
gdms telemetry delete
```

`preview` prints the exact normalized payload that would be submitted next without sending it. `disable` stops collection and submission immediately but retains the local random identifier so a later re-enable does not create a false new installation. `reset-id` deletes local telemetry counters and identity before creating a new identifier if telemetry remains enabled. `delete` asks the receiver to remove retained records associated with the current identifier and then disables telemetry locally; failure must be reported clearly without affecting synchronization.

Enabling telemetry creates a random identifier locally. It is pseudonymous, not anonymous, because it links daily records over time. Documentation and user-facing copy must use that distinction accurately.

## Prohibited data

The client must never collect or submit:

- Document, spreadsheet, Drive, tab, revision, comment, or OAuth identifiers.
- Document titles, file or directory names, local paths, repository names, URLs, or synchronized content.
- Google account details, OAuth material, R2 credentials, notification addresses, or other secrets.
- Hostnames, usernames, serial numbers, hardware identifiers, IP addresses, or precise locations.
- Raw exceptions, logs, stack traces, API responses, HTTP bodies, or arbitrary error strings.
- Exact event timestamps, exact document sizes, exact file sizes, or unbounded counts that could fingerprint an installation.

The receiver inevitably observes a source IP while accepting an HTTPS request. It must use the IP only transiently for abuse controls, must not write it or a derived location to application storage, and must disable or minimize infrastructure request logging wherever the hosting platform permits. The receiver must not persist user-agent headers.

## Payload schema

One record represents one UTC calendar day. The initial schema should remain deliberately small:

```json
{
  "schema": 1,
  "period": "2026-09-11",
  "installation_id": "random UUID created after consent",
  "gdms_version": "0.8.11",
  "platform": {
    "macos_major": 27,
    "architecture": "arm64",
    "install_channel": "homebrew"
  },
  "configuration": {
    "pairings_bucket": "6-10",
    "docs_enabled": true,
    "sheets_enabled": true,
    "images_configured": false,
    "raycast_installed": true,
    "finder_actions_installed": true
  },
  "activity": {
    "sync_passes": 24,
    "docs_changed": 4,
    "sheets_changed": 1,
    "successes": 23,
    "safety_stops": 0,
    "failures": {
      "network": 1
    }
  }
}
```

Allowed platform values are coarse: macOS major version only, `arm64` or `x64`, and a small installation-channel enum such as `homebrew`, `source`, or `unknown`. Pairing counts use fixed buckets: `0`, `1`, `2-5`, `6-10`, `11-25`, and `26+`. Activity counters are non-negative integers capped at a documented daily maximum; excess activity saturates at the cap instead of expanding the fingerprint. Configuration reflects the end-of-day state and does not include configuration-change times.

Failure categories are a closed enum: `auth`, `network`, `rate_limit`, `remote_api`, `local_io`, `configuration`, `conflict`, `safety_stop`, and `unknown`. Classification happens near known error boundaries and never includes an exception message. Schema changes require a new integer version and continued receiver support for a documented compatibility window.

## Local state and aggregation

Telemetry state belongs under GDMS's machine-local application-support directory, never in portable pairing manifests or synchronized Markdown. The implementation must account for the existing strict settings schema through an explicit settings migration rather than silently changing the meaning of version 1.

Each completed sync path increments in-memory or machine-local counters through a narrow telemetry interface. Instrumentation receives enum values and numbers, not pairing objects, paths, API responses, or error objects. The daily record is finalized by UTC date, written atomically, and submitted at most once per day with jitter so installations do not contact the receiver simultaneously.

The submission key is the tuple of schema version, installation identifier, and UTC period. The receiver treats retries idempotently. A failed submission uses bounded exponential backoff independent of synchronization and retains at most seven unsent daily records; older records are dropped rather than creating an indefinite behavioral history on disk. Offline operation remains fully supported.

## Receiver

Use a dedicated telemetry endpoint rather than adding telemetry responsibilities to the image-staging gateway. A separate Cloudflare Worker is a natural deployment option because GDMS already uses Cloudflare, but the storage product is an implementation choice rather than part of the client contract.

The receiver must:

- Accept HTTPS `POST` requests with JSON only and a small request-size limit.
- Validate the exact schema, enums, formats, nesting, and numeric ranges; reject unknown fields.
- Hash the submitted installation identifier with a server-held keyed hash before storage and discard the submitted value after request processing.
- Upsert records idempotently by hashed identifier, schema, and UTC period.
- Apply abuse limits without retaining IP addresses or user agents.
- Return a simple success or validation response without reflecting submitted data.
- Keep telemetry unavailable without affecting any synchronization or image-staging endpoint.
- Provide an identifier-based deletion path and document its authentication and abuse tradeoffs.
- Publish deployment configuration that makes request-log and raw-data retention behavior reviewable.

There is no durable client secret suitable for proving that a submission came from genuine GDMS code. The receiver should use validation and rate limits to control obvious abuse and should treat all aggregate conclusions as approximate.

## Retention and analysis

Installation-level daily records should have a short, published retention period of 30 to 90 days; choose the exact period before network submission ships. Aggregated counts that can no longer be traced to an installation may be retained indefinitely. Backups and derived tables must follow the same deletion and retention policy as their source data.

Initial reporting should remain limited to the stated product questions: daily and monthly active opted-in installations, setup completion, versions, installation channels, coarse feature adoption, success rate, safety-stop rate, and failure-category distribution. Small cohorts must be suppressed or combined so reports do not expose individual installation behavior.

## Failure isolation

- Telemetry code must never throw through a synchronization, authorization, installation, heartbeat, or daemon loop.
- Collection and submission must be single-flight and bounded by short timeouts.
- Receiver errors, invalid responses, DNS failures, and offline state produce only a debounced local diagnostic.
- Telemetry retries use their own bounded backoff and cannot consume the Google API retry budget.
- Shutdown does not wait for telemetry delivery.
- Disabling telemetry cancels pending submissions and deletes unsent daily records.

## Delivery phases

### Phase 1: local-only prototype

- Define the schema, enums, caps, buckets, and prohibited-field checks in a small dedicated module.
- Add machine-local aggregation and atomic UTC-day rollover.
- Implement `status`, `preview`, and reset behavior while keeping submission impossible.
- Exercise real local usage and inspect payloads before approving a receiver design.

### Phase 2: receiver and privacy verification

- Deploy a separate receiver with strict schema validation, idempotency, keyed identifier hashing, retention enforcement, and minimized logs.
- Add automated tests that submit valid, duplicate, malformed, oversized, and unknown-field payloads.
- Document hosting configuration, data flow, retention, deletion, and operational ownership.
- Perform a focused privacy and security review before enabling a client network path.

### Phase 3: explicit opt-in release

- Add the interactive consent prompt and all telemetry commands.
- Enable once-daily submission only after consent.
- Publish the schema and privacy documentation and update installation and operations guides.
- Increase the GDMS version and record the user-visible behavior under that exact version in `CHANGELOG.md`.
- Validate Homebrew installation, source installation, daemon restart, offline use, disabling, identifier reset, deletion, and receiver outage behavior.

### Phase 4: evidence-driven refinement

- Compare telemetry with GitHub traffic and release-download trends without treating any source as a direct installation count.
- Add a field only when it answers a named product question that existing fields cannot answer.
- Remove fields that do not affect decisions.
- Revisit retention and identifier stability after enough usage exists to measure their actual value.

## Test and acceptance criteria

- With telemetry absent, declined, or disabled, all existing tests pass and no telemetry hostname is contacted.
- `preview` exactly matches the normalized payload accepted by receiver validation.
- Instrumentation APIs cannot accept strings, paths, document objects, errors, or arbitrary metadata.
- Unknown payload fields and values outside documented ranges are rejected client-side and server-side.
- Daily rollover, clock changes, duplicate delivery, retries, seven-day pending-record limits, and counter saturation are deterministic.
- Telemetry failures never change a sync result, exit code, status sidecar, conflict decision, or heartbeat result.
- Enabling, disabling, resetting, and deleting behave consistently across CLI and daemon restarts.
- No token, secret, document identifier, path, content fragment, raw error, IP address, or user agent appears in stored receiver records or application logs.
- Public documentation names the data pseudonymous, lists every transmitted field, states the exact retention period, and explains how to inspect and stop collection.

## Decisions required before implementation

- Choose whether the first consent opportunity belongs in `authorize`, `install-service`, or a separate onboarding step.
- Choose the daily counter caps and the installation-channel detection rules.
- Select the receiver's storage system and exact raw-record retention period.
- Define deletion authentication while avoiding a new durable client secret.
- Decide whether stable installation identity is valuable enough to retain across telemetry disable and re-enable.
- Decide whether feature flags should mean configured, exercised during the period, or both; the schema must not blur those meanings.
