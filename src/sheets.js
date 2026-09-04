import fs from "node:fs/promises";
import path from "node:path";
import { sha256, writeTextAtomic } from "./files.js";
import {
  LEGACY_SHEET_STATUS_FILE,
  SHEET_STATUS_FILE,
  SHEET_STATUS_TITLE,
  parseSpreadsheetMetadata,
  spreadsheetStatusMarkdown,
  spreadsheetStatusValues,
} from "./status.js";

export const LEGACY_SHEETS_METADATA = ".google-sheets-sync.json";

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
  const syncLocation = path.dirname(absoluteFiles[0]);
  const fallbackName = path.basename(absoluteFiles[0], path.extname(absoluteFiles[0]));
  const directory = await availableDirectory(syncLocation, name || fallbackName);
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
  return { syncLocation, directory, files: moved.map((move) => move.destination) };
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

async function readSpreadsheetMetadata(directory) {
  const gdmsPath = path.join(directory, SHEET_STATUS_FILE);
  const gdms = await fs.readFile(gdmsPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const current = parseSpreadsheetMetadata(gdms);
  if (current) return current;
  let metadata = { version: 1, sheets: [] };
  try {
    metadata = JSON.parse(await fs.readFile(path.join(directory, LEGACY_SHEETS_METADATA), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return metadata;
}

export async function readLocalSpreadsheet(directory) {
  const metadata = await readSpreadsheetMetadata(directory);
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
    metadata,
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
      includeGridData: true,
      fields: "spreadsheetId,properties.title,sheets(properties,tables,data(startRow,startColumn,rowData(values(userEnteredFormat(numberFormat,textFormat(bold,italic,underline,strikethrough))))))",
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
        fields: "spreadsheetId,properties.title,sheets(properties,tables)",
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
  const local = await readLocalSpreadsheet(pairing.absolutePath);
  const storedMetadata = local.metadata;
  const metadata = spreadsheetMetadata(pairing, current, local.sheets, storedMetadata);
  await writeTextAtomic(path.join(pairing.absolutePath, SHEET_STATUS_FILE), spreadsheetStatusMarkdown(
    pairing,
    state,
    metadata,
  ));
  await Promise.all([
    fs.rm(path.join(pairing.absolutePath, LEGACY_SHEETS_METADATA), { force: true }),
    fs.rm(path.join(pairing.absolutePath, LEGACY_SHEET_STATUS_FILE), { force: true }),
  ]);
  return getSpreadsheetInfo(services, pairing.spreadsheetId);
}

function quoteSheet(title) {
  return `'${String(title).replaceAll("'", "''")}'`;
}

function columnName(index) {
  let value = index + 1;
  let result = "";
  while (value) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function gridRangeA1(range, properties) {
  const startRow = (range.startRowIndex ?? 0) + 1;
  const endRow = range.endRowIndex ?? properties.gridProperties?.rowCount ?? startRow;
  const startColumn = columnName(range.startColumnIndex ?? 0);
  const endColumn = columnName((range.endColumnIndex ?? properties.gridProperties?.columnCount ?? 1) - 1);
  return `${startColumn}${startRow}:${endColumn}${endRow}`;
}

function meaningfulTextFormat(textFormat) {
  if (!textFormat) return undefined;
  const result = {};
  for (const property of ["bold", "italic", "underline", "strikethrough"]) {
    if (textFormat[property] === true) result[property] = true;
  }
  return Object.keys(result).length ? result : undefined;
}

function sheetFormats(sheet) {
  const cells = [];
  for (const data of sheet.data ?? []) {
    const startRow = data.startRow ?? 0;
    const startColumn = data.startColumn ?? 0;
    for (const [rowOffset, row] of (data.rowData ?? []).entries()) {
      for (const [columnOffset, cell] of (row.values ?? []).entries()) {
        const numberFormat = cell.userEnteredFormat?.numberFormat;
        const textFormat = meaningfulTextFormat(cell.userEnteredFormat?.textFormat);
        if (numberFormat || textFormat) cells.push({
          rowIndex: startRow + rowOffset,
          columnIndex: startColumn + columnOffset,
          ...(numberFormat ? { numberFormat } : {}),
          ...(textFormat ? { textFormat } : {}),
        });
      }
    }
  }
  cells.sort((a, b) => a.rowIndex - b.rowIndex || a.columnIndex - b.columnIndex);
  const rowRuns = [];
  for (const cell of cells) {
    const previous = rowRuns.at(-1);
    const format = {
      ...(cell.numberFormat ? { numberFormat: cell.numberFormat } : {}),
      ...(cell.textFormat ? { textFormat: cell.textFormat } : {}),
    };
    const sameFormat = previous &&
      previous.rowIndex === cell.rowIndex &&
      previous.endColumnIndex === cell.columnIndex &&
      JSON.stringify(previous.format) === JSON.stringify(format);
    if (sameFormat) previous.endColumnIndex += 1;
    else rowRuns.push({
      rowIndex: cell.rowIndex,
      startRowIndex: cell.rowIndex,
      endRowIndex: cell.rowIndex + 1,
      startColumnIndex: cell.columnIndex,
      endColumnIndex: cell.columnIndex + 1,
      format,
    });
  }
  const rectangles = [];
  for (const run of rowRuns) {
    const previous = rectangles.findLast((candidate) =>
      candidate.endRowIndex === run.startRowIndex &&
      candidate.startColumnIndex === run.startColumnIndex &&
      candidate.endColumnIndex === run.endColumnIndex &&
      JSON.stringify(candidate.format) === JSON.stringify(run.format));
    if (previous) previous.endRowIndex += 1;
    else rectangles.push({ ...run });
  }
  return rectangles.map(({ startColumnIndex, endColumnIndex, startRowIndex, endRowIndex, format }) => ({
    range: `${columnName(startColumnIndex)}${startRowIndex + 1}:${columnName(endColumnIndex - 1)}${endRowIndex}`,
    ...format,
  }));
}

function spreadsheetMetadata(pairing, remote, sheets, previous = {}) {
  const previousById = new Map((previous.sheets ?? []).map((sheet) => [sheet.sheetId, sheet]));
  const remoteById = new Map((remote.spreadsheet.sheets ?? []).map((sheet) => [sheet.properties?.sheetId, sheet]));
  return {
    version: 2,
    spreadsheetId: pairing.spreadsheetId,
    sheets: sheets.map((sheet) => {
      const remoteSheet = remoteById.get(sheet.sheetId);
      const properties = remoteSheet?.properties ?? {};
      const old = previousById.get(sheet.sheetId);
      return {
        sheetId: sheet.sheetId,
        title: sheet.title,
        file: sheet.file,
        formats: remoteSheet?.data ? sheetFormats(remoteSheet) : old?.formats ?? [],
        tables: (remoteSheet?.tables ?? old?.tables ?? []).map((table) => table.range && typeof table.range !== "string" ? {
          ...(table.tableId ? { tableId: table.tableId } : {}),
          ...(table.name ? { name: table.name } : {}),
          range: gridRangeA1(table.range, properties),
          ...(table.rowsProperties ? { rowsProperties: table.rowsProperties } : {}),
          ...(table.columnProperties ? { columnProperties: table.columnProperties } : {}),
        } : table),
      };
    }),
  };
}

async function writeSpreadsheetMetadata(pairing, metadata) {
  const filePath = path.join(pairing.absolutePath, SHEET_STATUS_FILE);
  const current = await fs.readFile(filePath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const next = spreadsheetStatusMarkdown(pairing, {}, metadata);
  if (current !== next) await writeTextAtomic(filePath, next);
  parseSpreadsheetMetadata(await fs.readFile(filePath, "utf8"));
  await Promise.all([
    fs.rm(path.join(pairing.absolutePath, LEGACY_SHEETS_METADATA), { force: true }),
    fs.rm(path.join(pairing.absolutePath, LEGACY_SHEET_STATUS_FILE), { force: true }),
  ]);
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
    const filePath = path.join(pairing.absolutePath, sheet.file);
    const nextText = stringifyCsv(sheet.values);
    const currentText = await fs.readFile(filePath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (currentText !== nextText) await writeTextAtomic(filePath, nextText);
    managed.delete(sheet.file);
  }
  for (const stale of managed) await fs.rm(path.join(pairing.absolutePath, stale), { force: true });
  const metadata = spreadsheetMetadata(pairing, remote, sheets, previous.metadata);
  await writeSpreadsheetMetadata(pairing, metadata);
  return readLocalSpreadsheet(pairing.absolutePath);
}

function typedCellValue(value) {
  if (value == null || value === "") return {};
  if (typeof value === "number") return { userEnteredValue: { numberValue: value } };
  if (typeof value === "boolean") return { userEnteredValue: { boolValue: value } };
  const text = String(value);
  if (text.startsWith("=")) return { userEnteredValue: { formulaValue: text } };
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) {
    return { userEnteredValue: { numberValue: Number(text) } };
  }
  if (/^(?:TRUE|FALSE)$/i.test(text)) {
    return { userEnteredValue: { boolValue: text.toUpperCase() === "TRUE" } };
  }
  return { userEnteredValue: { stringValue: text } };
}

function comparableCellValue(value) {
  const cell = typedCellValue(value).userEnteredValue;
  if (!cell) return "empty:";
  const [kind, contents] = Object.entries(cell)[0];
  return `${kind}:${String(contents)}`;
}

function changedValueRequests(sheetId, localValues, remoteValues) {
  const requests = [];
  const rowCount = Math.max(localValues.length, remoteValues.length);
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const localRow = localValues[rowIndex] ?? [];
    const remoteRow = remoteValues[rowIndex] ?? [];
    const columnCount = Math.max(localRow.length, remoteRow.length);
    let startColumnIndex;
    let cells = [];
    const flush = () => {
      if (startColumnIndex == null) return;
      requests.push({
        updateCells: {
          start: { sheetId, rowIndex, columnIndex: startColumnIndex },
          rows: [{ values: cells }],
          fields: "userEnteredValue",
        },
      });
      startColumnIndex = undefined;
      cells = [];
    };
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const localValue = localRow[columnIndex] ?? "";
      const remoteValue = remoteRow[columnIndex] ?? "";
      if (comparableCellValue(localValue) === comparableCellValue(remoteValue)) {
        flush();
        continue;
      }
      startColumnIndex ??= columnIndex;
      cells.push(typedCellValue(localValue));
    }
    flush();
  }
  return requests;
}

function expandedTableRequests(sheet, values) {
  if (!sheet) return [];
  const rowCount = values.length;
  const columnCount = Math.max(0, ...values.map((row) => row.length));
  return (sheet.tables ?? []).flatMap((table) => {
    const range = table.range;
    if (!range || range.sheetId !== sheet.properties.sheetId) return [];
    const startRowIndex = range.startRowIndex ?? 0;
    const startColumnIndex = range.startColumnIndex ?? 0;
    const endRowIndex = Math.max(range.endRowIndex ?? startRowIndex, rowCount);
    const endColumnIndex = Math.max(range.endColumnIndex ?? startColumnIndex, columnCount);
    if (endRowIndex === range.endRowIndex && endColumnIndex === range.endColumnIndex) return [];
    return [{
      updateTable: {
        table: {
          tableId: table.tableId,
          range: { ...range, endRowIndex, endColumnIndex },
        },
        fields: "range",
      },
    }];
  });
}

function a1GridRange(range, sheetId) {
  const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(String(range));
  if (!match) return undefined;
  const columnIndex = (name) => [...name].reduce(
    (value, character) => value * 26 + character.charCodeAt(0) - 64,
    0,
  ) - 1;
  return {
    sheetId,
    startRowIndex: Number(match[2]) - 1,
    endRowIndex: Number(match[4]),
    startColumnIndex: columnIndex(match[1]),
    endColumnIndex: columnIndex(match[3]) + 1,
  };
}

function restoredFormatRequests(sheetId, formats = []) {
  return formats.flatMap((format) => {
    const range = a1GridRange(format.range, sheetId);
    const textFormat = meaningfulTextFormat(format.textFormat);
    const userEnteredFormat = {
      ...(format.numberFormat ? { numberFormat: format.numberFormat } : {}),
      ...(textFormat ? { textFormat } : {}),
    };
    const fields = [
      ...(format.numberFormat ? ["userEnteredFormat.numberFormat"] : []),
      ...Object.keys(textFormat ?? {}).map((property) => `userEnteredFormat.textFormat.${property}`),
    ];
    if (!range || !fields.length) return [];
    return [{
      repeatCell: {
        range,
        cell: { userEnteredFormat },
        fields: fields.join(","),
      },
    }];
  });
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
  const remoteByTitle = new Map(remoteSheets.map((sheet) => [sheet.title, sheet]));
  const retainedRemoteIds = new Set();
  const requests = [];
  const addedTitles = new Set();
  for (const sheet of local.sheets) {
    const matched = remoteById.get(sheet.sheetId) ?? remoteByTitle.get(sheet.title);
    if (!matched) {
      requests.push({ addSheet: { properties: { title: sheet.title } } });
      addedTitles.add(sheet.title);
    } else {
      retainedRemoteIds.add(matched.sheetId);
      if (matched.title !== sheet.title) {
        requests.push({ updateSheetProperties: { properties: { sheetId: matched.sheetId, title: sheet.title }, fields: "title" } });
      }
    }
  }
  requests.push(...remoteSheets
    .filter((sheet) => !retainedRemoteIds.has(sheet.sheetId))
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
  const contentSheets = (refreshed.spreadsheet.sheets ?? [])
    .filter((sheet) => sheet.properties?.title !== SHEET_STATUS_TITLE);
  const valueResponse = contentSheets.length
    ? await googleOperation("sheets.values.batchGet", () => services.sheets.spreadsheets.values.batchGet({
        spreadsheetId: pairing.spreadsheetId,
        ranges: contentSheets.map((sheet) => quoteSheet(sheet.properties.title)),
        valueRenderOption: "FORMULA",
        dateTimeRenderOption: "SERIAL_NUMBER",
      }))
    : { data: { valueRanges: [] } };
  const remoteValuesByTitle = new Map(contentSheets.map((sheet, index) => [
    sheet.properties.title,
    valueResponse.data.valueRanges?.[index]?.values ?? [],
  ]));
  const sheetByTitle = new Map(contentSheets.map((sheet) => [sheet.properties.title, sheet]));
  const valueRequests = [];
  for (const sheet of local.sheets) {
    sheet.sheetId = byTitle.get(sheet.title)?.sheetId;
    const remoteSheet = sheetByTitle.get(sheet.title);
    valueRequests.push(
      ...expandedTableRequests(remoteSheet, sheet.values),
      ...changedValueRequests(
        sheet.sheetId,
        sheet.values,
        remoteValuesByTitle.get(sheet.title) ?? [],
      ),
      ...(addedTitles.has(sheet.title)
        ? restoredFormatRequests(
            sheet.sheetId,
            local.metadata?.sheets?.find((stored) => stored.file === sheet.file)?.formats,
          )
        : []),
    );
  }
  if (valueRequests.length) {
    await googleOperation("sheets.spreadsheets.batchUpdate", () => services.sheets.spreadsheets.batchUpdate({
      spreadsheetId: pairing.spreadsheetId,
      requestBody: { requests: valueRequests },
    }));
  }
  const finalized = valueRequests.length
    ? await getSpreadsheetDetails(services, pairing.spreadsheetId, refreshed)
    : refreshed;
  await writeSpreadsheetMetadata(pairing, spreadsheetMetadata(
    pairing,
    finalized,
    local.sheets,
    local.metadata,
  ));
  return finalized;
}
