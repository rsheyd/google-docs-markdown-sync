# Scalable, wake-safe synchronization

GDMS currently performs a complete, sequential scan of every pairing, waits for the configured polling interval, and repeats. Each unchanged Google Doc still requires Drive metadata and the complete Docs document structure, while each unchanged spreadsheet requires a lightweight Drive request. This works for dozens of pairings but scales linearly, delays local work behind long remote passes, and allows requests suspended across laptop sleep to resume during unreliable DarkWake windows and enter ordinary error reporting.

The combined change should make normal synchronization proportional to actual changes while treating sleep and unstable wake networking as expected operating conditions. The implementation should remain a small extension of the existing daemon rather than introduce a general job queue, native macOS helper, or distributed synchronization architecture.

## Desired behavior

- Local filesystem changes continue to use the existing debounced watchers and trigger targeted pairing synchronization.
- Remote polling uses the Google Drive changes feed to identify changed paired files instead of fetching every paired file on every cycle.
- A saved Drive page token allows polling to resume after daemon restarts without rescanning every pairing.
- Several actual changes may sync concurrently, but concurrency remains small and bounded.
- Work that spans a likely sleep interval is discarded before it can report pairing errors, recover incidents, or persist stale synchronization state.
- After a likely wake, GDMS waits briefly, verifies Google API connectivity, and starts one fresh change-discovery and synchronization cycle.
- Connectivity loss is logged as one daemon-level paused condition. It does not create one notification incident per pairing.
- A periodic reconciliation scan detects missed Drive changes, damaged cursors, pairing changes, and other drift without making full scans the normal polling path.

## Current constraints

`runSyncPass` processes pairings sequentially and owns shared runtime state for the duration of the pass. `createSingleFlight` prevents overlapping remote and local passes, so a targeted local change waits behind a long complete scan. For Google Docs, `getRemoteInfo` requests both Drive metadata and the complete Docs structure before GDMS knows whether the pairing changed. The five-second poll interval begins after the pass finishes, making the effective revisit time `pass duration + interval`.

At large pairing counts, merely adding concurrency would reduce wall-clock time but would not reduce Google API traffic. The durable improvement must avoid unchanged-pairing requests during routine polling.

## Proposed design

### 1. Detect and invalidate sleep-crossing work

Maintain a daemon wake generation number and one lightweight liveness timer that runs independently of synchronization passes. When a liveness tick arrives substantially later than expected, increment the generation and mark the network gate as settling. Every local or remote synchronization cycle captures its starting generation.

Before a cycle persists synchronization state or invokes error reconciliation, compare its generation with the current generation. If they differ, discard the cycle results, log one concise interruption message, and schedule a fresh cycle after wake settling. Do not report pairing failures, clear existing incidents, or send recovery email from the discarded cycle.

This generation check must cover both scheduled remote work and targeted local work because either may be suspended while a laptop sleeps. The liveness timer must continue while a pass is in flight; reusing only the polling delay between passes would fail to detect sleep that begins during a long pass. Native IOKit power notifications are unnecessary if delayed liveness ticks, result persistence, and notification side effects are guarded together.

The wake-settling gate should remain simple:

1. Wait a configurable short interval after detecting wake.
2. Resolve the Google API hostname.
3. If unavailable, remain paused and retry with the existing bounded backoff.
4. Once available, run one fresh remote change check before resuming ordinary timing.

The initial default should be longer than the current five seconds but still modest, such as 15 seconds. Live validation should determine whether 15 seconds is enough before increasing it.

### 2. Add Drive incremental change discovery

Add a small Drive change-source module responsible for obtaining a start page token, polling `changes.list`, following `nextPageToken` pagination, and persisting the final `newStartPageToken`. Request only fields needed to identify relevant changes and continue pagination.

Build an in-memory map from paired Drive file ID to pairing at the start of each poll. Ignore changes for unpaired Drive files. Treat removed or trashed paired files as targeted pairing events so existing deletion and recovery behavior remains authoritative.

