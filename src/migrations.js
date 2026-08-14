import fs from "node:fs/promises";
import { getAuthClient } from "./auth.js";
import {
  createGoogleServices,
  getRemoteInfo,
  planOrderedListNumberingUpdate,
  planParagraphSpacingUpdate,
} from "./google.js";
import { loadPairings } from "./manifests.js";
import { workspaceRoot } from "./paths.js";
import { loadState, saveState, stateKey } from "./state.js";
import { stripDocumentStatus } from "./status.js";

export const DOCUMENT_MIGRATIONS = [
  {
    version: "0.3.2",
    description: "repair restarted ordered numbering",
    plan: planOrderedListNumberingUpdate,
  },
  {
    version: "0.4.1",
    description: "apply universal Markdown block-boundary spacing",
    plan: planParagraphSpacingUpdate,
  },
];

export function planPendingMigrations(document, markdown, applied = {}) {
  const migrations = DOCUMENT_MIGRATIONS.filter(
    (migration) => !applied[migration.version],
  );
  return {
    versions: migrations.map((migration) => migration.version),
    requests: migrations.flatMap((migration) => migration.plan(document, markdown)),
  };
}

export async function runDocumentMigrations({
  dryRun = false,
  documentId,
  root = workspaceRoot(),
  logger = console,
  pairings: suppliedPairings,
  services: suppliedServices,
  state: suppliedState,
  readFile = fs.readFile,
  persistState = saveState,
} = {}) {
  const discovered = suppliedPairings ?? (await loadPairings(root));
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

  for (const pairing of documents) {
    const key = stateKey(pairing);
    const previous = state.documents[key] ?? {};
    try {
      const markdown = stripDocumentStatus(
        await readFile(pairing.absolutePath, "utf8"),
      );
      const response = await services.docs.documents.get({
        documentId: pairing.documentId,
        suggestionsViewMode: "PREVIEW_WITHOUT_SUGGESTIONS",
      });
      const document = response.data;
      const plan = planPendingMigrations(
        document,
        markdown,
        previous.migrations,
      );
      if (!plan.versions.length) {
        results.push({ pairing, status: "current", versions: [], requests: 0 });
        continue;
      }
      if (dryRun) {
        results.push({
          pairing,
          status: "planned",
          versions: plan.versions,
          requests: plan.requests.length,
        });
        logger.log(
          `planned ${plan.versions.join(",")}: ${pairing.absolutePath} (${plan.requests.length} requests)`,
        );
        continue;
      }
      let remote;
      if (plan.requests.length) {
        await services.docs.documents.batchUpdate({
          documentId: pairing.documentId,
          requestBody: {
            requests: plan.requests,
            writeControl: { requiredRevisionId: document.revisionId },
          },
        });
        remote = await getRemoteInfo(services, pairing.documentId);
      }
      const appliedAt = new Date().toISOString();
      state.documents[key] = {
        ...previous,
        ...(remote
          ? {
              remoteRevisionId: remote.revisionId,
              remoteModifiedTime: remote.modifiedTime,
            }
          : {}),
        migrations: {
          ...(previous.migrations ?? {}),
          ...Object.fromEntries(plan.versions.map((version) => [version, appliedAt])),
        },
      };
      await persistState(state);
      results.push({
        pairing,
        status: "migrated",
        versions: plan.versions,
        requests: plan.requests.length,
      });
      logger.log(
        `migrated ${plan.versions.join(",")}: ${pairing.absolutePath} (${plan.requests.length} requests)`,
      );
    } catch (error) {
      results.push({ pairing, status: "error", error });
      logger.error(`${pairing.absolutePath}: ${error.message}`);
    }
  }
  return results;
}
