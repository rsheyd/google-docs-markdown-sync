import fs from "node:fs/promises";
import { assetDirectoryPath } from "./images.js";
import { sendDeletionEmail } from "./heartbeat.js";
import { removeDocumentPairing } from "./manifests.js";
import { stateKey } from "./state.js";

function deletionRecipient(pairing) {
  return pairing.deletionPolicy?.notificationEmail ??
    process.env.GOOGLE_DOCS_SYNC_DELETE_TO ??
    process.env.GOOGLE_DOCS_SYNC_HEARTBEAT_TO;
}

function deletionSender(pairing) {
  return pairing.deletionPolicy?.notificationSender ??
    process.env.GOOGLE_DOCS_SYNC_DELETE_FROM ??
    process.env.GOOGLE_DOCS_SYNC_HEARTBEAT_FROM;
}

function policyDescription(pairing, explicit) {
  return explicit
    ? "explicit gdms delete command"
    : `automatic after ${pairing.deletionPolicy.gracePeriodMinutes} minute(s) missing`;
}

export function deletionDue(pairing, deletion, now = Date.now()) {
  if (pairing.type === "spreadsheet") return false;
  if (pairing.deletionPolicy?.mode !== "trash-after-grace-period") return false;
  return now - Date.parse(deletion.missingSince) >=
    pairing.deletionPolicy.gracePeriodMinutes * 60_000;
}

export async function recordMissingDeletion(
  pairing,
  state,
  { now = new Date(), persistState } = {},
) {
  state.deletions ??= {};
  const existing = state.deletions[pairing.documentId];
  if (existing) return existing;
  const deletion = {
    phase: "waiting",
    documentId: pairing.documentId,
    documentUrl: pairing.documentUrl,
    absolutePath: pairing.absolutePath,
    missingSince: now.toISOString(),
  };
  state.deletions[pairing.documentId] = deletion;
  await persistState?.(state);
  return deletion;
}

export async function cancelMissingDeletion(pairing, state, { persistState } = {}) {
  const phase = state.deletions?.[pairing.documentId]?.phase;
  if (phase !== "waiting" && phase !== "notified") return false;
  delete state.deletions[pairing.documentId];
  await persistState?.(state);
  return true;
}

export async function trashPairedDocument({
  services,
  pairing,
  state,
  deletion,
  explicit = false,
  deleteLocal = false,
  now = new Date(),
  persistState,
  removePairing = removeDocumentPairing,
  sendEmail = sendDeletionEmail,
}) {
  if (pairing.type === "spreadsheet") {
    throw new Error("Deletion propagation currently supports Markdown/Google Docs only.");
  }
  const recipient = deletionRecipient(pairing);
  const sender = deletionSender(pairing);
  if (!recipient) {
    throw new Error(
      "Refusing to trash the Google Doc without a deletion email recipient; set GOOGLE_DOCS_SYNC_DELETE_TO.",
    );
  }
  const file = await services.drive.files.get({
    fileId: pairing.documentId,
    fields: "id,name,trashed",
  });
  const trashedAt = deletion.trashedAt ?? now.toISOString();
  Object.assign(deletion, {
    phase: "trashing",
    name: file.data.name ?? pairing.name,
    documentId: pairing.documentId,
    documentUrl: pairing.documentUrl,
    absolutePath: pairing.absolutePath,
    recipient,
    sender,
    manifestPath: pairing.manifestPath,
    type: "document",
    deleteLocal,
    policyDescription: policyDescription(pairing, explicit),
    trashedAt,
  });
  state.deletions ??= {};
  state.deletions[pairing.documentId] = deletion;
  await persistState(state);

  if (!file.data.trashed) {
    await services.drive.files.update({
      fileId: pairing.documentId,
      requestBody: { trashed: true },
      fields: "id,trashed",
    });
  }
  deletion.phase = "trashed";
  await persistState(state);

  if (deleteLocal) {
    await fs.rm(pairing.absolutePath, { force: true });
    await fs.rm(assetDirectoryPath(pairing.absolutePath), {
      recursive: true,
      force: true,
    });
  }
  await removePairing(pairing);
  delete state.documents[stateKey(pairing)];
  deletion.phase = "unpaired";
  await persistState(state);

  const email = await sendEmail({ recipient, sender, deletion });
  deletion.phase = "notified";
  deletion.emailId = email.id;
  await persistState(state);
  return { deletion, email };
}

export async function retryDeletionNotifications(
  state,
  { persistState, sendEmail = sendDeletionEmail, logger = console } = {},
) {
  for (const deletion of Object.values(state.deletions ?? {})) {
    try {
      if (deletion.phase === "trashed") {
        if (deletion.deleteLocal) {
          await fs.rm(deletion.absolutePath, { force: true });
          await fs.rm(assetDirectoryPath(deletion.absolutePath), {
            recursive: true,
            force: true,
          });
        }
        await removeDocumentPairing(deletion);
        delete state.documents[deletion.documentId];
        deletion.phase = "unpaired";
        await persistState(state);
      }
      if (deletion.phase !== "unpaired") continue;
      const email = await sendEmail({
        recipient: deletion.recipient,
        sender: deletion.sender,
        deletion,
      });
      deletion.phase = "notified";
      deletion.emailId = email.id;
      await persistState(state);
    } catch (error) {
      logger.error(`deletion email: ${error.message}`);
    }
  }
}