Persist the Drive cursor in machine-local runtime state, never in tracked pairing manifests. Advance the cursor only after all pages have been read successfully and the corresponding targeted sync results have been safely persisted. If the process stops, sleeps, or fails before that point, retaining the old cursor may replay changes, which must be safe and is preferable to skipping them.

On first use, obtain and save a start page token, then perform one complete reconciliation scan to establish current baselines. Do not replay the account's historical Drive activity.

If Google rejects or invalidates a stored cursor, log the reset, acquire a new token, and schedule a reconciliation scan. Cursor reset should not create per-pairing incidents.

### 3. Separate discovery from targeted synchronization

Refactor the daemon loop into two explicit stages:

1. Discover changed pairing IDs through the Drive changes feed.
2. Synchronize only those pairings through the existing `syncPairing` logic.

Keep local watcher events targeted by absolute path. Merge remote and local targets into a deduplicated pending set so repeated signals for the same pairing coalesce into one synchronization attempt.

Preserve single ownership of runtime-state persistence, but do not require every operation to wait behind a complete scan. A minimal scheduler may drain a pending set in bounded batches; it does not need priorities, durable individual jobs, worker processes, or a general-purpose queue.

### 4. Use small bounded concurrency

Process independent targeted pairings with a default concurrency of four. Keep all work for an individual pairing serialized, and update shared state only through one coordinator after each batch completes.

When Google returns rate-limit or server errors, reduce pressure through the existing bounded exponential backoff rather than increasing concurrency. Concurrency should be configurable for diagnostics, but four should remain the supported default until live tests demonstrate a need to change it.

Deletion processing, incident reconciliation, and state-file writes must remain deterministic when a batch completes out of order. Accumulate results in memory, then apply state and notification effects in stable pairing order.

### 5. Retain periodic reconciliation

Run a complete pairing reconciliation infrequently as a safety net, initially once every 24 hours and once after cursor initialization or reset. Reconciliation may process pairings in bounded batches and yield between batches, but it must not overlap ordinary targeted work.

The reconciliation path should verify Drive revision metadata before fetching full document structure. For unchanged Docs, use the lightweight Drive metadata result to skip `docs.documents.get`; fetch the complete Docs representation only when the Drive revision changed or a local edit requires conflict and formatting analysis.

This lightweight-first behavior is useful beyond reconciliation and should become the shared `syncPairing` fast path. It avoids full document downloads even when a pairing is explicitly checked but unchanged.

## State changes

Extend machine-local runtime state with a versioned remote-change section containing the Drive page token, the time of the last successful incremental poll, and the time of the last complete reconciliation. Do not place volatile timestamps or tokens in `google-docs-sync.json`.

State writes must remain atomic. Cursor advancement and pairing baseline changes produced by one cycle should be committed together where practical; if separate writes are retained, the cursor must be written last so a crash replays rather than skips work.

Do not persist the wake generation. A daemon restart naturally begins a new execution generation and uses the saved Drive cursor to rediscover uncommitted remote changes.

## Error and notification rules

- A DNS failure before discovery pauses the daemon and produces no pairing incidents.
- An operation interrupted by a likely sleep transition produces no pairing incident or recovery transition.
- A failure limited to one pairing after stable connectivity is available continues through the existing persistent incident reporter.
- A Drive changes-feed failure is a daemon-level remote-discovery incident, not a separate incident for every pairing.
- Rate limits and Google server failures use bounded backoff and preserve the current cursor.
- Successful processing after a previously emailed genuine pairing failure may still send the existing recovery email.
- Replayed Drive changes must not create duplicate writes or duplicate notifications.

## Implementation sequence

Implement and validate the work as four ordered phases. Each phase should remain an atomic, independently testable checkpoint. Do not begin the next phase until the preceding phase passes its automated tests, installed-service smoke test, and phase-specific live checks. Keep the complete scanner available through Phase 3 so every checkpoint has a conservative fallback and rollback does not depend on newer cursor state. Intermediate development versions may be consolidated when they were never published.

