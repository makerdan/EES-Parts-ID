/**
 * One-off data migration: add "Cutler-Hammer" to ai_keywords for all BAB-series breakers.
 *
 * BAB-series circuit breakers are Eaton parts historically sold under the
 * Cutler-Hammer brand name.  Adding the keyword ensures users who search by
 * that brand name find them via the FTS index.
 *
 * Usage (from workspace root):
 *   DATABASE_URL="$DATABASE_URL" pnpm --filter @workspace/api-server exec tsx src/seed/add-cutler-hammer-keywords.ts
 *
 * Safe to re-run: the WHERE clause skips rows that already contain the keyword.
 */

import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";

async function addCutlerHammerKeywords() {
  console.log('Adding "Cutler-Hammer" keyword to BAB-series breakers...');

  // Count affected rows before update
  const beforeRes = await pool.query<{ total: string; already_has: string }>(`
    SELECT
      COUNT(*)                                                    AS total,
      COUNT(*) FILTER (WHERE 'Cutler-Hammer' = ANY(ai_keywords)) AS already_has
    FROM inventory
    WHERE catalog LIKE 'BAB%'
  `);
  const { total, already_has } = beforeRes.rows[0] ?? { total: "0", already_has: "0" };
  const toUpdate = parseInt(total, 10) - parseInt(already_has, 10);
  console.log(`BAB rows found: ${total}`);
  console.log(`Already have "Cutler-Hammer": ${already_has}`);
  console.log(`Will update: ${toUpdate}`);

  if (toUpdate === 0) {
    console.log('Nothing to do — all BAB rows already contain "Cutler-Hammer".');
    await pool.end();
    return;
  }

  // Run the update: add "Cutler-Hammer" to ai_keywords AND pin it in
  // pinned_keywords so that future re-enrichment jobs cannot remove it.
  // array_append is used for ai_keywords (idempotent via the WHERE guard);
  // for pinned_keywords we use array_append only when the keyword isn't
  // already present, preserving any previously pinned terms.
  const result = await db.execute(sql`
    UPDATE inventory
    SET
      ai_keywords     = array_append(ai_keywords, 'Cutler-Hammer'),
      pinned_keywords = CASE
        WHEN NOT ('Cutler-Hammer' = ANY(pinned_keywords))
          THEN array_append(pinned_keywords, 'Cutler-Hammer')
        ELSE pinned_keywords
      END
    WHERE catalog LIKE 'BAB%'
      AND NOT ('Cutler-Hammer' = ANY(ai_keywords))
  `);

  // Also pin on rows that already have the keyword in ai_keywords but not yet
  // in pinned_keywords (catches rows that existed before pinned_keywords was added).
  const pinResult = await db.execute(sql`
    UPDATE inventory
    SET pinned_keywords = array_append(pinned_keywords, 'Cutler-Hammer')
    WHERE catalog LIKE 'BAB%'
      AND 'Cutler-Hammer' = ANY(ai_keywords)
      AND NOT ('Cutler-Hammer' = ANY(pinned_keywords))
  `);

  console.log(`Updated ${result.rowCount} rows (added keyword).`);
  console.log(`Pinned on ${(result.rowCount ?? 0) + (pinResult.rowCount ?? 0)} rows total.`);

  // Verify
  const afterRes = await pool.query<{ missing: string }>(`
    SELECT COUNT(*) AS missing
    FROM inventory
    WHERE catalog LIKE 'BAB%'
      AND NOT ('Cutler-Hammer' = ANY(ai_keywords))
  `);
  const missing = parseInt(afterRes.rows[0]?.missing ?? "0", 10);
  if (missing > 0) {
    console.error(`ERROR: ${missing} BAB rows still missing "Cutler-Hammer" after update.`);
    process.exit(1);
  }

  // Verify pinned_keywords too
  const pinnedRes = await pool.query<{ not_pinned: string }>(`
    SELECT COUNT(*) AS not_pinned
    FROM inventory
    WHERE catalog LIKE 'BAB%'
      AND NOT ('Cutler-Hammer' = ANY(pinned_keywords))
  `);
  const notPinned = parseInt(pinnedRes.rows[0]?.not_pinned ?? "0", 10);
  if (notPinned > 0) {
    console.error(`ERROR: ${notPinned} BAB rows still missing "Cutler-Hammer" from pinned_keywords.`);
    process.exit(1);
  }

  console.log('Verification passed — all BAB rows now contain "Cutler-Hammer" in both ai_keywords and pinned_keywords.');

  // Refresh planner stats so FTS index stays efficient
  console.log("Running ANALYZE inventory...");
  await db.execute(sql`ANALYZE inventory`);
  console.log("ANALYZE complete.");

  await pool.end();
}

addCutlerHammerKeywords().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
