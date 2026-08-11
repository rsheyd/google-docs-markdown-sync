# Two-way image synchronization plan

## Goal

Synchronize inline PNG, JPEG, and GIF images between a paired Google Doc and its
Markdown file without changing the paired document ID or requiring permanent
public image hosting.

The first supported image set is deliberately narrow: ordinary inline images
and screenshots. Floating or positioned images, drawings, linked charts,
cropping, rotation, recoloring, and other visual effects remain unsupported
until the basic round trip is reliable.

## Local layout

Each Markdown file owns a sibling asset directory derived from its filename:

```text
notes/
├── project-plan.md
└── project-plan.assets/
    ├── login-screen-91d27e4a.png
    └── architecture-a3f52c19.jpg
```

Markdown references use portable relative paths:

```markdown
![Login screen](project-plan.assets/login-screen-91d27e4a.png)
```

The asset filename combines sanitized descriptive text with a short content
hash. The hash deduplicates identical content and prevents an unrelated image
with the same description from being overwritten.

Renaming or moving a paired Markdown file must move its asset directory and
rewrite its managed relative image links in the same operation. The tracked
pairing manifest continues to contain only portable paths and remote IDs; image
hashes, object IDs, revisions, and timestamps belong in untracked runtime
state.

## Google Docs to Markdown

Live validation on August 11, 2026 established that Google Docs native
Markdown export represents inline images as unresolved numbered references
such as `![][image1]`; it provides no reference definitions or image bytes.
The Docs API returned each image's object ID, body position, display dimensions,
and authenticated temporary `contentUri`. All four `contentUri` values
downloaded successfully through the existing OAuth client.

The pull path therefore cannot treat native Markdown export as a complete
ordered representation when images are present. It must merge two views of the
same document:

- native Markdown export for supported text structure and formatting; and
- Docs API body content for inline-image identity, position, and bytes.

The numbered references preserve document order. The pull path pairs them
one-to-one with Docs API inline objects and fails safely when counts or table
boundaries disagree.

For every supported inline image in the document:

1. Read the inline object and its position through the Google Docs API.
2. Download the image immediately from its short-lived `contentUri`.
3. Validate the response type, byte limit, pixel limit, and decoded image
   format before accepting it.
4. Hash the bytes and reuse an identical local asset when one already exists.
5. Otherwise, write the asset atomically into the sibling asset directory.
6. Replace its ordered native Markdown placeholder with a relative Markdown
   image node at the corresponding document position.
7. Record the Google inline-object ID, content hash, local path, dimensions,
   and synchronization baseline in untracked state.

Remote downloads must complete during the same sync pass because Docs image
content URLs are temporary. A failed image download fails the pull rather than
silently replacing the image with alt text.

## Markdown to Google Docs

For each local Markdown image node:

1. Resolve the path relative to the Markdown file and reject paths outside the
   workspace.
2. Read and validate the image, then calculate its content hash.
3. Preserve the existing Google inline object when its baseline and content
   hash show that the image is unchanged.
4. For a new or replaced image, upload the bytes under a random temporary key
   in a private Cloudflare R2 bucket.
5. Generate a short-lived, signed HTTPS GET URL that satisfies the Google Docs
   API URL-length requirement.
6. Submit `insertInlineImage` with the signed URL and the intended display
   dimensions. Google fetches the URL once and stores its own copy.
7. Read the document back, associate the resulting inline-object ID with the
   local image, and update runtime state only after convergence is confirmed.
8. Delete the temporary R2 object after success. Also attempt deletion after a
   failed insertion; a scheduled cleanup handles anything left behind.

Image insertion and the adjacent text changes should be planned as one ordered
Google Docs batch where API semantics allow it. Unchanged inline objects must
not be deleted and recreated during unrelated Markdown edits.

## Cloudflare R2 staging

R2 is a transport bridge, not the image source of truth.

- Keep the bucket private and enable no public listing.
- Use random, non-descriptive object keys under a staging prefix.
- Expose staged objects through an HMAC-authenticated Worker gateway with
  unguessable, 15-minute URLs; keep the underlying bucket private.
- Configure an R2 lifecycle rule to delete staging objects after one day as a
  backstop for crashes and interrupted cleanup.
- Delete staged objects eagerly after Google has accepted and copied them.
- Store the R2 account ID, bucket name, and endpoint in local configuration.
- Store the R2 access key ID and secret in the macOS Keychain, never in Git,
  Markdown, pairing manifests, logs, or runtime error messages.
- Grant the credentials access only to the staging bucket and required object
  operations.

