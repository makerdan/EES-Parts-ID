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
 *
 * Response:
 *   200 { inserted: number, updated: number, total: number }
 *   400 { error: string }  — malformed CSV or missing required columns
 *   401                    — missing or invalid admin token
 */

import { Router } from "express";
import { sql } from "drizzle-orm";
import { db, inventoryTable } from "@workspace/db";
import { verifyAdminToken } from "./admin";

const router = Router();

// Reject uploads larger than this before doing any parsing or DB work. The
// global JSON parser is set to 25mb (for AI image payloads); CSV uploads
// shouldn't approach that.
const UPLOAD_MAX_BYTES = 15 * 1024 * 1024; // 15 MB
// Defense-in-depth cap on the parsed CSV string length itself.
const UPLOAD_MAX_CSV_CHARS = 15 * 1024 * 1024; // ~15M chars

// ── Admin auth middleware (same contract as inventory.ts) ─────────────────────
function requireAdminAuth(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction,
): void {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    res.status(503).json({ error: "Admin access is not configured. Set ADMIN_PASSWORD." });
    return;
  }
  const authHeader = req.headers["authorization"] ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token || !verifyAdminToken(token, adminPassword)) {
    res.status(401).json({ error: "Unauthorized: valid admin token required" });
    return;
  }
  next();
}

// ── CSV parser ────────────────────────────────────────────────────────────────

/** Split a single CSV line into fields, respecting double-quoted fields. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
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

interface ParsedRow {
  vendor: string;
  catalog: string;
  description: string;
  binLocations: string[];
}

/**
 * Parse a raw CSV string into structured inventory rows.
 * Returns null if the CSV is malformed (no header, or missing required columns).
 */
function parseCsv(csvText: string): ParsedRow[] | null {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return null; // header-only or empty

  const header = parseCsvLine(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, ""));
  const vendorIdx = header.findIndex(h => h === "vendor");
  const catalogIdx = header.findIndex(h => h === "catalog" || h === "catalog#" || h === "catalognumber");
  if (vendorIdx === -1 || catalogIdx === -1) return null;

  const descIdx = header.findIndex(h => h === "description");
  const binIdx = header.findIndex(h => h === "binlocation" || h === "bin" || h === "binnumber");

  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const vendor = fields[vendorIdx]?.trim() ?? "";
    const catalog = fields[catalogIdx]?.trim() ?? "";
    if (!vendor || !catalog) continue; // skip blank/invalid rows
    const binCell = (binIdx >= 0 ? fields[binIdx]?.trim() : "") ?? "";
    // CSV may pack multiple bins separated by ; or | — split, trim, drop blanks
    const binLocations = binCell
      ? binCell.split(/[;|]/).map(b => b.trim()).filter(b => b.length > 0)
      : [];
    rows.push({
      vendor,
      catalog,
      description: (descIdx >= 0 ? fields[descIdx]?.trim() : "") ?? "",
      binLocations,
    });
  }
  return rows;
}

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

    for (const row of rows) {
      // Atomic upsert via the (vendor, catalog) unique index. Mirrors the seed
      // importer pattern so concurrent uploads of the same key can't race on
      // the unique constraint.
      const result = await db
        .insert(inventoryTable)
        .values({
          vendor: row.vendor.toUpperCase(),
          catalog: row.catalog,
          description: row.description,
          binLocations: row.binLocations,
          aiKeywords: [],
        })
        .onConflictDoUpdate({
          target: [inventoryTable.vendor, inventoryTable.catalog],
          set: {
            description: sql`CASE WHEN length(EXCLUDED.description) > 0 THEN EXCLUDED.description ELSE ${inventoryTable.description} END`,
            // Preserve existing bins when no bin data is supplied — guards
            // multi-bin assignments during partial re-uploads (Task #455).
            binLocations: sql`CASE WHEN coalesce(array_length(EXCLUDED.bin_locations, 1), 0) > 0 THEN EXCLUDED.bin_locations ELSE ${inventoryTable.binLocations} END`,
            updatedAt: sql`now()`,
          },
        })
        .returning({ isNew: sql<boolean>`(xmax = 0)` });

      if (result[0]?.isNew) inserted++;
      else updated++;
    }

    res.json({ inserted, updated, total: rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload failed" });
  }
});

export default router;
