/**
 * One-shot migration: clear stale trade_size / trade_size_in values from
 * circuit-breaker inventory rows.
 *
 * Background: before Task #410, the trade-size parser mis-read the
 * amp/pole digits in breaker catalog numbers as conduit trade sizes
 * (e.g. "BR120" → trade_size="1/2 inch", trade_size_in=0.5). This
 * migration nulls those fields for every row that:
 *   (a) has its category set to "Breaker" in the inventory_category table, OR
 *   (b) whose catalog matches the known breaker catalog regex.
 *
 * The two conditions are combined so the migration covers rows regardless
 * of whether they have been through classification yet.
 *
 * Idempotent — running it multiple times is safe; rows that already have
 * NULL trade_size are untouched by the update condition.
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
  // Fetch all rows with a non-NULL trade_size — the full set we need to inspect.
  const rows = await db
    .select({
      id: inventoryTable.id,
      catalog: inventoryTable.catalog,
    })
    .from(inventoryTable)
    .where(isNotNull(inventoryTable.tradeSize));

  console.log(`Found ${rows.length} rows with non-NULL trade_size.`);

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

  // Collect IDs to clear: items in the breaker category OR matching the catalog regex.
  const toClear = rows
    .filter((row) => breakerCategoryIds.has(row.id) || isBreakerCatalog(row.catalog ?? ''))
    .map((row) => row.id);

  console.log(`Targeting ${toClear.length} breaker rows for trade_size cleanup.`);

  if (toClear.length === 0) {
    console.log('Nothing to do — no breaker rows with non-NULL trade_size found.');
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
