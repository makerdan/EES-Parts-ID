import * as XLSX from "@e965/xlsx";

import type { ParsedRow } from "@/utils/binSkipLogic";

export const VENDOR_ALIASES = ["vendor", "mfr", "manufacturer", "brand", "make", "supplier"];
export const CATALOG_ALIASES = [
  "catalog",
  "catalog#",
  "cat#",
  "part",
  "part#",
  "partno",
  "item",
  "itemno",
  "sku",
  "model",
  "partnumber",
  "part number",
  "cat no",
  "catalog no",
];
export const DESC_ALIASES = ["description", "desc", "name", "product", "productname", "title", "item description"];
export const BIN_ALIASES = ["bin", "bin location", "binlocation", "location", "loc", "shelf", "aisle", "bin#", "bin no"];
export const BARCODE_ALIASES = ["barcode", "barcodes", "barcode#", "upc", "ean", "gtin"];

type SpreadsheetRows = ReadonlyArray<ReadonlyArray<unknown>>;

function normalizeHeader(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/['"]/g, "");
}

export function findSpreadsheetColumn(headers: Array<string>, aliases: ReadonlyArray<string>): number {
  return aliases.map(alias => headers.indexOf(alias)).find(index => index >= 0) ?? -1;
}

export function parseBinCell(cell: string): Array<string> {
  const trimmed = cell.trim();
  if (!trimmed) return [];
  return trimmed.split(/[;|]/).map(bin => bin.trim()).filter(bin => bin.length > 0);
}

/**
 * Normalize worksheet rows into the import model used by CSV and spreadsheet
 * imports. ODS callers require both Vendor and Catalog so malformed sheets
 * cannot turn into UNKNOWN placeholder rows.
 */
export function normalizeSpreadsheetRows(
  sourceRows: SpreadsheetRows,
  requireRequiredColumns = false,
): Array<ParsedRow> {
  if (sourceRows.length < 2) return [];

  const headers = sourceRows[0]!.map(normalizeHeader);
  const vendorCol = findSpreadsheetColumn(headers, VENDOR_ALIASES);
  const catalogCol = findSpreadsheetColumn(headers, CATALOG_ALIASES);
  if (requireRequiredColumns && (vendorCol < 0 || catalogCol < 0)) return [];

  const descCol = findSpreadsheetColumn(headers, DESC_ALIASES);
  const binCol = findSpreadsheetColumn(headers, BIN_ALIASES);
  const barcodeCol = findSpreadsheetColumn(headers, BARCODE_ALIASES);

  const rows: Array<ParsedRow> = [];
  for (let i = 1; i < sourceRows.length; i++) {
    const cells = sourceRows[i]!.map(cell => String(cell ?? "").trim());
    const vendor = vendorCol >= 0 ? cells[vendorCol] ?? "" : "";
    const catalog = catalogCol >= 0 ? cells[catalogCol] ?? "" : "";
    if (!vendor && !catalog) continue;
    rows.push({
      vendor: vendor || "UNKNOWN",
      catalog: catalog || "UNKNOWN",
      description: descCol >= 0 ? cells[descCol] ?? "" : "",
      binLocations: binCol >= 0 ? parseBinCell(cells[binCol] ?? "") : [],
      barcodes: barcodeCol >= 0
        ? (cells[barcodeCol] ?? "").split(/[,;|]/).map(barcode => barcode.trim()).filter(barcode => barcode.length > 0)
        : [],
    });
  }
  return rows;
}

function worksheetScore(sourceRows: SpreadsheetRows): number {
  const headers = sourceRows[0]?.map(normalizeHeader) ?? [];
  let score = 0;
  if (VENDOR_ALIASES.some(alias => headers.includes(alias))) score += 2;
  if (CATALOG_ALIASES.some(alias => headers.includes(alias))) score += 2;
  return score;
}

/**
 * Parse an ODS workbook from its fetched bytes. SheetJS supports ODS in the
 * browser and React Native bundle, and reading every named sheet lets us
 * choose the best Vendor/Catalog candidate deterministically.
 */
export function parseOdsWorkbook(arrayBuffer: ArrayBuffer): Array<ParsedRow> {
  const workbook = XLSX.read(arrayBuffer, { type: "array", cellDates: false });
  let bestRows: SpreadsheetRows | null = null;
  let bestScore = -1;

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<Array<unknown>>(sheet, {
      header: 1,
      raw: true,
      defval: "",
      blankrows: false,
    });
    const score = worksheetScore(rows);
    if (score > bestScore) {
      bestScore = score;
      bestRows = rows;
    }
  }

  if (!bestRows || bestScore < 4) return [];
  return normalizeSpreadsheetRows(bestRows, true);
}

export async function parseOds(uri: string): Promise<Array<ParsedRow>> {
  const response = await fetch(uri);
  if (!response.ok) throw new Error(`Failed to read file: ${response.status}`);
  return parseOdsWorkbook(await response.arrayBuffer());
}