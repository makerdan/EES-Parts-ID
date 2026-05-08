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
 *   BinLocation / Bin   — optional; one cell may contain several bins
 *                         separated by `,` `;` `/` or newlines
 *
 * Multi-bin behavior:
 *   - Bins from a single cell are split on `,` `;` `/` `\n`.
 *   - Multiple rows for the same (vendor, catalog) accumulate their bins.
 *   - On upsert, new bins are MERGED ADDITIVELY into the part's existing list
 *     (case-insensitive de-dupe). Re-uploading a sheet never removes a bin.
 *
 * Existing-row update rules (kept in sync with /api/inventory/upsert-batch):
 *   - Vendor and Catalog text on existing rows is NEVER modified — they are
 *     the match key.
 *   - A blank/missing description cell NEVER overwrites a stored description
 *     (`row.description || existing.description` below preserves it).
 *
 * This route is the legacy server-side CSV importer; the mobile client uses
 * /api/inventory/upsert-batch which additionally supports a `mode` parameter
 * for the "ask before changing" review flow.
 *
 * Response:
 *   200 { inserted: number, updated: number, total: number }
 *   400 { error: string }  — malformed CSV or missing required columns
 *   401                    — missing or invalid admin token
 */

import { Router } from 'express';
import { and, sql } from 'drizzle-orm';
import { db, inventoryTable } from '@workspace/db';
import { verifyAdminToken } from './admin';
import { aggregateRowsByPart, mergeBins, type AggregatedRow } from '../utils/binLocations';
import { deriveTradeSizeTokens } from '../utils/tradeSize';
import { refreshSearchTokensForIds } from '../enrichment/refreshSearchTokens';

const router = Router();

// ── Admin auth middleware (same contract as inventory.ts) ─────────────────────
function requireAdminAuth(
  req: import('express').Request,
  res: import('express').Response,
  next: import('express').NextFunction
): void {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    res.status(503).json({ error: 'Admin access is not configured. Set ADMIN_PASSWORD.' });
    return;
  }
  const authHeader = req.headers['authorization'] ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token || !verifyAdminToken(token, adminPassword)) {
    res.status(401).json({ error: 'Unauthorized: valid admin token required' });
    return;
  }
  next();
}

// ── CSV parser ────────────────────────────────────────────────────────────────
//
// Tokenises a full CSV document into records, respecting quoted fields that
// span multiple physical lines. This matters for the multi-bin feature: a
// single bin cell may be quoted and contain newlines as bin separators, e.g.
//
//   VendorX,CAT-123,"A-1\nB-2\nC-3"
//
// The earlier line-by-line implementation split on `\r?\n` first and would
// silently drop everything after the first newline inside a quoted cell.

/**
 * Split a CSV document into records. Each record is an array of field strings.
 * Honours RFC-4180 quoting rules: `""` is an escaped quote, and a quoted field
 * may contain commas, `\r`, and `\n` literally.
 */
function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let current: string[] = [];
  let field = '';
  let inQuotes = false;

  const pushField = () => {
    current.push(field.trim());
    field = '';
  };
  const pushRecord = () => {
    pushField();
    // Skip blank lines (record with a single empty field).
    const isBlank = current.length === 1 && current[0] === '';
    if (!isBlank) records.push(current);
    current = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } // escaped ""
        else inQuotes = false;
      } else {
        field += ch; // newlines/commas literal inside quotes
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      pushField();
    } else if (ch === '\r') {
      // swallow; the \n that usually follows triggers the record boundary
    } else if (ch === '\n') {
      pushRecord();
    } else {
      field += ch;
    }
  }
  // Trailing record without a final newline.
  if (field.length > 0 || current.length > 0) pushRecord();
  return records;
}

/**
 * Raw row as it appears in the CSV — bin cell is kept un-split here and
 * deferred to `aggregateRowsByPart` so two rows for the same part also merge.
 */
interface RawCsvRow {
  vendor: string;
  catalog: string;
  description: string;
  binCell: string;
}

/**
 * Parse a raw CSV string into structured inventory rows. Returns `null` if
 * the CSV is malformed (no header, or missing required columns).
 */
