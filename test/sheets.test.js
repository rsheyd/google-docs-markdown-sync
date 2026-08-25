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
    const metadata = JSON.parse(await fs.readFile(path.join(directory, ".google-sheets-sync.json"), "utf8"));
    assert.equal(metadata.sheets[1].sheetId, 2);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("plans tab changes before replacing cell contents", async () => {
  const calls = [];
  const local = {
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
        clear: async ({ range }) => { calls.push(`clear:${range}`); },
        update: async ({ range, requestBody }) => { calls.push({ range, values: requestBody.values }); },
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
    assert.equal((await readLocalSpreadsheet(directory)).sheets.length, 0);
    const metadata = JSON.parse(await fs.readFile(path.join(directory, ".google-sheets-sync.json"), "utf8"));
    assert.equal(metadata.sheets[1].sheetId, 3);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
