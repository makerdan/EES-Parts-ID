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

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { db, pool } from "@workspace/db";
import { inventoryTable } from "@workspace/db";
import { sql } from "drizzle-orm";

const __dirname = dirname(fileURLToPath(import.meta.url));

const XLSX_PATH = resolve(__dirname, "../../../../attached_assets/Master_INC_Report_(04.29.2026)_-_For_PartsID_Database_1777605533561.xlsx");
const BATCH_SIZE = 250;

interface SpreadsheetRow {
  vendor?: string;
  catalog?: string;
  description?: string;
  binlocation?: string;
  [key: string]: unknown;
}

async function importSpreadsheet() {
  console.log("Reading spreadsheet:", XLSX_PATH);
  const buffer = readFileSync(XLSX_PATH);
  const workbook = XLSX.read(buffer, { type: "buffer" });

  const sheetName = workbook.SheetNames[0];
  console.log(`Using sheet: ${sheetName}`);

  const sheet = workbook.Sheets[sheetName!]!;
  const rawRows: SpreadsheetRow[] = XLSX.utils.sheet_to_json(sheet, {
    defval: "",
    raw: false,
  });

  console.log(`Total rows read: ${rawRows.length}`);

  if (rawRows.length === 0) {
    console.error("No rows found in spreadsheet");
    process.exit(1);
  }

  // Inspect column names
  const firstRow = rawRows[0]!;
  console.log("Columns found:", Object.keys(firstRow));

  // Normalize column names (lowercase, strip spaces)
  function normalizeKey(row: SpreadsheetRow, ...candidates: string[]): string {
    for (const key of Object.keys(row)) {
      const normalized = key.toLowerCase().replace(/\s+/g, "");
      if (candidates.some(c => normalized === c || normalized.includes(c))) {
        return row[key] as string ?? "";
      }
    }
    return "";
  }

  // Map rows to inventory schema
  const items = rawRows
    .map((row) => ({
      vendor: (normalizeKey(row, "vendor") || "").toString().trim().toUpperCase(),
      catalog: (normalizeKey(row, "catalog", "catalognumber", "part", "partnumber", "item") || "").toString().trim(),
      description: (normalizeKey(row, "description", "desc") || "").toString().trim(),
      binLocation: (normalizeKey(row, "binlocation", "bin", "location", "binloc") || "").toString().trim(),
    }))
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
            binLocation: item.binLocation,
            aiKeywords: [],
          }))
        )
        .onConflictDoUpdate({
          target: [inventoryTable.vendor, inventoryTable.catalog],
          set: {
            description: sql`EXCLUDED.description`,
            binLocation: sql`EXCLUDED.bin_location`,
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
