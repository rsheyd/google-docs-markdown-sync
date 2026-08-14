# r/codex draft

## Proposed title

I built a two-way Google Docs ↔ Markdown sync because Codex is great with local files, but people still want Google Docs

## Alternate titles

* My current Codex writing workflow: local Markdown that stays synced with Google Docs  
* Syncing Files Between Codex and Google Docs

## Post

TL;DR: I built a macOS service that keeps Google Docs synchronized with local Markdown files in both directions. I use the Markdown side with Codex and Git, while the Google Docs side remains available for reviewing, editing, and sharing with other people.

I use Codex a lot for drafting and revising documents. It works really well when the source is an ordinary local Markdown file: Codex can read it, edit it, compare changes, and work with the surrounding project files without much friction.

But when I want to review something myself, share it, or have someone else edit it, I usually want Google Docs. I kept ending up in an awkward loop of exporting, copying changes back and forth, and wondering which version was current.

I decided to build a small macOS service called GDMS that keeps selected Google Docs paired with local Markdown files in both directions:

proposal.md  ↔  Google Doc

I can ask Codex to work on the Markdown file, and the changes appear in the Google Doc. If I or someone else edits the Google Doc, those changes come back to the local file. The Markdown stays available to Codex, Git, and any local editor, while the Google Doc stays useful for normal reviewing, editing, and sharing.

At this point I use it pretty regularly, so it has grown beyond the first basic sync script. It now does targeted paragraph and list updates, two-way headings and formatting, native numbered and bulleted lists, simple tables, links, standalone images, portable pairing files, and conflict checks. It also has Finder and Raycast shortcuts for creating or pairing documents.

One small example of the kind of thing I ended up caring about: blank lines in Markdown become consistent visual spacing between blocks in Google Docs. That applies to paragraphs, headings, and lists without inserting fake empty paragraphs or breaking list numbering.

It is still a technical personal tool rather than a polished app. It currently runs from source on macOS, requires Google OAuth setup, and uses Cloudflare R2 for pushing new local images into Docs. I have tried to document the setup and the current safety limits honestly.

Repo: [https://github.com/rsheyd/google-docs-markdown-sync](https://github.com/rsheyd/google-docs-markdown-sync)

I’m curious whether other people have run into the same split between the files that work best with coding agents and the documents that work best with other people. I’d also be interested in hearing what would make this feel usable for someone besides me.

## Suggested media

Attach a short screen recording showing this sequence:

1. Open a paired Markdown file and Google Doc side by side.  
2. Ask Codex to make a small, visible edit to the Markdown.  
3. Show the edit appear in Google Docs.  
4. Make a different edit in Google Docs.  
5. Show it appear in the Markdown file.

# r/SideProject draft

## Proposed title

GDMS — two-way sync between local Markdown files and Google Docs

## Alternate titles

* I built a local Markdown ↔ Google Docs sync service for my Codex workflow  
* My side project keeps Google Docs editable as ordinary local Markdown files

## Post

**TL;DR:** I built a macOS service that keeps selected Google Docs synchronized with local Markdown files in both directions. It started as a way to combine Codex's local-file workflow with Google Docs collaboration, and I now use it regularly. I’m trying to figure out whether it is worth making easier for other people to install.

I built a small macOS service called GDMS that keeps selected Google Docs paired with local Markdown files in both directions.

The original reason was fairly specific: I use Codex a lot, and Codex works very well with ordinary local Markdown files. It can read and edit them alongside the rest of a project, and I can track them with Git. But Google Docs is still much better when I want to review a document, share it, or have someone else edit it.

I wanted to use both interfaces without manually copying changes back and forth:

meeting-notes.md  ↔  Google Doc

proposal.md       ↔  Google Doc

Changes on either side are synchronized. The Google Doc stays the normal human collaboration surface, while the Markdown file stays available to Codex, local editors, search tools, and Git.

I’ve been using it enough that the project has gradually picked up some less obvious features:

* targeted paragraph and list updates instead of rebuilding the whole Doc;  
* headings, links, bold, italics, numbered and bulleted lists, and simple tables;  
* consistent Google Docs spacing based on Markdown blank lines;  
* standalone image synchronization using private temporary Cloudflare R2 staging;  
* safeguards around images, simultaneous edits, and unsupported structures;  
* portable per-workspace pairing manifests;  
* Finder Quick Actions and a Raycast command for creating or pairing documents;  
* versioned formatting migrations for updating existing paired Docs when sync behavior improves; and  
* Google Sheets ↔ CSV-directory synchronization as a related workflow.

It is working well for me, but it is not packaged as a normal consumer app yet. It currently runs from a source checkout on macOS and requires configuring a Google OAuth desktop client. Local image pushes have some additional Cloudflare R2 setup. The repository includes installation, formatting, operations, and troubleshooting documentation.

Repo: [https://github.com/rsheyd/google-docs-markdown-sync](https://github.com/rsheyd/google-docs-markdown-sync)

I’m at the point where I’m wondering whether this is useful mainly as a personal workflow, or whether it would be worth making the installation substantially easier for other people. I’d be especially interested in feedback on:

* whether the basic Markdown ↔ Google Docs workflow is useful to you;  
* which setup step looks like the biggest obstacle;  
* whether a packaged Mac app, Homebrew install, or simpler CLI would make the most difference; and  
* which Markdown or Google Docs features would feel essential before trying it.

## Suggested media

Lead with either:

* a short side-by-side synchronization video; or  
* one image containing the Markdown file, corresponding Google Doc, and a small diagram showing GDMS between them.

---

*↔ Markdown sync status* *Last successful sync: Aug 14, 2026, 10:29 AM · Markdown → Google Docs* [*Google Doc*](https://docs.google.com/document/d/1nYCGfUpnl6gn2bbEANaK5k6HRe8K09MpuSUhKUO22Yk/edit) *· Local file: `google-docs-markdown-sync/outreach/reddit-sideproject-draft.md`*

<!-- google-docs-sync:status:start -->
---
*↔ Markdown sync status*
*Last successful sync: Aug 14, 2026, 11:15 AM · Google Docs → Markdown*
*[Google Doc](https://docs.google.com/document/d/1BQXqSS6PPJRI1U5pIncqrX3DtmDx9F5tkkPzt0CpoNo/edit) · Local file: `reddit-codex-and-sideproject-drafts-aug-2026.md`*
<!-- google-docs-sync:status:end -->
