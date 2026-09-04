import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createSpreadsheet,
  initialSheetTitle,
  organizeCsvFiles,
  parseCsv,
  pullSpreadsheet,
  getSpreadsheetDriveInfo,
  pushSpreadsheet,
  readLocalSpreadsheet,
  sheetFilename,
  stringifyCsv,
} from "../src/sheets.js";
import { parseSpreadsheetMetadata, spreadsheetStatusMarkdown } from "../src/status.js";

test("attaches the Google operation and elapsed time to spreadsheet failures", async () => {
  const failure = Object.assign(new Error("The operation was aborted."), {
    code: "ABORT_ERR",
  });
  await assert.rejects(
    getSpreadsheetDriveInfo({
      drive: { files: { get: async () => { throw failure; } } },
    }, "spreadsheet"),
    (error) => {
      assert.equal(error.gdmsOperation, "drive.files.get");
      assert.equal(Number.isFinite(error.gdmsElapsedMs), true);
      return true;
    },
  );
});

test("sanitizes CSV filenames into valid initial tab names", () => {
  assert.equal(initialSheetTitle("Q1: Sales?.csv"), "Q1- Sales-");
  assert.equal(initialSheetTitle("'.csv"), "Sheet");
});

test("creates a spreadsheet with one tab per CSV", async () => {
  let requestBody;
  const services = { sheets: { spreadsheets: { create: async (request) => {
    requestBody = request.requestBody;
    return { data: { spreadsheetId: "new-sheet" } };
  } } } };
  const created = await createSpreadsheet(services, "Budget", [
    { title: "Summary" },
    { title: "Transactions" },
  ]);
  assert.deepEqual(requestBody, {
    properties: { title: "Budget" },
    sheets: [
      { properties: { title: "Summary" } },
      { properties: { title: "Transactions" } },
    ],
  });
  assert.equal(created.spreadsheetUrl, "https://docs.google.com/spreadsheets/d/new-sheet/edit");
});

