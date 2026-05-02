/**
 * One-off cleanup script: strip junk values from ai_keywords arrays.
 *
 * Junk values (N/A, null, none, single-char strings, empty strings) occasionally
 * appear in ai_keywords after bulk enrichment. This script:
 *   1. Removes all junk keywords from every inventory row in a single SQL UPDATE.
 *   2. Clears enriched_at on any part left with fewer than 3 clean keywords,
 *      so the bulk enrichment job will re-enrich them on its next pass.
 *   3. Prints a summary of rows affected.
 *
 * Safe to re-run: idempotent — rows already clean are untouched.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run clean-keywords
 */

import pg from "pg";

const { Pool } = pg;

/**
 * Canonical junk values — must stay in sync with JUNK_KEYWORD_PATTERNS in
 * artifacts/api-server/src/utils/generateKeywords.ts which filters these at
 * generation time. If you add a value here, add it there too (and vice-versa).
 */
const JUNK_VALUES = [
  "n/a", "na", "n.a.", "n.a", "null", "none", "nil",
  "undefined", "unknown", "-", "--", "---", "true", "false",
];

// Build a SQL-safe literal list for the IN (...) clause
const junkLiteral = JUNK_VALUES.map((v) => `'${v}'`).join(", ");

// Condition that marks a single unnested keyword as junk
const IS_JUNK = `(
  trim(kw) = ''
  OR length(trim(kw)) <= 1
  OR lower(trim(kw)) IN (${junkLiteral})
)`;

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // ── Step 1: Remove junk keywords ────────────────────────────────────────
    console.log("Step 1: Cleaning junk keywords from ai_keywords arrays…");

    const cleanResult = await pool.query(`
      UPDATE inventory
      SET
        ai_keywords = COALESCE(
          (
            SELECT array_agg(kw)
            FROM unnest(ai_keywords) AS kw
            WHERE NOT ${IS_JUNK}
          ),
          ARRAY[]::text[]
        ),
        updated_at = now()
      WHERE EXISTS (
        SELECT 1 FROM unnest(ai_keywords) AS kw WHERE ${IS_JUNK}
      )
    `);

    console.log(`  → ${cleanResult.rowCount ?? 0} row(s) updated.`);

    // ── Step 2: Re-queue under-enriched parts ────────────────────────────────
    console.log("Step 2: Clearing enriched_at on parts with fewer than 3 keywords…");

    const requeueResult = await pool.query(`
      UPDATE inventory
      SET enriched_at = NULL, updated_at = now()
      WHERE
        enriched_at IS NOT NULL
        AND (array_length(ai_keywords, 1) IS NULL OR array_length(ai_keywords, 1) < 3)
    `);

    console.log(`  → ${requeueResult.rowCount ?? 0} part(s) re-queued for enrichment.`);

    // ── Step 3: Verification ─────────────────────────────────────────────────
    console.log("Step 3: Verifying — checking for any remaining junk values…");

    const checkResult = await pool.query<{ junk_count: string }>(`
      SELECT count(*) AS junk_count
      FROM inventory, unnest(ai_keywords) AS kw
      WHERE ${IS_JUNK}
    `);

    const remaining = parseInt(checkResult.rows[0]?.junk_count ?? "0", 10);
    if (remaining === 0) {
      console.log("  ✓ No junk values remain in any ai_keywords array.");
    } else {
      console.error(`  ✗ ${remaining} junk value(s) still found — recheck the filter logic.`);
      process.exit(1);
    }

    console.log("\nDone.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
