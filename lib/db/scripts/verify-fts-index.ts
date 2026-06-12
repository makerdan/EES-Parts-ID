/**
 * Post-migration check: verify that inventory_fts_idx exists in the live
 * database, covers the expected columns, AND is actually chosen by the query
 * planner for a representative FTS query.
 *
 * Two phases:
 *   1. Schema check  — pg_indexes confirms the index exists with all expected
 *                      column fragments in its definition.
 *   2. Planner check — EXPLAIN ANALYZE on the same WHERE clause used by the
 *                      /search route confirms PostgreSQL uses inventory_fts_idx
 *                      rather than falling back to a sequential scan.
 *
 * Run with:
 *   pnpm --filter @workspace/db run verify-fts
 *
 * Exits 0 on success, 1 on failure.
 */

import pg from "pg";

const REQUIRED_FRAGMENTS = [
  "inventory_fts_idx",
  "to_tsvector",
  "vendor",
  "catalog",
  "description",
  "expanded_description",
  "immutable_array_to_string",
  "ai_keywords",
];

/**
 * The canonical FTS vector expression — must stay in sync with
 * inventoryFtsVector() in lib/db/src/schema/inventory.ts.
 */
const FTS_VECTOR_EXPR =
  `to_tsvector('english', ` +
  `coalesce(i.vendor,'') || ' ' || ` +
  `coalesce(i.catalog,'') || ' ' || ` +
  `coalesce(i.description,'') || ' ' || ` +
  `coalesce(i.expanded_description,'') || ' ' || ` +
  `immutable_array_to_string(i.ai_keywords,' '))`;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("ERROR: DATABASE_URL is not set.");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    // -------------------------------------------------------------------------
    // Phase 1: Schema check — does inventory_fts_idx exist with the right def?
    // -------------------------------------------------------------------------
    console.log("[verify-fts] Phase 1: checking index definition...");

    const indexResult = await client.query<{
      indexname: string;
      indexdef: string;
    }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename  = 'inventory'
         AND indexname  = 'inventory_fts_idx'`,
    );

    if (indexResult.rowCount === 0) {
      console.error(
        "FAIL: inventory_fts_idx does not exist in the database.\n" +
          "Run: drizzle-kit push  (or manually apply the CREATE INDEX from 0019_expanded_description.sql)",
      );
      process.exit(1);
    }

    const { indexdef } = indexResult.rows[0];
    const missing = REQUIRED_FRAGMENTS.filter((f) => !indexdef.includes(f));

    if (missing.length > 0) {
      console.error(
        `FAIL: inventory_fts_idx is missing expected fragments: ${missing.join(", ")}\n` +
          `Actual definition:\n${indexdef}`,
      );
      process.exit(1);
    }

    console.log(
      "OK: inventory_fts_idx exists and covers all expected columns.",
    );
    console.log(`    ${indexdef}`);

    // -------------------------------------------------------------------------
    // Phase 2: Planner check — does EXPLAIN ANALYZE show inventory_fts_idx?
    // -------------------------------------------------------------------------
    console.log("[verify-fts] Phase 2: checking query planner...");

    // How many rows are in the table?  PostgreSQL will always choose a seqscan
    // on an empty table regardless of statistics, so we skip the planner check
    // (with a warning) rather than producing a false failure.
    const countResult = await client.query<{ n: string }>(
      `SELECT reltuples::bigint AS n FROM pg_class WHERE relname = 'inventory'`,
    );
    const estimatedRows = parseInt(countResult.rows[0]?.n ?? "0", 10);

    if (estimatedRows < 1) {
      // Fall back to an exact count for freshly-loaded tables where reltuples
      // has not yet been updated by ANALYZE.
      const exactResult = await client.query<{ n: string }>(
        `SELECT COUNT(*)::int AS n FROM inventory`,
      );
      const exactRows = parseInt(exactResult.rows[0]?.n ?? "0", 10);

      if (exactRows === 0) {
        console.warn(
          "WARN: inventory table is empty — planner check skipped.\n" +
            "      PostgreSQL never uses a GIN index on an empty table; re-run\n" +
            "      after loading production data to confirm index use.",
        );
        console.log("[verify-fts] Done (schema OK, planner check skipped).");
        process.exit(0);
      }
    }

    // Run EXPLAIN ANALYZE with the same WHERE clause used by the /search route
    // (see artifacts/api-server/src/routes/inventory.ts, inventoryFtsVector('i')).
    // We use a literal search term that is very unlikely to match any row so the
    // query returns quickly; the planner decision is visible regardless of matches.
    const explainQuery = `
      EXPLAIN (ANALYZE, FORMAT TEXT, BUFFERS OFF)
      SELECT i.id
      FROM   inventory i
      WHERE  ${FTS_VECTOR_EXPR}
             @@ websearch_to_tsquery('english', 'xverifyftszz')
      LIMIT  1
    `;

    const explainResult = await client.query<{ "QUERY PLAN": string }>(
      explainQuery,
    );

    const planLines = explainResult.rows.map((r) => r["QUERY PLAN"]);
    const planText = planLines.join("\n");

    console.log("[verify-fts] Query plan:");
    planLines.forEach((line) => console.log("  " + line));

    // Match any scan node that references the index by name.
    // PostgreSQL emits one of:
    //   "Index Scan using inventory_fts_idx on …"
    //   "Bitmap Index Scan on inventory_fts_idx"
    const INDEX_SCAN_RE =
      /(?:Index Scan using|Bitmap Index Scan on)\s+inventory_fts_idx\b/;

    if (!INDEX_SCAN_RE.test(planText)) {
      // Before failing, verify the table actually has rows.  reltuples can be
      // stale-positive (reports rows when the table is truly empty), so an exact
      // COUNT is needed to rule out a false negative caused by the planner
      // trivially short-circuiting on an empty relation.
      const exactResult2 = await client.query<{ n: string }>(
        `SELECT COUNT(*)::int AS n FROM inventory`,
      );
      const exactRows2 = parseInt(exactResult2.rows[0]?.n ?? "0", 10);

      if (exactRows2 === 0) {
        console.warn(
          "WARN: inventory table is empty — planner used a seq scan, but\n" +
            "      that is expected for an empty relation. Treating as OK.\n" +
            "      Re-run after loading data to confirm index use.",
        );
        console.log("[verify-fts] Done (schema OK, planner check inconclusive).");
        process.exit(0);
      }

      console.error(
        "\nFAIL: inventory_fts_idx was NOT used by the query planner.\n" +
          "      The planner is performing a sequential scan instead.\n" +
          "      Likely causes:\n" +
          "        • Stale table statistics — run: ANALYZE inventory;\n" +
          "        • enable_seqscan forced on — check GUC settings.\n" +
          "        • Index was dropped or rebuilt under a different name.\n" +
          "      Run 'ANALYZE inventory;' and re-run this script.",
      );
      process.exit(1);
    }

    console.log(
      "\nOK: query planner uses inventory_fts_idx for the FTS WHERE clause.",
    );
    console.log("[verify-fts] Done.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
