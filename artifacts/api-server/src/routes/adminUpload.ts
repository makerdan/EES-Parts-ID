/**
 * POST /api/admin/upload
 *
 * Accept a CSV payload and upsert the parsed rows into the inventory table.
 * This is the server-side counterpart to the client-side XLSX/CSV parsing in
 * the mobile app upload screen.
 *
 * Request body (JSON):
 *   { csv: string }   — raw CSV text; first row is treated as the header
 *
 * Required columns (case-insensitive):
 *   Vendor, Catalog     — required
 *   Description         — optional
 *   BinLocation         — optional
 *   Barcodes            — optional (comma/semicolon/pipe-separated values within the cell)
 *
 * Response:
 *   200 { inserted: number, updated: number, total: number }
 *   400 { error: string }  — malformed CSV or missing required columns
 *   401                    — missing or invalid admin token
 *
 * POST /api/admin/upload/preview
 *
 * Dry-run: parses the same CSV body but only returns a bin-conflict diff
 * summary without writing anything to the database. Clients should call this
 * first and warn the user when willReplaceBins > 0.
 *
 * Response:
 *   200 { willReplaceBins, willAddBins, willPreserveBins, noChange, rows[] }
 *   400 { error: string }
 *   401
 */

import { db, inventoryTable } from "@workspace/db";
import { and,eq, or, sql } from "drizzle-orm";
import { Router } from "express";

import { invalidateReferenceAnswerCache } from "../lib/answerCache";
import { requireAdminAuth } from "../middlewares/requireAdminAuth";

const router = Router();

// Reject uploads larger than this before doing any parsing or DB work. The
// global JSON parser is set to 25mb (for AI image payloads); CSV uploads
// shouldn't approach that.
const UPLOAD_MAX_BYTES = 15 * 1024 * 1024; // 15 MB
// Defense-in-depth cap on the parsed CSV string length itself.
const UPLOAD_MAX_CSV_CHARS = 15 * 1024 * 1024; // ~15M chars

// ── CSV parser ────────────────────────────────────────────────────────────────

/** Split a single CSV line into fields, respecting double-quoted fields. */
function parseCsvLine(line: string): Array<string> {
  const fields: Array<string> = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { current += '"'; i++; } // escaped ""
        else inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

export interface ParsedRow {
  vendor: string;
  catalog: string;
  description: string;
  binLocations: Array<string>;
  barcodes: Array<string>;
}

/**
 * Parse a raw CSV string into structured inventory rows.
 * Returns null if the CSV is malformed (no header, or missing required columns).
 */
export function parseCsv(csvText: string): Array<ParsedRow> | null {
  // Strip UTF-8 BOM (\uFEFF) if present so Excel-exported files parse correctly.
  const text = csvText.startsWith("\uFEFF") ? csvText.slice(1) : csvText;
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return null; // header-only or empty

  const header = parseCsvLine(lines[0]!).map(h => h.toLowerCase().replace(/\s+/g, ""));
  const vendorIdx = header.findIndex(h => h === "vendor");
  const catalogIdx = header.findIndex(h => h === "catalog" || h === "catalog#" || h === "catalognumber");
  if (vendorIdx === -1 || catalogIdx === -1) return null;

  const descIdx = header.findIndex(h => h === "description");
  const binIdx = header.findIndex(h => h === "binlocation" || h === "bin" || h === "binnumber");
  const barcodeIdx = header.findIndex(h => h === "barcodes" || h === "barcode" || h === "upc" || h === "ean" || h === "gtin" || h === "barcode#");

  const rows: Array<ParsedRow> = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]!);
    const vendor = fields[vendorIdx]?.trim() ?? "";
    const catalog = fields[catalogIdx]?.trim() ?? "";
    if (!vendor || !catalog) continue; // skip blank/invalid rows
    const binCell = (binIdx >= 0 ? fields[binIdx]?.trim() : "") ?? "";
    // CSV may pack multiple bins separated by ; or | — split, trim, drop blanks
    const binLocations = binCell
      ? binCell.split(/[;|]/).map(b => b.trim()).filter(b => b.length > 0)
      : [];
    const barcodeCell = (barcodeIdx >= 0 ? fields[barcodeIdx]?.trim() : "") ?? "";
    // CSV may pack multiple barcodes separated by , ; or | — split, trim, drop blanks
    const barcodes = barcodeCell
      ? barcodeCell.split(/[,;|]/).map(b => b.trim()).filter(b => b.length > 0)
      : [];
    rows.push({
      vendor,
      catalog,
      description: (descIdx >= 0 ? fields[descIdx]?.trim() : "") ?? "",
      binLocations,
      barcodes,
    });
  }
  return rows;
}

