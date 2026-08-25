import fs from "node:fs/promises";
import path from "node:path";
import { sha256, writeJsonAtomic, writeTextAtomic } from "./files.js";
import {
  SHEET_STATUS_FILE,
  SHEET_STATUS_TITLE,
  spreadsheetStatusMarkdown,
  spreadsheetStatusValues,
} from "./status.js";

export const SHEETS_METADATA = ".google-sheets-sync.json";

async function googleOperation(operation, callback, now = Date.now) {
  const startedAt = now();
  try {
    return await callback();
  } catch (error) {
    error.gdmsOperation ??= operation;
    error.gdmsElapsedMs ??= Math.max(0, now() - startedAt);
    throw error;
  }
}

function safeDirectoryName(value) {
  return String(value)
    .trim()
    .replace(/[/:\\\u0000-\u001f]+/g, "-")
    .replace(/^\.+|\.+$/g, "") || "spreadsheet";
}

async function availableDirectory(parent, preferredName) {
  const base = safeDirectoryName(preferredName);
  for (let suffix = 1; ; suffix += 1) {
    const candidate = path.join(parent, suffix === 1 ? base : `${base}-${suffix}`);
    try {
      await fs.access(candidate);
    } catch (error) {
      if (error.code === "ENOENT") return candidate;
      throw error;
    }
  }
}

export async function organizeCsvFiles(files, name) {
  const absoluteFiles = files.map((file) => path.resolve(file));
  if (!absoluteFiles.length) throw new Error("create-sheet requires at least one --file.");
  const parents = new Set(absoluteFiles.map((file) => path.dirname(file)));
  if (parents.size !== 1) throw new Error("Selected CSV files must be in the same directory.");
  if (new Set(absoluteFiles).size !== absoluteFiles.length) {
    throw new Error("The same CSV file was selected more than once.");
  }
  for (const file of absoluteFiles) {
    if (path.extname(file).toLowerCase() !== ".csv") throw new Error(`Not a CSV file: ${file}`);
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error(`Not a file: ${file}`);
  }
  const workspace = path.dirname(absoluteFiles[0]);
  const fallbackName = path.basename(absoluteFiles[0], path.extname(absoluteFiles[0]));
  const directory = await availableDirectory(workspace, name || fallbackName);
  await fs.mkdir(directory);
  const moved = [];
  try {
    for (const source of absoluteFiles) {
      const destination = path.join(directory, path.basename(source));
      await fs.rename(source, destination);
      moved.push({ source, destination });
    }
  } catch (error) {
    for (const move of moved.reverse()) await fs.rename(move.destination, move.source);
    await fs.rmdir(directory);
    throw error;
  }
  return { workspace, directory, files: moved.map((move) => move.destination) };
}

export function initialSheetTitle(filename) {
  const title = path.basename(filename, path.extname(filename))
    .replace(/[\\/:?*\[\]]+/g, "-")
    .replace(/^'+|'+$/g, "")
    .trim()
    .slice(0, 100);
  return title || "Sheet";
}

