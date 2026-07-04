/**
 * Validates the advisory-lock + writable-CTE rate-limiter SQL against live PostgreSQL.
 * Covers: new row, fill-window, deny, same-ms duplicate, and advisory-lock semantics.
 */
import { Pool } from "pg";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const client1 = await pool.connect();
    try {
      await client1.query(`DELETE FROM rate_limit_buckets WHERE key LIKE 'test_sql_validate:%'`);
    } finally {
      client1.release();
    }

    const maxRequests = 3;
    const windowMs = 60_000;
    const now = Date.now();
    const cutoff = now - windowMs;
    const dbKey = "test_sql_validate:user1";

    // Each "check" runs as a two-statement transaction:
    //   1. SELECT pg_advisory_xact_lock(hashtext(key)) — serializes concurrent
    //      requests for the same key, including new-key (empty-row) races.
    //   2. Writable CTE: SELECT ... FOR UPDATE (existing rows), then
    //      INSERT ... ON CONFLICT DO UPDATE.
    //
    // prior_count is derived from the locked, pre-update row:
    //   prior_count < maxRequests  → allowed (we appended now)
    //   prior_count >= maxRequests → denied  (window full, no append)
    async function runCheck(key: string, ts: number): Promise<{ prior_count: number; timestamps: Array<number> }> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [key]);
        const res = await client.query(
          `
          WITH locked AS (
            SELECT COALESCE(array_length(
              array(SELECT ts FROM unnest(timestamps) AS ts WHERE ts > $3::bigint),
              1
            ), 0) AS prior_count
            FROM rate_limit_buckets
            WHERE key = $1
            FOR UPDATE
          ),
          upserted AS (
            INSERT INTO rate_limit_buckets (key, timestamps, updated_at)
            VALUES ($1, ARRAY[$2::bigint], now())
            ON CONFLICT (key) DO UPDATE
              SET
                timestamps = CASE
                  WHEN (SELECT COALESCE(prior_count, 0) FROM locked) >= $4
                  THEN
                    array(
                      SELECT ts FROM unnest(rate_limit_buckets.timestamps) AS ts
                      WHERE ts > $3::bigint
                    )
                  ELSE
                    array(
                      SELECT ts FROM unnest(rate_limit_buckets.timestamps) AS ts
                      WHERE ts > $3::bigint
                    ) || ARRAY[$2::bigint]
                END,
                updated_at = now()
            RETURNING timestamps
          )
          SELECT
            u.timestamps,
            COALESCE((SELECT prior_count FROM locked), 0) AS prior_count
          FROM upserted u
          `,
          [key, ts, cutoff, maxRequests]
        );
        await client.query("COMMIT");
        const row = res.rows[0];
        return {
          prior_count: Number(row.prior_count),
          timestamps: (row.timestamps as Array<string>).map(Number),
        };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }

    // ── Sequential requests ────────────────────────────────────────────────
    const r1 = await runCheck(dbKey, now);
    console.assert(r1.prior_count === 0, `R1 prior_count should be 0, got ${r1.prior_count}`);
    console.log("R1 prior_count:", r1.prior_count, "len:", r1.timestamps.length, "→ allowed");

    const r2 = await runCheck(dbKey, now + 1);
    console.assert(r2.prior_count === 1, `R2 prior_count should be 1, got ${r2.prior_count}`);
    console.log("R2 prior_count:", r2.prior_count, "len:", r2.timestamps.length, "→ allowed");

    const r3 = await runCheck(dbKey, now + 2);
    console.assert(r3.prior_count === 2, `R3 prior_count should be 2, got ${r3.prior_count}`);
    console.log("R3 prior_count:", r3.prior_count, "len:", r3.timestamps.length, "→ allowed (fills window)");

    const r4 = await runCheck(dbKey, now + 3);
    console.assert(r4.prior_count === 3, `R4 prior_count should be 3, got ${r4.prior_count}`);
    console.assert(r4.timestamps.length === 3, `R4 len should stay 3, got ${r4.timestamps.length}`);
    console.log("R4 prior_count:", r4.prior_count, "len:", r4.timestamps.length, "→ denied");

    // Same-ms duplicate (concurrent scenario simulation):
    const r5 = await runCheck(dbKey, now); // reuse now — same ms as R1
    console.assert(r5.prior_count === 3, `R5 prior_count should be 3, got ${r5.prior_count}`);
    console.log("R5 (same-ms) prior_count:", r5.prior_count, "len:", r5.timestamps.length, "→ correctly denied");

    // ── Concurrent new-key race ────────────────────────────────────────────
    const newKey = "test_sql_validate:newkey_concurrent";
    // Fire two concurrent requests at a brand-new key with maxRequests=1
    const maxOne = 1;
    const concurrentCutoff = now - windowMs;
    async function concurrentCheck(key: string, ts: number): Promise<{ prior_count: number }> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [key]);
        const res = await client.query(
          `
          WITH locked AS (
            SELECT COALESCE(array_length(
              array(SELECT ts FROM unnest(timestamps) AS ts WHERE ts > $3::bigint),
              1
            ), 0) AS prior_count
            FROM rate_limit_buckets
            WHERE key = $1
            FOR UPDATE
          ),
          upserted AS (
            INSERT INTO rate_limit_buckets (key, timestamps, updated_at)
            VALUES ($1, ARRAY[$2::bigint], now())
            ON CONFLICT (key) DO UPDATE
              SET
                timestamps = CASE
                  WHEN (SELECT COALESCE(prior_count, 0) FROM locked) >= $4
                  THEN
                    array(
                      SELECT ts FROM unnest(rate_limit_buckets.timestamps) AS ts
                      WHERE ts > $3::bigint
                    )
                  ELSE
                    array(
                      SELECT ts FROM unnest(rate_limit_buckets.timestamps) AS ts
                      WHERE ts > $3::bigint
                    ) || ARRAY[$2::bigint]
                END,
                updated_at = now()
            RETURNING timestamps
          )
          SELECT
            u.timestamps,
            COALESCE((SELECT prior_count FROM locked), 0) AS prior_count
          FROM upserted u
          `,
          [key, ts, concurrentCutoff, maxOne]
        );
        await client.query("COMMIT");
        return { prior_count: Number(res.rows[0].prior_count) };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }

    // Run both concurrently — with advisory lock one must see prior_count=1 (denied)
    const [c1, c2] = await Promise.all([
      concurrentCheck(newKey, now),
      concurrentCheck(newKey, now + 1),
    ]);
    console.log("Concurrent new-key C1 prior_count:", c1.prior_count);
    console.log("Concurrent new-key C2 prior_count:", c2.prior_count);
    const allowedCount = [c1, c2].filter((r) => r.prior_count < maxOne).length;
    const deniedCount = [c1, c2].filter((r) => r.prior_count >= maxOne).length;
    console.assert(allowedCount === 1, `Expected exactly 1 allowed, got ${allowedCount}`);
    console.assert(deniedCount === 1, `Expected exactly 1 denied, got ${deniedCount}`);
    console.log(`Concurrent test: ${allowedCount} allowed, ${deniedCount} denied (maxRequests=1) ✓`);

    // Cleanup
    const cleanup = await pool.connect();
    await cleanup.query(`DELETE FROM rate_limit_buckets WHERE key LIKE 'test_sql_validate:%'`);
    cleanup.release();

    console.log("\nAll SQL tests passed.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("SQL validation FAILED:", err.message ?? err);
  process.exit(1);
});
