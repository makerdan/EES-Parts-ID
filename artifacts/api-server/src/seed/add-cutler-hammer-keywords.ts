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

  // Run the update
  const result = await db.execute(sql`
    UPDATE inventory
    SET ai_keywords = array_append(ai_keywords, 'Cutler-Hammer')
    WHERE catalog LIKE 'BAB%'
      AND NOT ('Cutler-Hammer' = ANY(ai_keywords))
  `);

  console.log(`Updated ${result.rowCount} rows.`);

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

  console.log('Verification passed — all BAB rows now contain "Cutler-Hammer".');

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
