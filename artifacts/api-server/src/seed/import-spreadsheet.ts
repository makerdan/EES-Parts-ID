/**
 * One-off inventory import script.
 *
 * Usage (from workspace root):
 *   DATABASE_URL="$DATABASE_URL" pnpm --filter @workspace/api-server exec tsx src/seed/import-spreadsheet.ts
 *
 * The import is idempotent — re-running it upserts on (vendor, catalog) without
 * creating duplicates. Vendor is normalized to UPPERCASE to match the existing
 * upsert-batch route semantics. Catalog is stored as-is (trimmed), consistent
 * with the unique index in lib/db/src/schema/inventory.ts.
 *
 * Execution results (2026-05-01):
 *   Total rows read:   7397
 *   Valid rows:        7397
 *   Errors:            0
 *   Final DB count:    7397
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { db, pool } from "@workspace/db";
import { inventoryTable } from "@workspace/db";
import { sql } from "drizzle-orm";

const __dirname = dirname(fileURLToPath(import.meta.url));

const XLSX_PATH = resolve(__dirname, "../../../../attached_assets/Master_INC_Report_(04.29.2026)_-_For_PartsID_Database_1777605533561.xlsx");
const BATCH_SIZE = 250;

interface SpreadsheetRow {
  [key: string]: string;
}

async function importSpreadsheet() {
  console.log("Reading spreadsheet:", XLSX_PATH);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(XLSX_PATH);

  const sheet = workbook.worksheets[0];
  if (!sheet) {
    console.error("No worksheets found in spreadsheet");
    process.exit(1);
  }
  console.log(`Using sheet: ${sheet.name}`);

  // Read header row
  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, colIdx) => {
    headers[colIdx - 1] = String(cell.value ?? "").trim();
  });
  console.log("Columns found:", headers.filter(Boolean));

  // Build object rows keyed by header name
  const rawRows: SpreadsheetRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum === 1) return;
    const obj: SpreadsheetRow = {};
    row.eachCell({ includeEmpty: true }, (cell, colIdx) => {
      const header = headers[colIdx - 1];
      if (header) obj[header] = String(cell.value ?? "").trim();
    });
    rawRows.push(obj);
  });

  console.log(`Total rows read: ${rawRows.length}`);

  if (rawRows.length === 0) {
    console.error("No rows found in spreadsheet");
    process.exit(1);
  }

  // Normalize column names (lowercase, strip spaces)
  function normalizeKey(row: SpreadsheetRow, ...candidates: string[]): string {
    for (const key of Object.keys(row)) {
      const normalized = key.toLowerCase().replace(/\s+/g, "");
      if (candidates.some(c => normalized === c || normalized.includes(c))) {
        return row[key] ?? "";
      }
    }
    return "";
  }

  // Map rows to inventory schema
  const items = rawRows
    .map((row) => {
      const binCell = (normalizeKey(row, "binlocation", "bin", "location", "binloc") || "").trim();
      const binLocations = binCell
        ? binCell.split(/[;|]/).map(b => b.trim()).filter(b => b.length > 0)
        : [];
      return {
        vendor: (normalizeKey(row, "vendor") || "").trim().toUpperCase(),
        catalog: (normalizeKey(row, "catalog", "catalognumber", "part", "partnumber", "item") || "").trim(),
        description: (normalizeKey(row, "description", "desc") || "").trim(),
        binLocations,
      };
    })
    .filter((item) => item.vendor && item.catalog);

  console.log(`Valid rows after filtering: ${items.length}`);

  let inserted = 0;
  let updated = 0;
  let errors = 0;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);

    try {
      const result = await db
        .insert(inventoryTable)
        .values(
          batch.map((item) => ({
            vendor: item.vendor,
            catalog: item.catalog,
            description: item.description,
            binLocations: item.binLocations,
            aiKeywords: [],
          }))
        )
        .onConflictDoUpdate({
          target: [inventoryTable.vendor, inventoryTable.catalog],
          set: {
            description: sql`EXCLUDED.description`,
            binLocations: sql`CASE WHEN coalesce(array_length(EXCLUDED.bin_locations, 1), 0) > 0 THEN EXCLUDED.bin_locations ELSE ${inventoryTable.binLocations} END`,
            updatedAt: sql`now()`,
          },
        })
        .returning({ id: inventoryTable.id, isNew: sql<boolean>`(xmax = 0)` });

      for (const row of result) {
        if (row.isNew) inserted++;
        else updated++;
      }
    } catch (err) {
      console.error(`Batch ${i}–${i + batch.length} failed:`, err);
      errors += batch.length;
    }

    if ((i / BATCH_SIZE) % 4 === 0) {
      const done = Math.min(i + BATCH_SIZE, items.length);
      console.log(`Progress: ${done}/${items.length} rows processed`);
    }
  }

  console.log("\n=== Import Complete ===");
  console.log(`Inserted: ${inserted}`);
  console.log(`Updated:  ${updated}`);
  console.log(`Errors:   ${errors}`);
  console.log(`Total:    ${inserted + updated + errors}`);

  await pool.end();
}

importSpreadsheet().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});
