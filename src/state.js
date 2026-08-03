import { readJson, writeJsonAtomic } from "./files.js";
import { STATE_PATH } from "./paths.js";

export async function loadState() {
  return readJson(STATE_PATH, { version: 1, documents: {} });
}

export async function saveState(state) {
  await writeJsonAtomic(STATE_PATH, state);
}

export function stateKey(pairing) {
  return pairing.type === "spreadsheet"
    ? `spreadsheet:${pairing.spreadsheetId}`
    : pairing.documentId;
}
