/**
 * Barcode CSV/XLSX import script.
 *
 * Usage (from workspace root):
 *   DATABASE_URL="$DATABASE_URL" pnpm --filter @workspace/api-server seed:barcodes <file>
 *
 * Accepts .csv or .xlsx files. Detects catalog/part-number and barcode columns
 * automatically from common header variations. Optionally matches on vendor too.
 *
 * The import is idempotent — running it twice will not create duplicate barcodes.
 * Unmatched rows (catalog not found in DB) are written to unmatched-barcodes.csv
 * in the current working directory.
 */

import { resolve } from "node:path";
import { createWriteStream } from "node:fs";
import ExcelJS from "exceljs";
import { db, pool } from "@workspace/db";
import { inventoryTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: seed:barcodes <path-to-csv-or-xlsx>");
  process.exit(1);
}

const CATALOG_HEADER_VARIANTS = [
  "catalog",
  "catalognumber",
  "catalog_number",
  "part",
  "partnumber",
  "part_number",
  "partno",
  "part_no",
  "item",
  "itemnumber",
  "item_number",
  "sku",
];

const BARCODE_HEADER_VARIANTS = [
  "barcode",
  "barcodes",
  "upc",
  "ean",
  "ean13",
  "upc_a",
  "upca",
  "barcode_value",
  "barcodevalue",
  "code",
];

const VENDOR_HEADER_VARIANTS = [
  "vendor",
  "vendorname",
  "vendor_name",
  "manufacturer",
  "mfr",
  "brand",
  "supplier",
];

interface CsvRow {
  [key: string]: string;
}

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[\s_\-]+/g, "");
}

function detectColumn(
  headers: string[],
  variants: string[],
): number | null {
  for (let i = 0; i < headers.length; i++) {
    const normalized = normalizeHeader(headers[i]);
    if (variants.some((v) => normalized === v || normalized.includes(v))) {
      return i;
    }
  }
  return null;
}