Live testing established that ordinary clients can fetch R2 S3 presigned URLs,
but Google Docs rejects them as forbidden. A temporary public `r2.dev` probe
worked. The deployed Worker now validates the staging prefix, expiry, and HMAC
before reading through its private R2 binding; permanent public bucket access
remains disabled.

## Change detection and conflicts

The file watcher must treat the Markdown file and its sibling asset directory
as one debounced synchronization unit. A local asset modification therefore
triggers the same single-flight sync path as a Markdown edit.

Runtime state should retain, per image, the last synchronized local content
hash and remote inline-object identity. That allows the sync engine to
distinguish:

- unchanged content;
- a local replacement;
- a remote replacement;
- a Markdown-only rename or alt-text change;
- insertion or deletion on either side; and
- incompatible changes to both sides since the common baseline.

Initially, incompatible two-sided image changes should stop that pairing with a
clear conflict error. They should not use later-modification-wins, because an
image overwrite is difficult to inspect and recover. Conflict-copy behavior can
be added later.

## Deletion and cleanup policy

Deleting a Markdown image node deletes the corresponding inline image remotely
only when runtime state proves that they were previously paired. Deleting an
inline image remotely removes its managed Markdown reference on pull.

Local asset files are not permanently deleted automatically in the first
release. When no managed Markdown reference uses an asset, move it to an
untracked recovery area or report it as orphaned. Add explicit garbage
collection only after live use establishes safe retention rules.

## Implementation phases

Current status: Phases 1 and 2 are live and covered by automated tests.
Native export uses unresolved numbered image references such as
`![][image1]`; the pull path recognizes those placeholders, pairs them in order
with Docs API inline objects, downloads authenticated image bytes, and writes
content-addressed relative assets. Placeholder/object count mismatches fail
safely. Phase 3 is implemented locally for standalone image paragraphs,
including R2 staging, byte-level comparison, replacement-size preservation,
deletion, and coarse two-sided conflict detection. The private bucket, lifecycle
rule, authenticated Worker gateway, and live add/replace/delete round trip are
configured and validated.

### Phase 1: image-aware model and preservation

- [x] Represent Markdown images as explicit AST content rather than flattening
  them to alt text.
- [x] Read inline-object positions, identities, dimensions, and image
  properties.
- [x] Preserve unchanged remote images during ordinary Markdown text updates.
- [x] Refuse same-paragraph and full-rebuild mutations that could destroy an
  image before image-aware insertion is available.
- [x] Add fixtures and tests covering text adjacent to images.

### Phase 2: remote pull and local assets

- [x] Recognize native export's numbered image placeholders and align them
  one-to-one with Docs API inline objects, refusing ambiguous mappings.
- [x] Create and atomically manage sibling asset directories.
- [x] Download, validate, hash, deduplicate, and reference remote inline
  images.
- [x] Watch asset directories and handle Markdown-file renames and moves.
- [x] Include referenced asset bytes in local change hashes so repeated pulls
  converge without rewriting unchanged files.
- [x] Validate four real screenshots end-to-end using temporary local output.

### Phase 3: R2 staging and local push

- [x] Add Keychain-backed R2 configuration and narrowly scoped credentials.
- [x] Implement upload, 15-minute signed URL generation, eager deletion, and
  cleanup after signing or Google update failures.
- [x] Insert, replace, and delete standalone images through incremental Docs
  requests.
- [x] Preserve display dimensions during replacement.
- [x] Detect document-level two-sided image conflicts from the shared local
  hash and remote revision baseline.
- [x] Configure a private R2 bucket and one-day lifecycle deletion rule.
- [x] Verify that Google rejects private presigned URLs and accepts an ordinary
  public R2 object URL.
- [x] Add a narrow HMAC-authenticated Worker gateway backed by the private
  bucket.
- [x] Complete live add, replace, delete, cleanup, and remote readback tests.

### Phase 4: conflicts and operational hardening

- Detect incompatible two-sided image changes from a common baseline.
- Add actionable logs and health checks without leaking signed URLs or secrets.
- Test retry, timeout, crash-recovery, partial-upload, and R2-cleanup paths.
- Validate the complete workflow against live screenshot-heavy documents.

## Acceptance criteria

Image synchronization is ready for routine use when:

- adding, replacing, or deleting a supported inline image on either side
  converges on the other side;
- an unchanged image is neither re-downloaded nor recreated during unrelated
  text edits;
- Markdown and its asset directory remain portable within the workspace;
- interrupted R2 staging leaves no permanent public object and stale private
  objects expire automatically;
- credentials and signed URLs never enter tracked files or normal logs;
- retries and repeated no-op syncs are idempotent;
- unsupported visual objects produce explicit preservation or refusal behavior,
  never silent loss; and
- automated tests and live round-trip tests cover mixed text-and-image edits.