test("moves selected CSV files into a collision-safe spreadsheet directory", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "csv-organize-"));
  const first = path.join(workspace, "Summary.csv");
  const second = path.join(workspace, "Data.csv");
  await Promise.all([fs.writeFile(first, "a\n"), fs.writeFile(second, "b\n")]);
  await fs.mkdir(path.join(workspace, "Budget"));
  try {
    const result = await organizeCsvFiles([first, second], "Budget");
    assert.equal(result.directory, path.join(workspace, "Budget-2"));
    assert.deepEqual(result.files.map((file) => path.basename(file)), ["Summary.csv", "Data.csv"]);
    await assert.rejects(fs.access(first));
    assert.equal(await fs.readFile(path.join(result.directory, "Data.csv"), "utf8"), "b\n");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("validates all CSV selections before moving any file", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "csv-validate-"));
  const csv = path.join(workspace, "Data.csv");
  const text = path.join(workspace, "Notes.txt");
  await Promise.all([fs.writeFile(csv, "a\n"), fs.writeFile(text, "b\n")]);
  try {
    await assert.rejects(organizeCsvFiles([csv, text], "Book"), /Not a CSV file/);
    assert.equal(await fs.readFile(csv, "utf8"), "a\n");
    await assert.rejects(fs.access(path.join(workspace, "Book")));
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("round-trips quoted CSV fields and formulas", () => {
  const rows = [["Name", "Formula"], ["A, B", '=SUM(A1:A2)'], ['a "quote"', "line\nbreak"]];
  assert.deepEqual(parseCsv(stringifyCsv(rows)), rows);
});

test("creates safe, collision-resistant tab filenames", () => {
  const occupied = new Set();
  assert.equal(sheetFilename("Q1 / Sales", 10, occupied), "Q1 - Sales.csv");
  assert.equal(sheetFilename("Q1 / Sales", 11, occupied), "Q1 - Sales-11.csv");
});

test("pulls every tab as CSV with formulas and metadata", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gsheets-sync-"));
  const pairing = { spreadsheetId: "spreadsheet", absolutePath: directory };
  const remote = {
    spreadsheet: { sheets: [
      { properties: { sheetId: 1, title: "Summary" } },
      { properties: { sheetId: 2, title: "Data / Raw" } },
      { properties: { sheetId: 99, title: "↔ Sync Status" } },
    ] },
  };
  const services = {
    sheets: { spreadsheets: { values: { batchGet: async () => ({ data: { valueRanges: [
      { values: [["Total", "=SUM(B2:B3)"]] },
      { values: [["Name", "Value"], ["A", 2]] },
    ] } }) } } },
  };
  try {
    const local = await pullSpreadsheet(services, pairing, remote);
    assert.deepEqual(local.sheets.map((sheet) => sheet.file), ["Data - Raw.csv", "Summary.csv"]);
    assert.equal(await fs.readFile(path.join(directory, "Summary.csv"), "utf8"), "Total,=SUM(B2:B3)\n");
    const metadata = parseSpreadsheetMetadata(await fs.readFile(path.join(directory, "GDMS.md"), "utf8"));
    assert.equal(metadata.sheets[1].sheetId, 2);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("does not rewrite CSV files for formatting-only remote revisions", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gsheets-format-only-"));
  const filePath = path.join(directory, "Data.csv");
  await fs.writeFile(filePath, "date,hours\n46268,1\n");
  await fs.writeFile(path.join(directory, ".google-sheets-sync.json"), JSON.stringify({
    version: 1,
    spreadsheetId: "spreadsheet",
    sheets: [{ sheetId: 1, title: "Data", file: "Data.csv" }],
  }));
  const before = (await fs.stat(filePath)).mtimeMs;
  const services = {
    sheets: { spreadsheets: { values: { batchGet: async () => ({ data: { valueRanges: [
      { values: [["date", "hours"], [46268, 1]] },
    ] } }) } } },
  };
  try {
    const local = await pullSpreadsheet(services, { spreadsheetId: "spreadsheet", absolutePath: directory }, {
      spreadsheet: { sheets: [{ properties: { sheetId: 1, title: "Data" } }] },
    });
    assert.equal(local.modifiedTime, before);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("plans tab changes before replacing cell contents", async () => {
  const calls = [];
  const local = {
    metadata: {
      sheets: [{ file: "Added.csv", formats: [{
        range: "A1:A1",
        textFormat: { bold: true, italic: true },
      }] }],
    },
    sheets: [
      { sheetId: 1, title: "Kept", file: "Kept.csv", values: [["=1+1"]] },
      { title: "Added", file: "Added.csv", values: [["new"]] },
    ],
  };
  const remote = {
    spreadsheet: { sheets: [
      { properties: { sheetId: 1, title: "Old" } },
      { properties: { sheetId: 2, title: "Removed" } },
      { properties: { sheetId: 99, title: "↔ Sync Status" } },
    ] },
  };
  const services = {
    drive: { files: { get: async () => ({ data: { modifiedTime: "now", name: "Book", version: "2" } }) } },
    sheets: { spreadsheets: {
      batchUpdate: async ({ requestBody }) => { calls.push(requestBody.requests); },
      get: async () => ({ data: { sheets: [
        { properties: { sheetId: 1, title: "Kept" } },
        { properties: { sheetId: 3, title: "Added" } },
      ] } }),
      values: {
        batchGet: async () => ({ data: { valueRanges: [
          { values: [["old"]] },
          { values: [] },
        ] } }),
      },
    } },
  };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gsheets-push-"));
  try {
    await pushSpreadsheet(services, { spreadsheetId: "spreadsheet", absolutePath: directory }, local, remote);
    assert.deepEqual(calls[0], [
      { updateSheetProperties: { properties: { sheetId: 1, title: "Kept" }, fields: "title" } },
      { addSheet: { properties: { title: "Added" } } },
      { deleteSheet: { sheetId: 2 } },
    ]);
    assert.deepEqual(calls[1], [
      {
        updateCells: {
          start: { sheetId: 1, rowIndex: 0, columnIndex: 0 },
          rows: [{ values: [{ userEnteredValue: { formulaValue: "=1+1" } }] }],
          fields: "userEnteredValue",
        },
      },
      {
        updateCells: {
          start: { sheetId: 3, rowIndex: 0, columnIndex: 0 },
          rows: [{ values: [{ userEnteredValue: { stringValue: "new" } }] }],
          fields: "userEnteredValue",
        },
      },
      {
        repeatCell: {
          range: {
            sheetId: 3,
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: 0,
            endColumnIndex: 1,
          },
          cell: { userEnteredFormat: { textFormat: { bold: true, italic: true } } },
          fields: "userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.italic",
        },
      },
    ]);
    assert.equal((await readLocalSpreadsheet(directory)).sheets.length, 0);
    const metadata = parseSpreadsheetMetadata(await fs.readFile(path.join(directory, "GDMS.md"), "utf8"));
    assert.equal(metadata.sheets[1].sheetId, 3);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("migrates legacy spreadsheet sidecars into one visible GDMS file", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gsheets-sidecar-"));
  const pairing = {
    spreadsheetId: "spreadsheet",
    spreadsheetUrl: "https://docs.google.com/spreadsheets/d/spreadsheet/edit",
    directoryPath: "budget",
    absolutePath: directory,
    name: "Budget",
  };
  await fs.writeFile(path.join(directory, "Data.csv"), "date,total\n46268,10\n");
  await fs.writeFile(path.join(directory, ".google-sheets-sync.json"), JSON.stringify({
    version: 1,
    spreadsheetId: "spreadsheet",
    sheets: [{ sheetId: 4, title: "Data", file: "Data.csv" }],
  }));
  await fs.writeFile(path.join(directory, "SYNC-STATUS.md"), spreadsheetStatusMarkdown(pairing, {}));
  const services = {
    sheets: { spreadsheets: { values: { batchGet: async () => ({ data: { valueRanges: [{
      values: [["date", "total"], [46268, 10]],
    }] } }) } } },
  };
  try {
    await pullSpreadsheet(services, pairing, {
      spreadsheet: { sheets: [{
        properties: { sheetId: 4, title: "Data", gridProperties: { rowCount: 100, columnCount: 2 } },
        data: [{ rowData: [
          { values: [
            { userEnteredFormat: { textFormat: { bold: true } } },
            { userEnteredFormat: { textFormat: { bold: true } } },
          ] },
          { values: [{ userEnteredFormat: {
            numberFormat: { type: "DATE", pattern: "m/d/yy" },
            textFormat: { italic: true, underline: true, strikethrough: true },
          } }] },
        ] }],
        tables: [{
          tableId: "table-4",
          name: "DataTable",
          range: { sheetId: 4, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 2 },
          columnProperties: [{ columnIndex: 0, columnName: "date", columnType: "DATE" }],
        }],
      }] },
    });
    const markdown = await fs.readFile(path.join(directory, "GDMS.md"), "utf8");
    const metadata = parseSpreadsheetMetadata(markdown);
    assert.match(markdown, /Table `DataTable`: `A1:B2`/);
    assert.match(markdown, /`A1:B1`: bold/);
    assert.match(markdown, /`A2:A2`: date, `m\/d\/yy`, italic, underline, strikethrough/);
    assert.deepEqual(metadata.sheets[0].formats[0], {
      range: "A1:B1",
      textFormat: { bold: true },
    });
    assert.equal(metadata.sheets[0].tables[0].columnProperties[0].columnType, "DATE");
    await assert.rejects(fs.access(path.join(directory, ".google-sheets-sync.json")));
    await assert.rejects(fs.access(path.join(directory, "SYNC-STATUS.md")));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("writes typed values without changing formats and expands native tables", async () => {
  const calls = [];
  const services = {
    drive: { files: { get: async () => ({ data: { modifiedTime: "now", name: "Book", version: "2" } }) } },
    sheets: { spreadsheets: {
      batchUpdate: async ({ requestBody }) => { calls.push(requestBody.requests); },
      get: async () => ({ data: { sheets: [{
        properties: { sheetId: 7, title: "Hours" },
        tables: [{
          tableId: "table-1",
          range: { sheetId: 7, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 2 },
        }],
      }] } }),
      values: { batchGet: async () => ({ data: { valueRanges: [{
        values: [["date", "approved"], [46267, false]],
      }] } }) },
    } },
  };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gsheets-formats-"));
  try {
    await pushSpreadsheet(services, { spreadsheetId: "spreadsheet", absolutePath: directory }, {
      sheets: [{
        sheetId: 7,
        title: "Hours",
        file: "Hours.csv",
        values: [["date", "approved"], ["46268", "TRUE"], ["46269", "FALSE"]],
      }],
    }, { spreadsheet: { sheets: [{ properties: { sheetId: 7, title: "Hours" } }] } });
    assert.deepEqual(calls, [[
      {
        updateTable: {
          table: {
            tableId: "table-1",
            range: { sheetId: 7, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 2 },
          },
          fields: "range",
        },
      },
      {
        updateCells: {
          start: { sheetId: 7, rowIndex: 1, columnIndex: 0 },
          rows: [{ values: [
            { userEnteredValue: { numberValue: 46268 } },
            { userEnteredValue: { boolValue: true } },
          ] }],
          fields: "userEnteredValue",
        },
      },
      {
        updateCells: {
          start: { sheetId: 7, rowIndex: 2, columnIndex: 0 },
          rows: [{ values: [
            { userEnteredValue: { numberValue: 46269 } },
            { userEnteredValue: { boolValue: false } },
          ] }],
          fields: "userEnteredValue",
        },
      },
    ]]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