async function importBarcodes() {
  const absolutePath = resolve(process.cwd(), filePath);
  console.log("Reading file:", absolutePath);

  const workbook = new ExcelJS.Workbook();
  const ext = absolutePath.toLowerCase();
  if (ext.endsWith(".csv")) {
    await workbook.csv.readFile(absolutePath);
  } else {
    await workbook.xlsx.readFile(absolutePath);
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) {
    console.error("No worksheets found in file");
    process.exit(1);
  }

  // Read headers from row 1
  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, colIdx) => {
    headers[colIdx - 1] = String(cell.value ?? "").trim();
  });

  console.log("Columns found:", headers.filter(Boolean));

  const catalogIdx = detectColumn(headers, CATALOG_HEADER_VARIANTS);
  const barcodeIdx = detectColumn(headers, BARCODE_HEADER_VARIANTS);
  const vendorIdx = detectColumn(headers, VENDOR_HEADER_VARIANTS);

  if (catalogIdx === null) {
    console.error(
      `\nERROR: Could not detect a catalog/part-number column.\n` +
        `Headers found: ${headers.filter(Boolean).join(", ")}\n` +
        `Expected one of: ${CATALOG_HEADER_VARIANTS.join(", ")}`,
    );
    process.exit(1);
  }

  if (barcodeIdx === null) {
    console.error(
      `\nERROR: Could not detect a barcode column.\n` +
        `Headers found: ${headers.filter(Boolean).join(", ")}\n` +
        `Expected one of: ${BARCODE_HEADER_VARIANTS.join(", ")}`,
    );
    process.exit(1);
  }

  console.log(`Catalog column : "${headers[catalogIdx]}"`);
  console.log(`Barcode column : "${headers[barcodeIdx]}"`);
  if (vendorIdx !== null) {
    console.log(`Vendor column  : "${headers[vendorIdx]}" (optional match)`);
  }

  // Read all data rows
  const rawRows: CsvRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum === 1) return;
    const obj: CsvRow = {};
    row.eachCell({ includeEmpty: true }, (cell, colIdx) => {
      const header = headers[colIdx - 1];
      if (header) obj[header] = String(cell.value ?? "").trim();
    });
    rawRows.push(obj);
  });

  console.log(`\nTotal rows read: ${rawRows.length}`);

  if (rawRows.length === 0) {
    console.error("No data rows found in file");
    process.exit(1);
  }

  // Stats
  let processed = 0;
  let matched = 0;
  let updated = 0;
  let alreadyHad = 0;
  let unmatched = 0;
  const unmatchedRows: CsvRow[] = [];

  for (const row of rawRows) {
    processed++;

    const catalogRaw = (row[headers[catalogIdx]] ?? "").trim();
    const barcodeRaw = (row[headers[barcodeIdx]] ?? "").trim();
    const vendorRaw =
      vendorIdx !== null
        ? (row[headers[vendorIdx]] ?? "").trim().toUpperCase()
        : null;

    if (!catalogRaw || !barcodeRaw) {
      unmatched++;
      unmatchedRows.push(row);
      continue;
    }

    // Query inventory — case-insensitive catalog match
    const conditions = [
      sql`lower(${inventoryTable.catalog}) = lower(${catalogRaw})`,
    ];

    if (vendorRaw) {
      conditions.push(
        sql`upper(${inventoryTable.vendor}) = ${vendorRaw}`,
      );
    }

    const whereClause =
      conditions.length === 1
        ? conditions[0]
        : sql`${conditions[0]} AND ${conditions[1]}`;

    const rows = await db
      .select({
        id: inventoryTable.id,
        barcodes: inventoryTable.barcodes,
      })
      .from(inventoryTable)
      .where(whereClause);

    if (rows.length === 0) {
      unmatched++;
      unmatchedRows.push(row);
      continue;
    }

    matched++;

    // Use first match (catalog is unique per vendor; if no vendor filter, take first)
    const inv = rows[0];
    const existing: string[] = inv.barcodes ?? [];

    if (existing.includes(barcodeRaw)) {
      alreadyHad++;
      continue;
    }

    // Append barcode
    await db
      .update(inventoryTable)
      .set({
        barcodes: sql`array_append(${inventoryTable.barcodes}, ${barcodeRaw})`,
        updatedAt: sql`now()`,
      })
      .where(eq(inventoryTable.id, inv.id));

    updated++;
  }

  // Refresh PostgreSQL planner statistics so inventory_fts_idx continues to be
  // chosen over a sequential scan after row-level updates to barcodes.
  console.log("\nRunning ANALYZE inventory to refresh query-planner statistics...");
  await db.execute(sql`ANALYZE inventory`);
  console.log("ANALYZE complete.");

  // Phase 2 planner smoke-test: confirm inventory_fts_idx is used by the planner.
  // Mirrors lib/db/scripts/verify-fts-index.ts Phase 2 logic.
  console.log("Running FTS planner smoke-test...");
  {
    const FTS_VECTOR_EXPR =
      `to_tsvector('english', ` +
      `coalesce(i.vendor,'') || ' ' || ` +
      `coalesce(i.catalog,'') || ' ' || ` +
      `coalesce(i.description,'') || ' ' || ` +
      `coalesce(i.expanded_description,'') || ' ' || ` +
      `immutable_array_to_string(i.ai_keywords,' '))`;

    const countRes = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM inventory`,
    );
    const rowCount = parseInt(countRes.rows[0]?.n ?? "0", 10);

    if (rowCount === 0) {
      console.warn("WARN: inventory table is empty — planner check skipped.");
    } else {
      const explainRes = await pool.query<{ "QUERY PLAN": string }>(
        `EXPLAIN (ANALYZE, FORMAT TEXT, BUFFERS OFF)
         SELECT i.id FROM inventory i
         WHERE ${FTS_VECTOR_EXPR} @@ websearch_to_tsquery('english', 'xverifyftszz')
         LIMIT 1`,
      );
      const planText = explainRes.rows.map((r) => r["QUERY PLAN"]).join("\n");
      const INDEX_SCAN_RE =
        /(?:Index Scan using|Bitmap Index Scan on)\s+inventory_fts_idx\b/;
      if (INDEX_SCAN_RE.test(planText)) {
        console.log("OK: query planner is using inventory_fts_idx.");
      } else {
        console.warn(
          "WARN: inventory_fts_idx was NOT chosen by the planner after ANALYZE.\n" +
          "      Check enable_seqscan GUC or whether the index was dropped.",
        );
      }
    }
  }

  // Print summary
  console.log("\n=== Barcode Import Summary ===");
  console.log(`Rows processed      : ${processed}`);
  console.log(`Matched in DB       : ${matched}`);
  console.log(`Updated (new barcode): ${updated}`);
  console.log(`Skipped (duplicate) : ${alreadyHad}`);
  console.log(`Unmatched           : ${unmatched}`);

  // Write unmatched report
  if (unmatchedRows.length > 0) {
    const outPath = resolve(process.cwd(), "unmatched-barcodes.csv");
    const stream = createWriteStream(outPath);

    // Header
    stream.write(headers.filter(Boolean).join(",") + "\n");

    for (const row of unmatchedRows) {
      const line = headers
        .filter(Boolean)
        .map((h) => {
          const val = row[h] ?? "";
          // Quote values that contain commas or quotes
          if (val.includes(",") || val.includes('"') || val.includes("\n")) {
            return `"${val.replace(/"/g, '""')}"`;
          }
          return val;
        })
        .join(",");
      stream.write(line + "\n");
    }

    await new Promise<void>((res, rej) => {
      stream.end();
      stream.on("finish", res);
      stream.on("error", rej);
    });

    console.log(`\nUnmatched rows written to: ${outPath}`);
  } else {
    console.log("\nNo unmatched rows — skipping unmatched-barcodes.csv");
  }

  await pool.end();
}

importBarcodes().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});