export async function createSpreadsheet(services, title, sheets) {
  const response = await googleOperation("sheets.spreadsheets.create", () => services.sheets.spreadsheets.create({
    requestBody: {
      properties: { title },
      sheets: sheets.map((sheet) => ({ properties: { title: sheet.title } })),
    },
  }));
  const spreadsheetId = response.data.spreadsheetId;
  if (!spreadsheetId) throw new Error("Google Sheets did not return a spreadsheet ID.");
  return {
    spreadsheetId,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
  };
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") field += character;
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field.");
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function stringifyCsv(rows) {
  const encode = (value) => {
    const text = value == null ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  if (!rows.length) return "";
  return `${rows.map((row) => row.map(encode).join(",")).join("\n")}\n`;
}

export function sheetFilename(title, sheetId, occupied = new Set()) {
  const base = String(title)
    .trim()
    .replace(/[/:\\\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+|\.+$/g, "") || "Sheet";
  let filename = `${base}.csv`;
  if (occupied.has(filename.toLowerCase())) filename = `${base}-${sheetId}.csv`;
  occupied.add(filename.toLowerCase());
  return filename;
}

function trimRows(rows) {
  const result = rows.map((row) => [...row]);
  while (result.length && result.at(-1).every((value) => value === "")) result.pop();
  let width = 0;
  for (const row of result) {
    let last = row.length;
    while (last && row[last - 1] === "") last -= 1;
    width = Math.max(width, last);
  }
  return result.map((row) => row.slice(0, width));
}

export async function readLocalSpreadsheet(directory) {
  const metadataPath = path.join(directory, SHEETS_METADATA);
  let metadata = { version: 1, sheets: [] };
  try {
    metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const csvFiles = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".csv"));
  const byFile = new Map((metadata.sheets ?? []).map((sheet) => [sheet.file, sheet]));
  const sheets = await Promise.all(csvFiles.map(async (entry) => {
    const stored = byFile.get(entry.name);
    const filePath = path.join(directory, entry.name);
    const [text, stat] = await Promise.all([fs.readFile(filePath, "utf8"), fs.stat(filePath)]);
    return {
      ...(stored?.sheetId != null ? { sheetId: stored.sheetId } : {}),
      title: stored?.title ?? path.basename(entry.name, path.extname(entry.name)),
      file: entry.name,
      values: trimRows(parseCsv(text)),
      modifiedTime: stat.mtimeMs,
    };
  }));
  sheets.sort((a, b) => a.file.localeCompare(b.file));
  const serialized = JSON.stringify(sheets.map(({ sheetId, title, file, values }) => ({ sheetId, title, file, values })));
  return {
    exists: entries.length > 0,
    sheets,
    hash: sha256(serialized),
    modifiedTime: Math.max(0, ...sheets.map((sheet) => sheet.modifiedTime)),
  };
}

export async function getSpreadsheetDriveInfo(services, spreadsheetId) {
  const fileResponse = await googleOperation(
    "drive.files.get",
    () => services.drive.files.get({
      fileId: spreadsheetId,
      fields: "id,modifiedTime,name,version",
    }),
  );
  return {
    modifiedTime: fileResponse.data.modifiedTime,
    name: fileResponse.data.name,
    revisionId: String(fileResponse.data.version ?? fileResponse.data.modifiedTime),
  };
}

export async function getSpreadsheetDetails(services, spreadsheetId, driveInfo) {
  const spreadsheetResponse = await googleOperation(
    "sheets.spreadsheets.get",
    () => services.sheets.spreadsheets.get({
      spreadsheetId,
      fields: "spreadsheetId,properties.title,sheets.properties",
    }),
  );
  return {
    ...(driveInfo ?? await getSpreadsheetDriveInfo(services, spreadsheetId)),
    spreadsheet: spreadsheetResponse.data,
  };
}

export async function getSpreadsheetInfo(services, spreadsheetId) {
  const [driveInfo, spreadsheetResponse] = await Promise.all([
    getSpreadsheetDriveInfo(services, spreadsheetId),
    googleOperation(
      "sheets.spreadsheets.get",
      () => services.sheets.spreadsheets.get({
        spreadsheetId,
        fields: "spreadsheetId,properties.title,sheets.properties",
      }),
    ),
  ]);
  return { ...driveInfo, spreadsheet: spreadsheetResponse.data };
}

export function hasSpreadsheetStatus(remote) {
  return (remote.spreadsheet.sheets ?? []).some(
    (sheet) => sheet.properties?.title === SHEET_STATUS_TITLE,
  );
}

function contentSheetProperties(remote) {
  return (remote.spreadsheet.sheets ?? [])
    .map((sheet) => sheet.properties)
    .filter((sheet) => sheet.title !== SHEET_STATUS_TITLE);
}

export async function writeSpreadsheetStatus(services, pairing, state, remote) {
  let current = remote ?? await getSpreadsheetInfo(services, pairing.spreadsheetId);
  if (!hasSpreadsheetStatus(current)) {
    await googleOperation("sheets.spreadsheets.batchUpdate", () => services.sheets.spreadsheets.batchUpdate({
      spreadsheetId: pairing.spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: SHEET_STATUS_TITLE } } }] },
    }));
    current = await getSpreadsheetInfo(services, pairing.spreadsheetId);
  }
  await googleOperation("sheets.values.clear", () => services.sheets.spreadsheets.values.clear({
    spreadsheetId: pairing.spreadsheetId,
    range: quoteSheet(SHEET_STATUS_TITLE),
    requestBody: {},
  }));
  await googleOperation("sheets.values.update", () => services.sheets.spreadsheets.values.update({
    spreadsheetId: pairing.spreadsheetId,
    range: `${quoteSheet(SHEET_STATUS_TITLE)}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: spreadsheetStatusValues(pairing, state) },
  }));
  await writeTextAtomic(
    path.join(pairing.absolutePath, SHEET_STATUS_FILE),
    spreadsheetStatusMarkdown(pairing, state),
  );
  return getSpreadsheetInfo(services, pairing.spreadsheetId);
}

function quoteSheet(title) {
  return `'${String(title).replaceAll("'", "''")}'`;
}

export async function pullSpreadsheet(services, pairing, remote) {
  const properties = contentSheetProperties(remote);
  const ranges = properties.map((sheet) => quoteSheet(sheet.title));
  const response = ranges.length
    ? await googleOperation("sheets.values.batchGet", () => services.sheets.spreadsheets.values.batchGet({
        spreadsheetId: pairing.spreadsheetId,
        ranges,
        valueRenderOption: "FORMULA",
        dateTimeRenderOption: "SERIAL_NUMBER",
      }))
    : { data: { valueRanges: [] } };
  const previous = await readLocalSpreadsheet(pairing.absolutePath);
  const previousById = new Map(previous.sheets.filter((sheet) => sheet.sheetId != null).map((sheet) => [sheet.sheetId, sheet]));
  const occupied = new Set();
  const sheets = properties.map((sheet, index) => {
    const old = previousById.get(sheet.sheetId);
    const file = old?.title === sheet.title && old.file
      ? (occupied.add(old.file.toLowerCase()), old.file)
      : sheetFilename(sheet.title, sheet.sheetId, occupied);
    return { sheetId: sheet.sheetId, title: sheet.title, file, values: response.data.valueRanges?.[index]?.values ?? [] };
  });
  await fs.mkdir(pairing.absolutePath, { recursive: true });
  const managed = new Set(previous.sheets.map((sheet) => sheet.file));
  for (const sheet of sheets) {
    await writeTextAtomic(path.join(pairing.absolutePath, sheet.file), stringifyCsv(sheet.values));
    managed.delete(sheet.file);
  }
  for (const stale of managed) await fs.rm(path.join(pairing.absolutePath, stale), { force: true });
  await writeJsonAtomic(path.join(pairing.absolutePath, SHEETS_METADATA), {
    version: 1,
    spreadsheetId: pairing.spreadsheetId,
    sheets: sheets.map(({ sheetId, title, file }) => ({ sheetId, title, file })),
  });
  return readLocalSpreadsheet(pairing.absolutePath);
}

export async function pushSpreadsheet(services, pairing, local, remote) {
  if (!local.sheets.length) {
    throw new Error("A spreadsheet must keep at least one CSV tab.");
  }
  const titles = new Set();
  for (const sheet of local.sheets) {
    if (titles.has(sheet.title)) throw new Error(`Duplicate local sheet title: ${sheet.title}`);
    titles.add(sheet.title);
  }
  const remoteSheets = contentSheetProperties(remote);
  const remoteById = new Map(remoteSheets.map((sheet) => [sheet.sheetId, sheet]));
  const localIds = new Set(local.sheets.map((sheet) => sheet.sheetId).filter((id) => id != null));
  const requests = [];
  for (const sheet of local.sheets) {
    if (sheet.sheetId == null) requests.push({ addSheet: { properties: { title: sheet.title } } });
    else if (remoteById.get(sheet.sheetId)?.title !== sheet.title) {
      requests.push({ updateSheetProperties: { properties: { sheetId: sheet.sheetId, title: sheet.title }, fields: "title" } });
    }
  }
  requests.push(...remoteSheets
    .filter((sheet) => !localIds.has(sheet.sheetId))
    .map((sheet) => ({ deleteSheet: { sheetId: sheet.sheetId } })));
  if (requests.length) {
    await googleOperation(
      "sheets.spreadsheets.batchUpdate",
      () => services.sheets.spreadsheets.batchUpdate({
        spreadsheetId: pairing.spreadsheetId,
        requestBody: { requests },
      }),
    );
  }
  const refreshed = await getSpreadsheetInfo(services, pairing.spreadsheetId);
  const byTitle = new Map((refreshed.spreadsheet.sheets ?? []).map((sheet) => [sheet.properties.title, sheet.properties]));
  for (const sheet of local.sheets) {
    await googleOperation("sheets.values.clear", () => services.sheets.spreadsheets.values.clear({
      spreadsheetId: pairing.spreadsheetId,
      range: quoteSheet(sheet.title),
      requestBody: {},
    }));
    if (sheet.values.length) {
      await googleOperation("sheets.values.update", () => services.sheets.spreadsheets.values.update({
        spreadsheetId: pairing.spreadsheetId,
        range: `${quoteSheet(sheet.title)}!A1`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: sheet.values },
      }));
    }
    sheet.sheetId = byTitle.get(sheet.title)?.sheetId;
  }
  await writeJsonAtomic(path.join(pairing.absolutePath, SHEETS_METADATA), {
    version: 1,
    spreadsheetId: pairing.spreadsheetId,
    sheets: local.sheets.map(({ sheetId, title, file }) => ({ sheetId, title, file })),
  });
  return getSpreadsheetInfo(services, pairing.spreadsheetId);
}
