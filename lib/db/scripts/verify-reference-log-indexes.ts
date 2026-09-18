/**
 * Release check: confirm the PostgreSQL indexes required by protected
 * AI-log substring searches are present.
 *
 * This check intentionally queries catalog metadata only. It never reads
 * reference_log rows, prints index definitions, or echoes connection errors.
 *
 * Run with:
 *   pnpm --filter @workspace/db run verify-reference-log-indexes
 */

import pg from "pg";

const REQUIRED_INDEXES = [
  "reference_log_question_trgm_idx",
  "reference_log_answer_trgm_idx",
] as const;

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error(
      "FAIL: AI-log search index check could not run because DATABASE_URL is not set.",
    );
    process.exitCode = 1;
    return;
  }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

  try {
    await client.connect();
    const result = await client.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'reference_log'
         AND indexname = ANY($1::text[])
       ORDER BY indexname`,
      [REQUIRED_INDEXES],
    );

    const present = new Set(result.rows.map(({ indexname }) => indexname));
    const missing = REQUIRED_INDEXES.filter(
      (indexName) => !present.has(indexName),
    );

    if (missing.length > 0) {
      console.error(
        `FAIL: AI-log search indexes are missing: ${missing.join(", ")}.`,
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      "PASS: AI-log search indexes are present " +
        "(reference_log_question_trgm_idx, reference_log_answer_trgm_idx).",
    );
  } catch {
    console.error(
      "FAIL: AI-log search index check could not query database metadata.",
    );
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

await main();
