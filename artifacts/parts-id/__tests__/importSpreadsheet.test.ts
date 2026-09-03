import * as XLSX from "@e965/xlsx";

import { serializeToCsv } from "@/utils/binSkipLogic";
import { parseOdsWorkbook } from "@/utils/importSpreadsheet";

function odsWorkbook(sheets: Array<{ name: string; rows: Array<Array<unknown>> }>): ArrayBuffer {
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name);
  }
  return XLSX.write(workbook, { bookType: "ods", type: "array" }) as ArrayBuffer;
}

describe("ODS inventory import", () => {
  it("selects the best Vendor/Catalog sheet and maps description, binLocation, and barcodes", () => {
    const rows = parseOdsWorkbook(odsWorkbook([
      {
        name: "Instructions",
        rows: [["This is not an inventory sheet"], ["Use the Vendor Catalog tab"]],
      },
      {
        name: "Vendor Catalog",
        rows: [
          ["Vendor", "Catalog", "Description", "binLocation", "Barcodes"],
          ["Acme", "A-100", "Relay", "A1; A2", "123, 456"],
        ],
      },
    ]));

    expect(rows).toEqual([
      {
        vendor: "Acme",
        catalog: "A-100",
        description: "Relay",
        binLocations: ["A1", "A2"],
        barcodes: ["123", "456"],
      },
    ]);
  });

  it("maps the bin alias as well as binLocation", () => {
    const rows = parseOdsWorkbook(odsWorkbook([
      {
        name: "Vendor",
        rows: [
          ["vendor", "catalog", "description", "bin", "barcode"],
          ["Acme", "A-101", "Fuse", "B3|B4", "789|012"],
        ],
      },
    ]));

    expect(rows[0]).toMatchObject({
      vendor: "Acme",
      catalog: "A-101",
      description: "Fuse",
      binLocations: ["B3", "B4"],
      barcodes: ["789", "012"],
    });
  });

  it("rejects sheets missing either required Vendor or Catalog column", () => {
    expect(parseOdsWorkbook(odsWorkbook([
      {
        name: "Only Vendor",
        rows: [["Vendor", "Description"], ["Acme", "Missing catalog"]],
      },
    ]))).toEqual([]);

    expect(parseOdsWorkbook(odsWorkbook([
      {
        name: "Only Catalog",
        rows: [["Catalog", "Description"], ["A-102", "Missing vendor"]],
      },
    ]))).toEqual([]);
  });

  it("returns no rows for empty or malformed workbooks", () => {
    expect(parseOdsWorkbook(odsWorkbook([
      { name: "Empty", rows: [] },
    ]))).toEqual([]);
    expect(parseOdsWorkbook(new Uint8Array([1, 2, 3]).buffer)).toEqual([]);
  });

  it("uses the canonical CSV serializer for the existing preview/upload flow", () => {
    const rows = parseOdsWorkbook(odsWorkbook([
      {
        name: "Inventory",
        rows: [
          ["Vendor", "Catalog", "Description", "binLocation", "Barcode"],
          ["Acme", "A-103", '5" relay', "C1", "345;678"],
        ],
      },
    ]));

    expect(serializeToCsv(rows, new Set())).toBe(
      '\uFEFFVendor,Catalog,Description,BinLocation,Barcodes\n"Acme","A-103","5"" relay","C1","345;678"',
    );
  });
});