import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseCsv,
  pullSpreadsheet,
  pushSpreadsheet,
  readLocalSpreadsheet,
  sheetFilename,
  stringifyCsv,
} from "../src/sheets.js";

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