// ── POST /admin/upload/preview ────────────────────────────────────────────────
// Dry-run: parse the CSV and return a bin-conflict diff summary identical to
// the one produced by /inventory/upsert-batch/preview. Nothing is written to
// the database. Clients should call this before /admin/upload and warn the
// user when willReplaceBins > 0.
router.post("/upload/preview", requireAdminAuth, async (req, res) => {
  try {
    const contentLength = Number(req.headers["content-length"] ?? 0);
    if (contentLength > UPLOAD_MAX_BYTES) {
      return void res.status(413).json({
        error: `Request body too large (limit ${UPLOAD_MAX_BYTES} bytes)`,
      });
    }

    const { csv } = req.body as { csv?: string };

    if (!csv || typeof csv !== "string" || !csv.trim()) {
      return void res.status(400).json({ error: "Missing or empty csv field" });
    }

    if (csv.length > UPLOAD_MAX_CSV_CHARS) {
      return void res.status(413).json({
        error: `CSV payload too large (limit ${UPLOAD_MAX_CSV_CHARS} characters)`,
      });
    }

    const rows = parseCsv(csv);
    if (!rows) {
      return void res.status(400).json({
        error: "Malformed CSV: must have a header row with at least Vendor and Catalog columns",
      });
    }
    if (rows.length === 0) {
      return void res.status(400).json({ error: "CSV contains no valid data rows" });
    }

    const pairs = rows.map(r => ({
      vendor: r.vendor.toUpperCase(),
      catalog: r.catalog,
    }));

    const existingRows = await db
      .select({
        vendor: inventoryTable.vendor,
        catalog: inventoryTable.catalog,
        binLocations: inventoryTable.binLocations,
        barcodes: inventoryTable.barcodes,
      })
      .from(inventoryTable)
      .where(
        or(
          ...pairs.map(p =>
            and(eq(inventoryTable.vendor, p.vendor), eq(inventoryTable.catalog, p.catalog)),
          ),
        ),
      );

    const existingMap = new Map<string, Array<string>>();
    const existingBarcodesMap = new Map<string, Array<string>>();
    for (const row of existingRows) {
      existingMap.set(`${row.vendor}\0${row.catalog}`, row.binLocations);
      existingBarcodesMap.set(`${row.vendor}\0${row.catalog}`, row.barcodes ?? []);
    }

    type RowStatus = "replace" | "add" | "preserve" | "none";
    type BarcodeStatus = RowStatus | "conflict";

    interface BinDiffRow {
      vendor: string;
      catalog: string;
      status: RowStatus;
      existingBins: Array<string>;
      incomingBins: Array<string>;
      barcodeStatus: BarcodeStatus;
      existingBarcodes: Array<string>;
      conflictingItem?: { vendor: string; catalog: string };
    }

    const diffRows: Array<BinDiffRow> = [];
    let willReplaceBins = 0;
    let willAddBins = 0;
    let willPreserveBins = 0;
    let noChange = 0;
    let willReplaceBarcodes = 0;
    let willAddBarcodes = 0;
    let willPreserveBarcodes = 0;
    let willBarcodeConflicts = 0;

    // ── Cross-item barcode conflict detection ─────────────────────────────────
    // Collect every non-empty barcode that appears in the incoming CSV.
    const allIncomingBarcodes = [
      ...new Set(rows.flatMap(r => r.barcodes).filter(b => b.length > 0)),
    ];

    // Query the full inventory for any item whose barcodes array overlaps the
    // incoming set. We use "b = ANY(barcodes)" per barcode value so the query
    // is fully parameterized without raw string interpolation.
    //
    // We track ALL owners per barcode (not just the first) so that even if a
    // barcode is already duplicated across multiple DB items we can still find
    // a conflicting owner that differs from the current CSV row.
    const barcodeToItemMap = new Map<string, Array<{ vendor: string; catalog: string }>>();
    if (allIncomingBarcodes.length > 0) {
      const conflictRows = await db
        .select({
          vendor: inventoryTable.vendor,
          catalog: inventoryTable.catalog,
          barcodes: inventoryTable.barcodes,
        })
        .from(inventoryTable)
        .where(or(...allIncomingBarcodes.map(b => sql`${b} = ANY(${inventoryTable.barcodes})`)));

      for (const item of conflictRows) {
        for (const bc of item.barcodes ?? []) {
          const owners = barcodeToItemMap.get(bc);
          if (owners) {
            owners.push({ vendor: item.vendor, catalog: item.catalog });
          } else {
            barcodeToItemMap.set(bc, [{ vendor: item.vendor, catalog: item.catalog }]);
          }
        }
      }
    }

    for (const row of rows) {
      const key = `${row.vendor.toUpperCase()}\0${row.catalog}`;
      const existingBins = existingMap.get(key) ?? [];
      const incomingBins = row.binLocations;
      const hasIncoming = incomingBins.length > 0;
      const hasExisting = existingBins.length > 0;

      const binsIdentical =
        hasIncoming &&
        hasExisting &&
        incomingBins.length === existingBins.length &&
        [...incomingBins].sort().join("\0") === [...existingBins].sort().join("\0");

      let status: RowStatus;
      if (hasIncoming && hasExisting && !binsIdentical) {
        status = "replace";
        willReplaceBins++;
      } else if (hasIncoming && !hasExisting) {
        status = "add";
        willAddBins++;
      } else if (!hasIncoming && hasExisting) {
        status = "preserve";
        willPreserveBins++;
      } else {
        status = "none";
        noChange++;
      }

      // ── Barcode diff ────────────────────────────────────────────────────────
      const existingBarcodes = existingBarcodesMap.get(key) ?? [];
      const incomingBarcodes = row.barcodes;
      const hasIncomingBarcodes = incomingBarcodes.length > 0;
      const hasExistingBarcodes = existingBarcodes.length > 0;

      const barcodesIdentical =
        hasIncomingBarcodes &&
        hasExistingBarcodes &&
        incomingBarcodes.length === existingBarcodes.length &&
        [...incomingBarcodes].sort().join("\0") === [...existingBarcodes].sort().join("\0");

      let barcodeStatus: BarcodeStatus;
      let conflictingItem: { vendor: string; catalog: string } | undefined;

      // Check for cross-item conflict first — takes priority over replace/add.
      // We scan all owners per barcode (not just the first) so the check is
      // correct even when a barcode is already duplicated across DB items.
      if (hasIncomingBarcodes) {
        outer: for (const bc of incomingBarcodes) {
          const owners = barcodeToItemMap.get(bc);
          if (owners) {
            for (const owner of owners) {
              const ownerKey = `${owner.vendor.toUpperCase()}\0${owner.catalog}`;
              if (ownerKey !== key) {
                // A different item already owns this barcode.
                barcodeStatus = "conflict";
                conflictingItem = owner;
                willBarcodeConflicts++;
                break outer;
              }
            }
          }
        }
      }

      if (!conflictingItem) {
        if (hasIncomingBarcodes && hasExistingBarcodes && !barcodesIdentical) {
          barcodeStatus = "replace";
          willReplaceBarcodes++;
        } else if (hasIncomingBarcodes && !hasExistingBarcodes) {
          barcodeStatus = "add";
          willAddBarcodes++;
        } else if (!hasIncomingBarcodes && hasExistingBarcodes) {
          barcodeStatus = "preserve";
          willPreserveBarcodes++;
        } else {
          barcodeStatus = "none";
        }
      }

      diffRows.push({ vendor: row.vendor, catalog: row.catalog, status, existingBins, incomingBins, barcodeStatus: barcodeStatus!, existingBarcodes, ...(conflictingItem !== undefined ? { conflictingItem } : {}) });
    }

    res.json({ willReplaceBins, willAddBins, willPreserveBins, noChange, rows: diffRows, willReplaceBarcodes, willAddBarcodes, willPreserveBarcodes, willBarcodeConflicts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Preview failed" });
  }
});

// ── POST /admin/upload ────────────────────────────────────────────────────────
router.post("/upload", requireAdminAuth, async (req, res) => {
  try {
    const contentLength = Number(req.headers["content-length"] ?? 0);
    if (contentLength > UPLOAD_MAX_BYTES) {
      return void res.status(413).json({
        error: `Request body too large (limit ${UPLOAD_MAX_BYTES} bytes)`,
      });
    }

    const { csv } = req.body as { csv?: string };

    if (!csv || typeof csv !== "string" || !csv.trim()) {
      return void res.status(400).json({ error: "Missing or empty csv field" });
    }

    if (csv.length > UPLOAD_MAX_CSV_CHARS) {
      return void res.status(413).json({
        error: `CSV payload too large (limit ${UPLOAD_MAX_CSV_CHARS} characters)`,
      });
    }

    const rows = parseCsv(csv);
    if (!rows) {
      return void res.status(400).json({
        error: "Malformed CSV: must have a header row with at least Vendor and Catalog columns",
      });
    }
    if (rows.length === 0) {
      return void res.status(400).json({ error: "CSV contains no valid data rows" });
    }

    let inserted = 0;
    let updated = 0;

    // Wrap the entire upsert loop in a transaction so a mid-loop failure rolls
    // back all previously committed rows — enforcing all-or-nothing semantics.
    await db.transaction(async (tx) => {
      for (const row of rows) {
        // Atomic upsert via the (vendor, catalog) unique index. Mirrors the seed
        // importer pattern so concurrent uploads of the same key can't race on
        // the unique constraint.
        const result = await tx
          .insert(inventoryTable)
          .values({
            vendor: row.vendor.toUpperCase(),
            catalog: row.catalog,
            description: row.description,
            binLocations: row.binLocations,
            barcodes: row.barcodes,
            aiKeywords: [],
          })
          .onConflictDoUpdate({
            target: [inventoryTable.vendor, inventoryTable.catalog],
            set: {
              description: sql`CASE WHEN length(EXCLUDED.description) > 0 THEN EXCLUDED.description ELSE ${inventoryTable.description} END`,
              // Preserve existing bins when no bin data is supplied — guards
              // multi-bin assignments during partial re-uploads (Task #455).
              binLocations: sql`CASE WHEN coalesce(array_length(EXCLUDED.bin_locations, 1), 0) > 0 THEN EXCLUDED.bin_locations ELSE ${inventoryTable.binLocations} END`,
              // Preserve existing barcodes when no barcode data is supplied — same
              // semantics as binLocations so manual scan assignments survive re-uploads.
              barcodes: sql`CASE WHEN coalesce(array_length(EXCLUDED.barcodes, 1), 0) > 0 THEN EXCLUDED.barcodes ELSE ${inventoryTable.barcodes} END`,
              updatedAt: sql`now()`,
            },
          })
          .returning({ isNew: sql<boolean>`(xmax = 0)` });

        if (result[0]?.isNew) inserted++;
        else updated++;
      }
    });

    invalidateReferenceAnswerCache().catch(() => {});

    // Refresh planner statistics after a bulk import so inventory_fts_idx
    // remains the chosen scan plan even when reltuples was stale before import.
    // Fire-and-forget: ANALYZE can take a few seconds on large tables and must
    // not block the HTTP response.
    db.execute(sql`ANALYZE inventory`).catch((err) => {
      console.warn("[adminUpload] ANALYZE inventory failed:", err);
    });

    res.json({ inserted, updated, total: rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload failed" });
  }
});

export default router;
