# Frequently asked questions

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
