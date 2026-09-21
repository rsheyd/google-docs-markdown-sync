import { SYNC_BATCH_SIZE } from "./sync-scheduler.js";

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

// Priority work never advances the durable cursor. Unprocessed or interrupted
// targets are rediscovered from the enclosing cycle's cursor on the next poll.
export function createReconciliationPriorityDrain({
  services, loadPairings, syncPairings, runExclusive, assertCurrent,
  isPendingMove = () => false, readChanges = readDriveChanges,
}) {
  let cursor;
  const pendingIds = new Set();
  return ({ pageToken }) => runExclusive(async () => {
    assertCurrent();
    cursor ??= pageToken;
    const changes = await readChanges(services, cursor);
    assertCurrent();
    cursor = changes.newStartPageToken;
    for (const id of changes.fileIds) pendingIds.add(id);
    const current = await loadPairings();
    const registeredIds = new Set(current.map(driveFileId));
    for (const id of pendingIds) if (!registeredIds.has(id)) pendingIds.delete(id);
    const targets = pairingsForDriveChanges(current, [...pendingIds])
      .filter((pairing) => !isPendingMove(pairing)).slice(0, SYNC_BATCH_SIZE);
    assertCurrent();
    if (targets.length) await syncPairings(targets);
    for (const pairing of targets) pendingIds.delete(driveFileId(pairing));
  });
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
  runExclusive = (operation) => operation(),
  batchSize = SYNC_BATCH_SIZE,
  betweenBatches,
}) {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("Invalid sync batch size.");
  const savedPageToken = state.remoteChanges?.pageToken;
  let pageToken = savedPageToken;
  let changes;
  let initialized = !pageToken;
  let reset = false;

  if (pageToken) {
    try {
      changes = await runExclusive(() => readChanges(services, pageToken));
    } catch (error) {
      if (!isInvalidDriveChangeToken(error)) throw error;
      reset = true;
      initialized = true;
      pageToken = undefined;
    }
  }
  if (!pageToken) pageToken = await runExclusive(() => getStartPageToken(services));
  assertCurrent();

  const reconciled = initialized || forceReconciliation;
  const targets = reconciled
    ? pairings
    : pairingsForDriveChanges(pairings, changes.fileIds);
  const results = [];
  for (let offset = 0; offset < targets.length; offset += batchSize) {
    const batch = await runExclusive(async () => {
      assertCurrent();
      const value = await syncPairings(targets.slice(offset, offset + batchSize));
      assertCurrent();
      return value;
    });
    results.push(...batch);
    if (offset + batchSize < targets.length) {
      await betweenBatches?.({ reconciled, completed: offset + batchSize, total: targets.length, pageToken: initialized ? pageToken : changes.newStartPageToken });
      assertCurrent();
    }
  }
  const errorCount = results.filter((result) => result.action === "error").length;
  const cursorAdvanced = reconciled || errorCount === 0;
  assertCurrent();
  if (cursorAdvanced) {
    await runExclusive(async () => {
      assertCurrent();
      await persistCursor(initialized ? pageToken : changes.newStartPageToken, { reconciled });
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
