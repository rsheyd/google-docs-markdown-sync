# Google Docs formatting sidecar

Status: deferred proposal, October 31, 2026. Roman requested that this discussion be saved for later review. Neither the full sidecar nor the reduced-cost snapshot variant is approved for implementation. This proposal is separate from the hosted Drive sidecar offshoot.

## Context and preservation fix

Roman customized the WilliNet staff editing guide in Google Docs, then changed “Home, Watch, Events and Shop” from Heading 2 to Heading 3 in its paired Markdown. Unrelated Google Docs formatting was lost.

An isolated native-copy experiment reproduced changes in 128 matched paragraphs. The push replaced the edited heading, replaced the unrelated native title, and issued 130 paragraph-style requests during post-push reconciliation. Unchanged-sync controls preserved formatting in that experiment.

The preservation fix developed in this chat removed broad automatic paragraph-spacing normalization, recognized native-title and export-omitted empty-paragraph differences, and patched heading-level-only changes in place. Live testing revealed that Google clears explicit text formatting even for a namedStyleType-only update, so the fix restores explicit paragraph and text overrides in the same atomic batch. The final live test changed only the intended heading's namedStyleType; its ID, custom text formatting, and other matched paragraph formatting survived. All 312 tests and the Raycast type-check passed at that point, and the service was restarted with the fix. Recheck the current checkout and service before further implementation; this is historical validation, not proof of future behavior.

Local evidence is retained in `local-only/heading-format-test-2026-10-31/REPORT.md`, `local-only/heading-format-fix-2026-10-31/`, and `local-only/heading-format-final-2026-10-31/REPORT.md`. These directories contain private document copies, paired Markdown/assets, native snapshots, request captures, and comparison scripts. They are Git-excluded and are not fixtures available to other installations.

The fix is scoped to heading-level-only body edits and broad normalization. Arbitrary text replacement, combined text/style edits, ambiguous export mappings, and unsupported structural rebuilds still need separate preservation analysis. A sidecar must not become a prerequisite for preserving untouched content.

## Product intent and preferences

Roman proposed an adjoining file or gdms-formatting section to retain Google Docs-specific formatting such as fonts and heading styles. The preferred direction is an adjacent file, provisionally `filename.gdms.json`; the name and schema remain undecided.

Roman initially described the sidecar as optional, then clarified that users should not have to manually enable or disable it. It should appear automatically when users customize supported formatting in the paired Google Doc, keeping simple documents free of extra visible files. Changing a heading's semantic level is ordinary Markdown content; customizing its font, size, color, or spacing is a formatting change.

Existing precedents include the Sheets `GDMS.md` metadata file and Docs table-column-width metadata embedded in Markdown. No prior chat explicitly approving this specific Docs sidecar was located during the bounded history review.

## What the sidecar adds

A sidecar can make supported presentation choices inspectable, portable, and potentially editable locally. A later version could support deliberate recreation or restoration of a styled document. It does not itself prevent destructive sync writes: preservation must happen in the edit planner, without destroying and reapplying the whole document's formatting.

Document-wide defaults and named styles are a tractable initial scope: body font and size, Title/Subtitle/Heading 1–6 definitions, and selected spacing properties. Page size and margins are possible later additions. Direct formatting on individual paragraphs or text spans is a separate, harder problem because its association with content must survive edits, moves, and duplicate text. Named-style metadata alone would not cover every custom override involved in the staff-guide incident.

## Full proposal, still undecided

- Capture supported formatting changes from Docs into the adjacent file, updating it only when normalized values change.
- Allow deliberate local metadata edits to update only the corresponding supported Google Docs properties.
- Keep a common formatting baseline in machine-local state, separate from portable sidecar data, to distinguish local edits from newly observed remote changes.
- Never reapply an unchanged sidecar during an ordinary Markdown edit or overwrite newer Docs formatting with a stale snapshot.
- Define property-level conflict behavior before supporting simultaneous local and remote formatting edits. Preserve both versions and surface unresolved conflicts rather than silently choosing an appearance.
- Keep the schema versioned, deterministic, compact, and free of OAuth data, revisions, timestamps, and volatile API indexes.
- Define behavior for rename, move, copy, deletion, missing files, malformed JSON, and externally edited sidecars. Deleting a file must not reset the Doc's formatting; automatic recreation versus stopping capture remains an open decision.

## Automatic creation needs a concrete rule

There is no universally reliable “custom” font or style. Hard-coding Arial as standard would misclassify personal defaults and templates. Comparing direct formatting with inherited styles also misses changes to the named styles themselves.

For an already paired document, a recorded baseline can detect later supported formatting changes. At first pairing, there may be no evidence of what the user changed. Options include capturing all supported non-Markdown presentation when present, establishing a baseline and waiting for a later change, or defining a narrower observable trigger. These choices trade completeness against unwanted sidecar creation; none is settled.

The earlier suggestion to capture existing custom formatting immediately was a product preference, not a demonstrated detection algorithm. Validate the trigger against ordinary Docs, personal defaults, templates, customized named styles, and direct text formatting before committing to behavior.

## Reduced-cost alternative discussed but not accepted

A first stage could be a one-way, automatically generated formatting snapshot. Google Docs would remain authoritative; the file would record body and named heading styles and refresh only on relevant changes. Local edits would not update Docs, and automatic restoration would not be implemented.

The suggested inexpensive trigger was to establish a baseline at pairing and create the file on a subsequent supported style change. This would miss existing customization until a later change, and Roman did not accept that tradeoff. Preserve it as an option rather than a decided requirement.

This variant avoids two-way conflict resolution and a new Google write path. It is useful primarily for inspection and recording; it is not a complete backup, restoration system, or full representation of paragraph overrides. An upgrade would become worthwhile when users need to edit styles locally or recreate a styled document. Define how user edits to a generated file are detected and protected before shipping even this variant.

## Implementation sequence when revisited

1. Recheck the preservation fix, current tests, release state, and saved live evidence. Preserve its regression guarantees with or without a sidecar.
2. Decide whether the first deliverable is a one-way snapshot or two-way formatting sync, and settle the initial-pairing/customization trigger.
3. Specify supported fields, inheritance semantics, normalization, schema, filename, and ownership of local edits.
4. Integrate capture with existing Docs reads and pairing lifecycle, avoiding extra polling or broad document writes. Keep credentials and runtime baselines outside portable metadata.
5. Add focused tests for creation, unchanged-file stability, later Docs changes, malformed/missing files, renames, and unsupported formatting. For two-way support, test stale metadata and concurrent property edits before writes.
6. Validate on fresh native copies with custom heading styles, fonts, direct overrides, images, and tables. Require a Markdown-only heading edit to preserve unrelated formatting. Document limitations and update the appropriate unreleased changelog/version under project rules.

## Usage planning evidence

Historical estimates in this discussion were low confidence. The full sidecar was estimated at 20–40 additional five-hour usage points on Astra Light; the reduced one-way variant was estimated at 10–20. Neither estimate was validated by implementation. There is no measured Astra Light versus Sol Light task multiplier in this discussion.

The separate preservation fix exceeded its initial 20-point budget and required an approved extension. Measured account-wide usage rose from 17% to 55% across implementation, including 15 points during the extension; concurrency was unknown, so these 38 points cannot be attributed exclusively to the task. The initial inspection and final reporting intervals were not fully measured. The main discovered complication was Google's resetting of explicit styles during heading changes, requiring another live validation cycle.

Before resuming, read the usage-calibration summary, capture a fresh baseline, narrow the chosen scope, and re-estimate using the then-current model and reasoning setting. Previous estimates and approvals do not authorize implementing this deferred proposal.
