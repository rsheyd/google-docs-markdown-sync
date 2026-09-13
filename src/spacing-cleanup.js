import fs from "node:fs/promises";
import { getAuthClient } from "./auth.js";
import {
  cleanupDocumentSpacing,
  createGoogleServices,
} from "./google.js";
import { loadPairings } from "./manifests.js";
import { loadState, saveState, stateKey } from "./state.js";
import { stripDocumentStatus } from "./status.js";

export async function runSpacingCleanup({
  documentId,
  pairings: suppliedPairings,
  services: suppliedServices,
  state: suppliedState,
  readFile = fs.readFile,
  persistState = saveState,
  onProgress,
} = {}) {
  const discovered = suppliedPairings ?? (await loadPairings());
  const documents = discovered.filter(
    (pairing) =>
      pairing.type !== "spreadsheet" &&
      (!documentId || pairing.documentId === documentId),
  );
  if (documentId && !documents.length) {
    throw new Error("No document pairing found for that document ID.");
  }
  const state = suppliedState ?? (await loadState());
  const services = suppliedServices ?? createGoogleServices(
    await getAuthClient({ interactive: true }),
  );
  const results = [];

  for (const [index, pairing] of documents.entries()) {
    const current = index + 1;
    onProgress?.({ type: "start", current, total: documents.length, pairing });
    try {
      const markdown = stripDocumentStatus(
        await readFile(pairing.absolutePath, "utf8"),
      );
      const result = await cleanupDocumentSpacing(
        services,
        pairing.documentId,
        markdown,
      );
      const key = stateKey(pairing);
      state.documents[key] = {
        ...(state.documents[key] ?? {}),
        remoteRevisionId: result.remote.revisionId,
        remoteDriveRevisionId: result.remote.driveRevisionId,
        remoteModifiedTime: result.remote.modifiedTime,
      };
      await persistState(state);
      const completed = {
        pairing,
        status: result.emptyParagraphs ? "cleaned" : "current",
        emptyParagraphs: result.emptyParagraphs,
      };
      results.push(completed);
      onProgress?.({ type: "complete", current, total: documents.length, ...completed });
    } catch (error) {
      const completed = { pairing, status: "error", emptyParagraphs: 0, error };
      results.push(completed);
      onProgress?.({ type: "complete", current, total: documents.length, ...completed });
    }
  }
  return results;
}