### Phase 1: wake-safe lifecycle

Status: implemented for the consolidated version 0.8.5 release.

- Add an independent liveness timer and wake generation tracking around daemon cycles.
- Prevent interrupted results from persisting state or reaching notification reconciliation.
- Increase and document the wake-settling default.
- Add deterministic tests for sleep during an in-flight pass, sleep during targeted local work, unavailable networking after wake, and a clean fresh pass after recovery.

This phase directly stops the observed overnight alert storm and provides the cancellation boundary needed by later incremental polling.

Phase 1 is complete when closing the laptop during an active pass, waking without networking, and later regaining networking produce no interrupted-work error or recovery email and one fresh pass succeeds after wake.

### Phase 2: lightweight unchanged checks

Status: implemented for the consolidated version 0.8.5 release.

- Split Google Doc Drive metadata lookup from complete Docs retrieval.
- Use Drive revision and local state to skip complete document retrieval when both sides are unchanged.
- Fetch full Docs content only for remote changes, local conflict analysis, formatting repair, status repair, or content operations that require it.
- Add request-count tests for unchanged Docs and Sheets.

This phase reduces load immediately while keeping the existing complete-scan loop as a fallback.

Phase 2 is complete when request-count tests and live instrumentation confirm that an unchanged Google Doc requires only lightweight Drive metadata, while remote edits, local edits, formatting repair, status repair, and conflict handling still fetch full content when required.

### Phase 3: incremental Drive polling

Status: implemented for the consolidated version 0.8.5 release.

- Add start-token acquisition, paginated change polling, paired-ID filtering, cursor persistence, and invalid-cursor recovery.
- Replace routine complete scans with targeted sync batches derived from Drive changes.
- Merge local and remote target signals without losing changes received while a batch is running.
- Add replay, crash-before-cursor-write, pagination, unpaired-change, trashed-file, restart, and cursor-reset tests.

Phase 3 is complete when quiet polling has constant request cost with respect to pairing count, local and remote edits remain timely, a daemon restart resumes from its saved cursor, interrupted cycles safely replay changes, and invalid-cursor recovery completes through reconciliation without losing edits.

### Phase 4: reconciliation and measured concurrency

Status: implemented for the consolidated version 0.8.5 release. Daily reconciliation, state and heartbeat timing, and scale fixtures were added. Synthetic quiet polls remained one discovery request at 100, 1,000, and 10,000 pairings. Live sequential timings were approximately 0.5 seconds for one target, under 10 seconds for five active targets, and under 18 seconds for a 38-pair reconciliation, so bounded concurrency was not added; the deterministic single-owner state coordinator remains responsive enough for current use.

- Schedule daily complete reconciliation and expose its timing in logs and health output.
- Validate behavior with synthetic registries containing 100, 1,000, and 10,000 inert pairings without making live API calls for every fixture.
- Measure targeted batch latency and backlog behavior after Phase 3 under routine and bursty workloads.
- Add a four-pairing concurrency limit only if measurements show that sequential targeted batches create meaningful delay.
- If concurrency is added, apply state and notification effects deterministically after concurrent work and prove that each pairing remains serialized.

Phase 4 is complete when scheduled reconciliation repairs simulated cursor or state drift without indefinitely blocking targeted work and scale fixtures remain bounded in memory and API demand. Concurrency is not an exit requirement if Phase 3 measurements show that sequential targeted processing is already responsive.

## Future reconciliation scaling trigger

The current sequential reconciliation is appropriate for the active installation: a live 38-pair scan completed in under 18 seconds, while ordinary polling remains constant-cost and targeted. Revisit the reconciliation scheduler when a complete scan regularly exceeds 30–60 seconds, local edits are observably delayed behind reconciliation, the pairing registry grows into the hundreds, or routine burst batches become noticeably slow. Synthetic 10,000-pair tests prove that quiet change discovery is bounded; they do not prove that a complete sequential reconciliation is fast enough at that scale.

