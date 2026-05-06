/**
 * Backfill script — populates `inventory.search_tokens` for every row
 * where the column is NULL (i.e. has not been processed since migration
 * 0011_synonym_tokens was applied).
 *
 * The script:
 *   1. Loads all synonym_group rows once (small table, fits in RAM).
 *   2. Iterates inventory in batches and calls buildSearchTokens() for
 *      each row.
 *   3. Updates search_tokens in place.
 *
 * Idempotent — re-running is a no-op for rows that already have a value
 * (unless FORCE=1 is set, which re-computes every row).
 *
 * Usage (from workspace root):
 *   DATABASE_URL="$DATABASE_URL" \
 *   pnpm --filter @workspace/api-server exec tsx src/seed/backfill_search_tokens.ts
 *
 * Options (env vars):
 *   BACKFILL_BATCH_SIZE  – rows per wave  (default: 500)
 *   BACKFILL_DELAY_MS    – ms between waves (default: 0)
 *   FORCE                – set to "1" to recompute all rows (default: 0)
 */

import { db, pool } from "@workspace/db";
import { inventoryTable, synonymGroupTable } from "@workspace/db";
import { sql, eq } from "drizzle-orm";
import { buildSearchTokens } from "../enrichment/buildSearchTokens";

const BATCH_SIZE = parseInt(process.env["BACKFILL_BATCH_SIZE"] ?? "500", 10);
const DELAY_MS = parseInt(process.env["BACKFILL_DELAY_MS"] ?? "0", 10);
const FORCE = process.env["FORCE"] === "1";

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function backfillSearchTokens() {
  // Load synonym groups once — they fit in RAM and change infrequently.
  console.log("Loading synonym_group table…");
  const synonymGroups = await db
    .select({
      canonical: synonymGroupTable.canonical,
      synonyms: synonymGroupTable.synonyms,
    })
    .from(synonymGroupTable);
  console.log(`  ${synonymGroups.length} synonym groups loaded.`);

  const needsBackfill = FORCE
    ? sql`TRUE`
    : sql`${inventoryTable.searchTokens} IS NULL`;

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(inventoryTable)
    .where(needsBackfill);

  console.log(
    `\nRows needing search_tokens backfill: ${total}` +
    (FORCE ? " (FORCE mode — recomputing all)" : ""),
  );
  console.log(`Batch size: ${BATCH_SIZE}\n`);

  if (total === 0) {
    console.log("Nothing to do – all rows already have search_tokens.");
    await pool.end();
    return;
  }

  let processed = 0;
  let errors = 0;
  const startTime = Date.now();

  while (true) {
    const batch = await db
      .select({
        id: inventoryTable.id,
        catalog: inventoryTable.catalog,
        description: inventoryTable.description,
        vendor: inventoryTable.vendor,
        aiKeywords: inventoryTable.aiKeywords,
      })
      .from(inventoryTable)
      .where(needsBackfill)
      .limit(BATCH_SIZE);

    if (batch.length === 0) break;

    for (const item of batch) {
      try {
        const tokens = buildSearchTokens(item, synonymGroups);
        await db
          .update(inventoryTable)
          .set({ searchTokens: tokens })
          .where(eq(inventoryTable.id, item.id));
        processed++;
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

    if (batch.length < BATCH_SIZE) break;

    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== search_tokens Backfill Complete ===`);
  console.log(`Processed : ${processed}`);
  console.log(`Errors    : ${errors}  (re-run script to retry failures)`);
  console.log(`Time      : ${elapsed}s`);

  // Quick coverage check
  const coverageResult = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE search_tokens IS NOT NULL)::int AS has_tokens,
      count(*) FILTER (WHERE search_tokens IS NULL)::int     AS missing_tokens,
      count(*)::int                                          AS total
    FROM inventory
  `);
  const c = ((coverageResult as { rows: unknown[] }).rows[0] ?? {}) as Record<string, number>;
  console.log(`\nCoverage:`);
  console.log(`  has search_tokens : ${c["has_tokens"]}/${c["total"]}`);
  console.log(`  missing           : ${c["missing_tokens"]}`);

  await pool.end();
}

backfillSearchTokens().catch((err) => {
  console.error("search_tokens backfill failed:", err);
  process.exit(1);
});
