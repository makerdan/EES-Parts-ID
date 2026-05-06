/**
 * Backfill script — populates materialized attribute columns on inventory rows
 * that have never been parsed or were parsed under an older parser version.
 *
 * Usage (from workspace root):
 *   DATABASE_URL="$DATABASE_URL" \
 *   pnpm --filter @workspace/api-server exec tsx src/seed/backfill_attrs.ts
 *
 * Options (env vars):
 *   BACKFILL_BATCH_SIZE  – rows fetched per wave  (default: 500)
 *   BACKFILL_DELAY_MS    – ms to sleep between waves (default: 0)
 *
 * The script is fully idempotent:
 *   • Only rows where attrs_parsed_at IS NULL OR
 *     (catalog_parse->>'parser_version')::int < 2 are processed.
 *   • Re-running after a partial failure will pick up from where it left off.
 */

import { db, pool } from "@workspace/db";
import { inventoryTable } from "@workspace/db";
import { sql, eq } from "drizzle-orm";
import { deriveAttrs, parseTradeSize } from "../enrichment/parseAttributes";
import { CURRENT_PARSER_VERSION } from "../enrichment/invalidation";
import { parseTradeSizeInches, isConduitOrPipe } from "../utils/tradeSize";

const BATCH_SIZE = parseInt(process.env["BACKFILL_BATCH_SIZE"] ?? "500", 10);
const DELAY_MS = parseInt(process.env["BACKFILL_DELAY_MS"] ?? "0", 10);

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function backfillAttrs() {
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(inventoryTable)
    .where(
      sql`${inventoryTable.attrsParsedAt} IS NULL
          OR (${inventoryTable.catalogParse}->>'parser_version')::int < ${CURRENT_PARSER_VERSION}`,
    );

  console.log(`\nItems needing attribute backfill: ${total}`);
  console.log(`Batch size: ${BATCH_SIZE}\n`);

  if (total === 0) {
    console.log("Nothing to do – all items already at parser_version >= 2.");
    await pool.end();
    return;
  }

  let processed = 0;
  let errors = 0;
  let parsedAny = 0; // rows where at least one attribute column became non-null
  const startTime = Date.now();

  while (true) {
    const batch = await db
      .select({
        id: inventoryTable.id,
        catalog: inventoryTable.catalog,
        description: inventoryTable.description,
        vendor: inventoryTable.vendor,
      })
      .from(inventoryTable)
      .where(
        sql`${inventoryTable.attrsParsedAt} IS NULL
            OR (${inventoryTable.catalogParse}->>'parser_version')::int < ${CURRENT_PARSER_VERSION}`,
      )
      .limit(BATCH_SIZE);

    if (batch.length === 0) break;

    for (const item of batch) {
      try {
        const attrs = deriveAttrs(item);

        // Derive trade_size_in only for conduit/pipe items and guard against
        // bogus values: parseTradeSizeInches can fire on catalog digits that
        // happen to look like a fraction suffix (e.g. "200458" → 2004.625).
        // Real trade sizes are ≤ 6" in practice; we cap at 12" to be safe.
        const isConduit = isConduitOrPipe(item.catalog, item.vendor, item.description);
        // parseTradeSizeInches handles catalog-code encoded sizes (e.g. "EMT212" → 2.5).
        // parseTradeSize handles richer free-text in descriptions ("1/2 inch", "25mm", etc.).
        const tradeSizeInches = isConduit
          ? (parseTradeSizeInches(item.catalog)
             ?? parseTradeSize(item.description)
             ?? parseTradeSize(item.catalog))
          : null;
        const tradeSizeIn =
          tradeSizeInches !== null && tradeSizeInches <= 12
            ? tradeSizeInches.toFixed(3)
            : null;

        await db
          .update(inventoryTable)
          .set({
            catalogParse: attrs.catalogParse as Record<string, unknown> | null,
            amperage: attrs.amperage,
            poleCount: attrs.poleCount,
            voltage: attrs.voltage,
            mountType: attrs.mountType,
            tradeSizeIn,
            attrsParsedAt: attrs.attrsParsedAt,
          })
          .where(eq(inventoryTable.id, item.id));

        processed++;
        if (
          attrs.catalogParse !== null ||
          attrs.amperage !== null ||
          attrs.poleCount !== null ||
          attrs.voltage !== null ||
          attrs.mountType !== null ||
          tradeSizeIn !== null
        ) {
          parsedAny++;
        }
      } catch (err) {
        errors++;
        console.error(`  ✗ id=${item.id} (${item.vendor}/${item.catalog}):`, err);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const done = processed + errors;
    const rate = done > 0 ? Math.round((done / (Date.now() - startTime)) * 1000) : 0;
    console.log(
      `  [${elapsed}s] ${done}/${total}  ✓${processed} ✗${errors}  ~${rate}/s`,
    );

    if (batch.length < BATCH_SIZE) break; // last partial batch

    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== Attribute Backfill Complete ===`);
  console.log(`Processed : ${processed}`);
  console.log(`Errors    : ${errors}  (re-run script to retry failures)`);
  console.log(`With attrs: ${parsedAny}  (rows where at least one attribute column is non-null)`);
  console.log(`Time      : ${elapsed}s`);

  // Log non-null counts as a quick sanity check
  const coverageResult = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE catalog_parse IS NOT NULL)::int  AS has_catalog_parse,
      count(*) FILTER (WHERE amperage IS NOT NULL)::int       AS has_amperage,
      count(*) FILTER (WHERE pole_count IS NOT NULL)::int     AS has_pole_count,
      count(*) FILTER (WHERE voltage IS NOT NULL)::int        AS has_voltage,
      count(*) FILTER (WHERE trade_size_in IS NOT NULL)::int  AS has_trade_size_in,
      count(*)::int                                           AS total
    FROM inventory
  `);
  const c = ((coverageResult as { rows: unknown[] }).rows[0] ?? {}) as Record<string, number>;
  console.log(`\nColumn coverage (${c["total"]} total rows):`);
  console.log(`  catalog_parse  : ${c["has_catalog_parse"]}`);
  console.log(`  amperage       : ${c["has_amperage"]}`);
  console.log(`  pole_count     : ${c["has_pole_count"]}`);
  console.log(`  voltage        : ${c["has_voltage"]}`);
  console.log(`  trade_size_in  : ${c["has_trade_size_in"]}`);

  await pool.end();
}

backfillAttrs().catch((err) => {
  console.error("Attribute backfill failed:", err);
  process.exit(1);
});
