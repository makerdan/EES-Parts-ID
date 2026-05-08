/**
 * One-shot backfill that adds trade-size keyword tokens to every conduit /
 * pipe inventory row so the "Trade Size" filter chip and free-text search
 * can match them.
 *
 * Idempotent: tokens already present in `aiKeywords` are not duplicated,
 * and rows where no token can be derived are skipped silently.
 *
 * Usage (from workspace root):
 *   DATABASE_URL="$DATABASE_URL" \
 *   pnpm --filter @workspace/api-server exec tsx src/seed/backfill-trade-size.ts
 */
import { db, pool } from '@workspace/db';
import { inventoryTable } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { deriveTradeSizeTokens } from '../utils/tradeSize';

async function backfill() {
  const rows = await db
    .select({
      id: inventoryTable.id,
      vendor: inventoryTable.vendor,
      catalog: inventoryTable.catalog,
      description: inventoryTable.description,
      aiKeywords: inventoryTable.aiKeywords,
    })
    .from(inventoryTable);

  console.log(`Scanning ${rows.length} inventory rows…`);

  let touched = 0;
  let skipped = 0;
  let unchanged = 0;

  for (const row of rows) {
    const tokens = deriveTradeSizeTokens({
      vendor: row.vendor,
      catalog: row.catalog,
      description: row.description,
    });
    if (tokens.length === 0) {
      skipped++;
      continue;
    }
    const existing = new Set((row.aiKeywords ?? []).map((k) => k.toLowerCase()));
    const additions = tokens.filter((t) => !existing.has(t.toLowerCase()));
    if (additions.length === 0) {
      unchanged++;
      continue;
    }
    const merged = [...(row.aiKeywords ?? []), ...additions];
    await db
      .update(inventoryTable)
      .set({ aiKeywords: merged, updatedAt: new Date() })
      .where(eq(inventoryTable.id, row.id));
    touched++;
    if (touched % 50 === 0) console.log(`  …${touched} updated so far`);
  }

  console.log(`\n=== Trade-size backfill complete ===`);
  console.log(`Updated  : ${touched}  (rows with new tokens added)`);
  console.log(`Already  : ${unchanged}  (rows that already had every token)`);
  console.log(`Skipped  : ${skipped}  (non-conduit / no parseable size)`);

  await pool.end();
}

backfill().catch((err) => {
  console.error('Trade-size backfill failed:', err);
  process.exit(1);
});
