# Frequently asked questions

## Why do checkboxes appear as `o]` and `x]` in Google Docs?

These are GDMS task markers: `o]` means open and `x]` means complete. Change the first letter in Docs, or use standard `- [ ]` / `- [x]` syntax in Markdown. Google does not expose reliable native checklist completion state through the Docs API, so GDMS stores that state in readable, editable text. No add-on is required. See [the checklist design and examples](formatting.md#checklists).

## Can GDMS convert my existing native checklists?

Optional auto-conversion is available, but disabled by default. **Completed tasks may become open if Google’s Markdown export omits completion.** Only exported task items with unique document text matches convert; ambiguous items are skipped. Existing text formatting is preserved; strikethrough does not establish completion. Review converted tasks and change `o]` to `x]` where needed. Turning conversion off does not restore the original native checkboxes. See [how to enable or disable conversion](operations.md#native-checklist-conversion).

## Will GDMS keep working if I make a paired Google Doc publicly viewable?

Yes. Changing a paired Google Doc to **Anyone with the link can view** does not
change its document ID or interfere with GDMS. GDMS continues to access the Doc
through the Google account authorized with `gdms auth`, rather than through its
public sharing link.

The authorized account must retain edit access. Removing that access, moving the
Doc into an organization that blocks it, or otherwise restricting the account's
permissions will cause synchronization requests to fail.

Remember that synced content becomes visible to everyone covered by the sharing
setting, including content pushed from the paired Markdown file. Viewer access
does not introduce editing conflicts, but allowing anyone to edit can: public
edits are ordinary remote changes and GDMS applies its normal conflict and
last-modified rules. No re-pairing or service restart is needed after a sharing
change.
