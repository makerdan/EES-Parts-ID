/**
 * Post-migration check: verify that inventory_fts_idx exists in the live
 * database and covers the expected columns (vendor, catalog, description,
 * expanded_description, ai_keywords via immutable_array_to_string).
 *
 * Run with:
 *   npx tsx lib/db/scripts/verify-fts-index.ts
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

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("ERROR: DATABASE_URL is not set.");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    const result = await client.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename  = 'inventory'
         AND indexname  = 'inventory_fts_idx'`,
    );

    if (result.rowCount === 0) {
      console.error(
        "FAIL: inventory_fts_idx does not exist in the database.\n" +
          "Run: drizzle-kit push  (or manually apply the CREATE INDEX from 0019_expanded_description.sql)",
      );
      process.exit(1);
    }

    const { indexdef } = result.rows[0];
    const missing = REQUIRED_FRAGMENTS.filter((f) => !indexdef.includes(f));

    if (missing.length > 0) {
      console.error(
        `FAIL: inventory_fts_idx is missing expected fragments: ${missing.join(", ")}\n` +
          `Actual definition:\n${indexdef}`,
      );
      process.exit(1);
    }

    console.log("OK: inventory_fts_idx exists and covers all expected columns.");
    console.log(`    ${indexdef}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
