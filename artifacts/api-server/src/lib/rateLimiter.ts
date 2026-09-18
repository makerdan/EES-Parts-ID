/**
 * PostgreSQL-backed sliding-window rate limiter.
 *
 * Keyed on an arbitrary string (Clerk userId for app users, IP for admin
 * requests).  Each limiter instance tracks a separate namespace so that
 * identify/translate-query/part-card limits are fully independent.
 *
 * State is stored in the `rate_limit_buckets` table so windows survive server
 * restarts and are consistent across multiple instances. An opportunistic
 * 1-in-100 cleanup pass deletes fully-expired rows to keep the table bounded.
 *
 * Concurrency model:
 *   Each check() runs in an explicit transaction containing two statements:
 *   1. `SELECT pg_advisory_xact_lock(hashtext(key))` — transaction-level
 *      advisory lock that serializes all concurrent requests for the same key,
 *      including the new-key (empty-row) case where SELECT FOR UPDATE cannot
 *      help.  The lock is released automatically on COMMIT/ROLLBACK.
 *   2. Writable CTE: SELECT FOR UPDATE on the existing row (defense in depth
 *      against advisory lock hash collisions) then INSERT ON CONFLICT DO UPDATE.
 *      `prior_count` is derived from the locked, pre-update row and returned
 *      alongside `timestamps` so the allow/deny decision is deterministic.
 *
 *   Allow/deny:
 *     prior_count < maxRequests  → allowed (we appended now)
 *     prior_count >= maxRequests → denied  (window full, no append)
 *
 *   This correctly handles same-ms duplicate timestamps because prior_count
 *   is a COUNT of timestamps, not a membership test.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

import { logger } from "./logger";

logger.info("rate limiter: postgresql backend");

interface LimiterConfig {
  /** Maximum requests allowed in the window. */
  maxRequests: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Namespace prefix to isolate this limiter's keys in the shared table. */
  namespace: string;
}

/** 1-in-N chance of running the expired-row cleanup sweep on any given check(). */
const PRUNE_PROBABILITY = 1 / 100;

class SlidingWindowRateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly namespace: string;

  constructor(config: LimiterConfig) {
    this.maxRequests = config.maxRequests;
    this.windowMs = config.windowMs;
    this.namespace = config.namespace;
  }

  /**
   * Record a hit for `key` and check whether the rate limit is exceeded.
   *
   * Returns:
   *  - `{ allowed: true }` when the request is within limits.
   *  - `{ allowed: false, retryAfterMs: number }` when the limit is exceeded;
   *    `retryAfterMs` is the time in ms until the oldest hit ages out of the
   *    window, after which one more request will be permitted.
   *
   * Semantics preserved from the original in-memory implementation: the N-th
   * request (filling the window to maxRequests) is allowed; only the (N+1)-th
   * request that would exceed maxRequests is denied.
   *
   * Falls back to allowing the request if the database is unavailable so that
   * a DB outage does not take down the API.
   */
  async check(key: string, requestId?: string): Promise<{ allowed: true } | { allowed: false; retryAfterMs: number }> {
    const dbKey = `${this.namespace}:${key}`;
    const now = Date.now();
    const cutoff = now - this.windowMs;

    try {
      const rows = await db.transaction(async (tx) => {
        // Step 1: Acquire a transaction-level advisory lock on this key.
        // Serializes all concurrent requests for the same key — including the
        // new-key case where the row doesn't exist yet.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${dbKey}))`);

        // Step 2: Writable CTE — read the locked row then upsert in one
        // round-trip.  `unnest` is always aliased via FROM...AS to satisfy PG.
        return tx.execute<{
          timestamps: Array<string> | null;
          prior_count: string | number | null;
        }>(sql`
          WITH locked AS (
            SELECT COALESCE(array_length(
              array(SELECT ts FROM unnest(timestamps) AS ts WHERE ts > ${cutoff}::bigint),
              1
            ), 0) AS prior_count
            FROM rate_limit_buckets
            WHERE key = ${dbKey}
            FOR UPDATE
          ),
          upserted AS (
            INSERT INTO rate_limit_buckets (key, timestamps, updated_at)
            VALUES (
              ${dbKey},
              ARRAY[${now}::bigint],
              now()
            )
            ON CONFLICT (key) DO UPDATE
              SET
                timestamps = CASE
                  WHEN (SELECT COALESCE(prior_count, 0) FROM locked) >= ${this.maxRequests}
                  THEN
                    array(
                      SELECT ts FROM unnest(rate_limit_buckets.timestamps) AS ts
                      WHERE ts > ${cutoff}::bigint
                    )
                  ELSE
                    array(
                      SELECT ts FROM unnest(rate_limit_buckets.timestamps) AS ts
                      WHERE ts > ${cutoff}::bigint
                    ) || ARRAY[${now}::bigint]
                END,
                updated_at = now()
            RETURNING timestamps
          )
          SELECT
            u.timestamps,
            COALESCE((SELECT prior_count FROM locked), 0) AS prior_count
          FROM upserted u
        `);
      });

      const row = rows.rows[0];
      const priorCount = Number(row?.prior_count ?? 0);

      // Opportunistic cleanup runs regardless of allow/deny outcome so that
      // sustained high-traffic deny bursts don't prevent expired-row pruning.
      if (Math.random() < PRUNE_PROBABILITY) {
        setImmediate(() => this.pruneExpiredRows());
      }

      if (priorCount >= this.maxRequests) {
        // Window was full — compute retry time from the oldest in-window timestamp.
        const rawTimestamps = row?.timestamps ?? [];
        const window = (Array.isArray(rawTimestamps) ? rawTimestamps : [])
          .map(Number)
          .filter((t) => t > cutoff)
          .sort((a, b) => a - b);
        const oldest = window[0] ?? now;
        const retryAfterMs = oldest + this.windowMs - now;
        return { allowed: false, retryAfterMs: Math.max(1, retryAfterMs) };
      }

      return { allowed: true };
    } catch (err) {
      logger.error({ err, namespace: this.namespace, requestId }, "rate_limiter: DB check failed — allowing request");
      return { allowed: true };
    }
  }

  /**
   * Delete rows whose newest timestamp is older than the window, meaning the
   * bucket has fully expired and can be removed.
   */
  private async pruneExpiredRows(): Promise<void> {
    const cutoff = Date.now() - this.windowMs;
    try {
      await db.execute(sql`
        DELETE FROM rate_limit_buckets
        WHERE key LIKE ${this.namespace + ":%"}
          AND (
            array_length(timestamps, 1) IS NULL
            OR (
              SELECT MAX(ts) FROM unnest(timestamps) AS ts
            ) <= ${cutoff}::bigint
          )
      `);
    } catch (err) {
      logger.warn({ err, namespace: this.namespace }, "rate_limiter: prune sweep failed");
    }
  }

  /**
   * Clear all recorded hits across every key in this namespace.
   *
   * Intended for test isolation. Not used in production request paths.
   */
  async reset(): Promise<void> {
    try {
      await db.execute(sql`
        DELETE FROM rate_limit_buckets WHERE key LIKE ${this.namespace + ":%"}
      `);
    } catch (err) {
      logger.warn({ err, namespace: this.namespace }, "rate_limiter: reset failed");
    }
  }
}

