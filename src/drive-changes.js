export async function getDriveStartPageToken(services) {
  const response = await services.drive.changes.getStartPageToken({
    supportsAllDrives: true,
  });
  const pageToken = response.data.startPageToken;
  if (!pageToken) {
    throw new Error("Google Drive did not return a start page token.");
  }
  return pageToken;
}

export async function readDriveChanges(services, pageToken) {
  const fileIds = new Set();
  let changeCount = 0;
  let currentPageToken = pageToken;
  let newStartPageToken;

  do {
    const response = await services.drive.changes.list({
      pageToken: currentPageToken,
      pageSize: 1_000,
      spaces: "drive",
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      fields: "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,trashed,version,modifiedTime))",
    });
    for (const change of response.data.changes ?? []) {
      changeCount += 1;
      if (change.fileId) fileIds.add(change.fileId);
    }
    currentPageToken = response.data.nextPageToken;
    newStartPageToken = response.data.newStartPageToken ?? newStartPageToken;
  } while (currentPageToken);

  if (!newStartPageToken) {
    throw new Error("Google Drive did not return a new start page token.");
  }
  return {
    changeCount,
    fileIds: [...fileIds],
    newStartPageToken,
  };
}

export function driveFileId(pairing) {
  return pairing.type === "spreadsheet"
    ? pairing.spreadsheetId
    : pairing.documentId;
}

export function pairingsForDriveChanges(pairings, fileIds) {
  const changed = new Set(fileIds);
  return pairings.filter((pairing) => changed.has(driveFileId(pairing)));
}

export function isInvalidDriveChangeToken(error) {
  return error?.response?.status === 410 || Number(error?.code) === 410;
}

export function reconciliationDue(
  state,
  intervalMs,
  now = Date.now(),
) {
  const lastReconciledAt = Date.parse(state.remoteChanges?.lastReconciledAt ?? "");
  return !Number.isFinite(lastReconciledAt) || now - lastReconciledAt >= intervalMs;
}

export async function runDriveChangeCycle({
  services,
  pairings,
  state,
  syncPairings,
  persistCursor,
  assertCurrent = () => {},
  getStartPageToken = getDriveStartPageToken,
  readChanges = readDriveChanges,
  forceReconciliation = false,
}) {
  const savedPageToken = state.remoteChanges?.pageToken;
  let pageToken = savedPageToken;
  let changes;
  let initialized = !pageToken;
  let reset = false;

  if (pageToken) {
    try {
      changes = await readChanges(services, pageToken);
    } catch (error) {
      if (!isInvalidDriveChangeToken(error)) throw error;
      reset = true;
      initialized = true;
      pageToken = undefined;
    }
  }
  if (!pageToken) pageToken = await getStartPageToken(services);
  assertCurrent();

  const reconciled = initialized || forceReconciliation;
  const targets = reconciled
    ? pairings
    : pairingsForDriveChanges(pairings, changes.fileIds);
  const results = targets.length > 0 ? await syncPairings(targets) : [];
  const errorCount = results.filter((result) => result.action === "error").length;
  const cursorAdvanced = reconciled || errorCount === 0;
  assertCurrent();
  if (cursorAdvanced) {
    await persistCursor(initialized ? pageToken : changes.newStartPageToken, {
      reconciled,
    });
  }

  return {
    initialized,
    reset,
    reconciled,
    changeCount: changes?.changeCount ?? 0,
    targetCount: targets.length,
    results,
    errorCount,
    cursorAdvanced,
  };
}