function parseCsv(csvText: string): RawCsvRow[] | null {
  const records = parseCsvRecords(csvText);
  if (records.length < 2) return null; // header-only or empty

  const header = records[0]!.map((h) => h.toLowerCase().replace(/\s+/g, ''));
  const vendorIdx = header.findIndex((h) => h === 'vendor');
  const catalogIdx = header.findIndex(
    (h) => h === 'catalog' || h === 'catalog#' || h === 'catalognumber'
  );
  if (vendorIdx === -1 || catalogIdx === -1) return null;

  const descIdx = header.findIndex((h) => h === 'description');
  const binIdx = header.findIndex((h) => h === 'binlocation' || h === 'bin' || h === 'binnumber');

  const rows: RawCsvRow[] = [];
  for (let i = 1; i < records.length; i++) {
    const fields = records[i]!;
    const vendor = fields[vendorIdx]?.trim() ?? '';
    const catalog = fields[catalogIdx]?.trim() ?? '';
    if (!vendor || !catalog) continue; // skip blank/invalid rows
    rows.push({
      vendor,
      catalog,
      description: (descIdx >= 0 ? fields[descIdx]?.trim() : '') ?? '',
      // Keep the raw bin cell verbatim — splitting on `,` `;` `/` `\n` is
      // performed by aggregateRowsByPart so that newline separators inside
      // a quoted multi-line cell survive parsing.
      binCell: (binIdx >= 0 ? fields[binIdx] : '') ?? '',
    });
  }
  return rows;
}

// ── POST /admin/upload ────────────────────────────────────────────────────────
router.post('/upload', requireAdminAuth, async (req, res) => {
  try {
    const { csv } = req.body as { csv?: string };

    if (!csv || typeof csv !== 'string' || !csv.trim()) {
      return void res.status(400).json({ error: 'Missing or empty csv field' });
    }

    const rawRows = parseCsv(csv);
    if (!rawRows) {
      return void res.status(400).json({
        error: 'Malformed CSV: must have a header row with at least Vendor and Catalog columns',
      });
    }
    if (rawRows.length === 0) {
      return void res.status(400).json({ error: 'CSV contains no valid data rows' });
    }

    // Collapse repeated (vendor, catalog) rows and split bin cells on
    // separators so a part listed twice (or once with several bins) merges.
    const aggregated: AggregatedRow[] = aggregateRowsByPart(rawRows);

    let inserted = 0;
    let updated = 0;
    // Track every row touched so search_tokens (and trade-size keyword
    // variants) can be refreshed in one pass at the end of the upload.
    const touchedIds: number[] = [];

    for (const row of aggregated) {
      const existing = await db
        .select()
        .from(inventoryTable)
        .where(
          and(
            sql`UPPER(${inventoryTable.vendor}) = UPPER(${row.vendor})`,
            sql`UPPER(${inventoryTable.catalog}) = UPPER(${row.catalog})`
          )
        )
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(inventoryTable)
          .set({
            description: row.description || (existing[0]?.description ?? ''),
            binLocations: mergeBins(existing[0]!.binLocations, row.binLocations),
            updatedAt: new Date(),
          })
          .where(sql`${inventoryTable.id} = ${existing[0]!.id}`);
        touchedIds.push(existing[0]!.id);
        updated++;
      } else {
        const [insertedRow] = await db
          .insert(inventoryTable)
          .values({
            vendor: row.vendor.toUpperCase(),
            catalog: row.catalog,
            description: row.description,
            binLocations: row.binLocations,
            // Pre-seed conduit / pipe rows with trade-size tokens so the
            // Trade Size filter chip works without waiting for AI enrichment.
            aiKeywords: deriveTradeSizeTokens(row),
          })
          .returning({ id: inventoryTable.id });
        if (insertedRow) touchedIds.push(insertedRow.id);
        inserted++;
      }
    }

    // Keep the search index fresh so a worker searching immediately after
    // the upload finds the new/updated rows without waiting for an
    // enrichment pass or the rebuild-tokens backstop.
    await refreshSearchTokensForIds(touchedIds);

    res.json({ inserted, updated, total: aggregated.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

export default router;