const IDENTIFY_MAX = Number(process.env.RATE_LIMIT_IDENTIFY_PER_MIN ?? 20);
const TRANSLATE_MAX = Number(process.env.RATE_LIMIT_TRANSLATE_PER_MIN ?? 60);
const PART_CARD_MAX = Number(process.env.RATE_LIMIT_PART_CARD_PER_MIN ?? 30);
const REFERENCE_ASK_MAX = Number(process.env.RATE_LIMIT_REFERENCE_ASK_PER_MIN ?? 20);
const HELP_ASK_MAX = Number(process.env.RATE_LIMIT_HELP_ASK_PER_MIN ?? 20);
const CATALOG_PDF_UPLOAD_MAX = Number(process.env.RATE_LIMIT_CATALOG_PDF_UPLOAD_PER_MIN ?? 5);
const WINDOW_MS = 60_000;

export const identifyLimiter = new SlidingWindowRateLimiter({
  maxRequests: IDENTIFY_MAX,
  windowMs: WINDOW_MS,
  namespace: "identify",
});

export const translateLimiter = new SlidingWindowRateLimiter({
  maxRequests: TRANSLATE_MAX,
  windowMs: WINDOW_MS,
  namespace: "translate",
});

export const partCardLimiter = new SlidingWindowRateLimiter({
  maxRequests: PART_CARD_MAX,
  windowMs: WINDOW_MS,
  namespace: "part_card",
});

export const referenceAskLimiter = new SlidingWindowRateLimiter({
  maxRequests: REFERENCE_ASK_MAX,
  windowMs: WINDOW_MS,
  namespace: "reference_ask",
});

export const helpAskLimiter = new SlidingWindowRateLimiter({
  maxRequests: HELP_ASK_MAX,
  windowMs: WINDOW_MS,
  namespace: "help_ask",
});

export const catalogPdfUploadLimiter = new SlidingWindowRateLimiter({
  maxRequests: CATALOG_PDF_UPLOAD_MAX,
  windowMs: WINDOW_MS,
  namespace: "catalog_pdf_upload",
});

const INVENTORY_SEARCH_MAX = Number(process.env.RATE_LIMIT_INVENTORY_SEARCH_PER_MIN ?? 60);
const ADMIN_QUERY_MAX = Number(process.env.RATE_LIMIT_ADMIN_QUERY_PER_MIN ?? 20);

export const inventorySearchLimiter = new SlidingWindowRateLimiter({
  maxRequests: INVENTORY_SEARCH_MAX,
  windowMs: WINDOW_MS,
  namespace: "inventory_search",
});

export const adminQueryLimiter = new SlidingWindowRateLimiter({
  maxRequests: ADMIN_QUERY_MAX,
  windowMs: WINDOW_MS,
  namespace: "admin_query",
});

const CONTACT_MAX = Number(process.env.RATE_LIMIT_CONTACT_PER_10MIN ?? 5);
const CONTACT_WINDOW_MS = 10 * 60_000;

export const contactLimiter = new SlidingWindowRateLimiter({
  maxRequests: CONTACT_MAX,
  windowMs: CONTACT_WINDOW_MS,
  namespace: "contact",
});

export const screenViewLimiter = new SlidingWindowRateLimiter({
  maxRequests: CONTACT_MAX,
  windowMs: CONTACT_WINDOW_MS,
  namespace: "screen_view",
});
