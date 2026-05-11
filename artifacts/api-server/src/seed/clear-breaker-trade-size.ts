/**
 * One-shot migration: clear stale trade_size / trade_size_in values from
 * circuit-breaker inventory rows.
 *
 * Background: before Task #410, the trade-size parser mis-read the
 * amp/pole digits in breaker catalog numbers as conduit trade sizes
 * (e.g. "BR120" → trade_size="1/2 inch", trade_size_in=0.5). This
 * migration nulls those fields for rows that meet ALL of:
 *   (a) trade_size currently matches an amperage pattern (^\d+\s*[Aa]) —
 *       i.e. the stored value looks like "20A", "100 A", etc., not a real
 *       conduit trade size like '1/2"'.
 *   (b) the amperage column is already populated (so we are not discarding
 *       the only copy of the value).
 *   (c) the row is classified as a Breaker category OR its catalog matches
 *       the known breaker catalog regex — so we do not touch non-breaker rows
 *       that happen to have numeric trade_size strings.
 *
 * Idempotent — rows already null are skipped by the WHERE clause.
 *
 * Usage (from workspace root):
 *   DATABASE_URL="$DATABASE_URL" \
 *   pnpm --filter @workspace/api-server exec tsx src/seed/clear-breaker-trade-size.ts
 */
import { db, pool } from '@workspace/db';
import { inventoryTable, inventoryCategoryTable, categoryNodeTable } from '@workspace/db';
import { isNotNull, inArray, sql } from 'drizzle-orm';
import { isBreakerCatalog } from '../enrichment/parseAttributes';

async function clearBreakerTradeSize() {
  // Pull rows where trade_size looks like an amperage string (e.g. "20A",
  // "100 A") AND the amperage column already holds the parsed value.
  // This is the narrowest safe predicate: we only clear data that is
  // already captured elsewhere.
  const rows = await db
    .select({
      id: inventoryTable.id,
      catalog: inventoryTable.catalog,
      tradeSize: inventoryTable.tradeSize,
    })
    .from(inventoryTable)
    .where(
      sql`${inventoryTable.tradeSize} ~ E'^\\d+\\s*[Aa]'
          AND ${inventoryTable.amperage} IS NOT NULL`
    );

  console.log(`Found ${rows.length} rows with amperage-pattern trade_size and non-NULL amperage.`);

  if (rows.length === 0) {
    console.log('Nothing to do.');
    await pool.end();
    return;
  }

  // Also pull the set of inventory IDs already classified as Breaker (any node
  // whose top-level parent name is "Breaker", or node name is "Breaker").
  const breakerCategoryRows = await db
    .select({ inventoryId: inventoryCategoryTable.inventoryId })
    .from(inventoryCategoryTable)
    .innerJoin(
      categoryNodeTable,
      sql`${inventoryCategoryTable.categoryNodeId} = ${categoryNodeTable.id}`
    )
    .where(
      sql`${categoryNodeTable.name} ILIKE 'Breaker'
          OR EXISTS (
            SELECT 1 FROM category_node parent
            WHERE parent.id = ${categoryNodeTable.parentId}
            AND parent.name ILIKE 'Breaker'
          )
          OR EXISTS (
            SELECT 1 FROM category_node grandparent
            JOIN category_node sub ON sub.parent_id = grandparent.id
            WHERE sub.id = ${categoryNodeTable.parentId}
            AND grandparent.name ILIKE 'Breaker'
          )`
    );

  const breakerCategoryIds = new Set(breakerCategoryRows.map((r) => r.inventoryId));
  console.log(`Found ${breakerCategoryIds.size} items classified as Breaker category.`);

  // Only clear rows that are confirmed breakers (category or catalog regex).
  const toClear = rows
    .filter((row) => breakerCategoryIds.has(row.id) || isBreakerCatalog(row.catalog ?? ''))
    .map((row) => row.id);

  console.log(`Targeting ${toClear.length} breaker rows for trade_size cleanup.`);
  console.log(
    `  (Skipping ${rows.length - toClear.length} rows whose catalog did not match breaker detection.)`
  );

  if (toClear.length === 0) {
    console.log('Nothing to do — no matching breaker rows found.');
    await pool.end();
    return;
  }

  // Process in chunks of 500 to avoid hitting query parameter limits.
  const CHUNK = 500;
  let cleared = 0;
  for (let i = 0; i < toClear.length; i += CHUNK) {
    const chunk = toClear.slice(i, i + CHUNK);
    await db
      .update(inventoryTable)
      .set({ tradeSize: null, tradeSizeIn: null, updatedAt: new Date() })
      .where(inArray(inventoryTable.id, chunk));
    cleared += chunk.length;
    console.log(`  …${cleared}/${toClear.length} cleared`);
  }

  console.log(`\n=== Breaker trade-size migration complete ===`);
  console.log(`  Cleared: ${cleared} rows`);
  await pool.end();
}

clearBreakerTradeSize().catch((err) => {
  console.error(err);
  process.exit(1);
});