The recommended upgrade is a cooperative batch scheduler rather than a general job queue:

1. Divide reconciliation into bounded batches, initially around 20 pairings.
2. Commit each completed batch through one state coordinator in stable pairing order.
3. Between batches, drain pending local watcher and Drive-change targets so maintenance cannot starve ordinary synchronization.
4. After the batching boundary is proven, process up to four independent pairings concurrently within a batch.
5. Preserve serialization for each pairing, bounded Google backoff, wake-generation checks, deterministic notification handling, and cursor-last persistence.
6. Record `lastReconciledAt` only after every batch finishes; interrupted work may safely restart or resume without claiming a complete reconciliation.

Adding concurrency requires separating pairing computation from shared side effects. Workers should read local and Google state and return proposed results without writing the shared state file or reconciling notifications. A single coordinator should then apply results, state changes, deletion retries, and notification transitions atomically and deterministically. Sequential batching should be implemented first because it fixes local-edit starvation with less risk; four-way concurrency should follow only when measurements show that batch duration itself remains problematic.

Validation for this upgrade should measure total reconciliation time, maximum delay imposed on a local edit, pending-target drain latency, Google request and rate-limit behavior, memory use, crash replay, sleep interruption, and deterministic state and notification results at 100, 1,000, and 10,000 pairings. A useful success criterion is that local and incremental remote targets begin within one batch duration even while a large reconciliation is underway.

The phases remain distinct implementation and validation checkpoints. Because none of the intermediate versions after 0.8.4 were published, all four phases are consolidated into the 0.8.5 release and changelog entry.

## Validation and observability

Add one concise summary log per discovery cycle containing the number of Drive changes read, paired targets found, pairings synchronized, errors, and elapsed time. Do not log every unchanged pairing. Reconciliation logs should identify that the expensive fallback is running and report progress in bounded intervals.

Unit tests should use injected clocks, wait functions, Drive responses, and synchronization operations. No test should depend on actually sleeping the machine. Request-count assertions should prove that a quiet incremental poll is constant-cost with respect to pairing count.

Before release, run the complete test suite, restart the installed LaunchAgent, and perform live checks covering a local edit, a remote edit, simultaneous changes to several files, closed-lid sleep followed by wake, offline wake, daemon restart with an existing cursor, and a forced reconciliation. Review Google API request logs or instrumentation to confirm that a quiet poll does not fetch every paired document.

## Success criteria

- A quiet routine poll uses only the bounded Drive changes-feed request count, regardless of whether 10 or 10,000 files are paired.
- A local edit is not delayed by a complete remote scan under normal operation.
- A remote edit is discovered and synchronized within the configured poll cadence plus normal API latency.
- Closing the laptop during active synchronization does not send error or recovery email for the interrupted work.
- Waking without network access produces one paused log state and no pairing alert storm.
- Restarting or crashing between change discovery and cursor persistence replays work without losing changes or duplicating user-visible notifications.
- Daily reconciliation can repair deliberately simulated cursor or state drift without blocking ordinary work indefinitely.

## Non-goals

- Native IOKit sleep/wake integration.
- Push notifications or Google Workspace webhook infrastructure.
- A durable per-pairing job database.
- Multiple worker processes or distributed coordination.
- Removing the existing filesystem watcher.
- General-purpose Google Drive mirroring or automatic adoption of unpaired files.
- Guaranteeing immediate synchronization while the laptop is closed or asleep.

## Documentation and release impact

Each implemented phase changes user-visible polling, wake, retry, performance, or notification behavior and must increase the package version with matching `CHANGELOG.md` notes. Update `docs/operations.md` in each phase with the behavior and defaults introduced by that phase; update the README only if its high-level synchronization description or scale expectations need clarification.
