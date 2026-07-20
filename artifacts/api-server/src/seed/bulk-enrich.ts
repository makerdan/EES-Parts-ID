/**
 * Bulk enrichment script – generates AI search keywords for all unenriched
 * inventory items (enrichedAt IS NULL).
 *
 * Usage (from workspace root):
 *   DATABASE_URL="$DATABASE_URL" POE_API_KEY="$POE_API_KEY" \
 *   pnpm --filter @workspace/api-server exec tsx src/seed/bulk-enrich.ts
 *
 * Options (env vars):
 *   ENRICH_BATCH_SIZE   – items fetched from DB per wave  (default: 10)
 *   ENRICH_CONCURRENCY  – parallel Poe calls per wave     (default: 5)
 *   ENRICH_DELAY_MS     – ms to sleep between waves       (default: 200)
 *   ENRICH_RETRIES      – per-item retry attempts         (default: 3)
 *   ENRICH_MODEL        – Poe bot to use                  (default: gpt-4o-mini)
 */

import { db, pool } from "@workspace/db";
import { inventoryTable } from "@workspace/db";
import { poeErrorMessage } from "@workspace/integrations-poe-server";
import { eq,sql } from "drizzle-orm";

import { generateKeywords, mergeWithPinned, type PoeEnrichedError } from "../utils/generateKeywords";

const BATCH_SIZE   = parseInt(process.env["ENRICH_BATCH_SIZE"]   ?? "10",  10);
const CONCURRENCY  = parseInt(process.env["ENRICH_CONCURRENCY"]  ?? "5",   10);
const DELAY_MS     = parseInt(process.env["ENRICH_DELAY_MS"]     ?? "200", 10);
const MAX_RETRIES  = parseInt(process.env["ENRICH_RETRIES"]      ?? "3",   10);
const MODEL        = process.env["ENRICH_MODEL"] ?? "gpt-4o-mini";

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns the PoeEnrichedError shape if `err` is one, or null otherwise.
 */
function asPoeEnrichedError(err: unknown): PoeEnrichedError | null {
  if (
    err instanceof Error &&
    "isPoeAuth" in err &&
    "isPoeTransient" in err
  ) {
    return err as PoeEnrichedError;
  }
  return null;
}

async function enrichWithRetry(item: {
  id: number;
  vendor: string;
  catalog: string;
  description: string | null;
  pinnedKeywords: Array<string>;
}): Promise<Array<string>> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await generateKeywords(item, MODEL);
    } catch (err) {
      lastErr = err;
      const poeErr = asPoeEnrichedError(err);
      if (poeErr) {
        // Auth errors are fatal — propagate immediately so the outer loop aborts.
        if (poeErr.isPoeAuth) throw err;
        // Permanent non-auth Poe errors (bot not found, bad model, etc.) won't
        // resolve on retry — fail fast for this item without burning retries.
        if (!poeErr.isPoeTransient) throw err;
      }
      // Transient errors (rate limit, server error, timeout) are worth retrying.
      if (attempt < MAX_RETRIES) {
        const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
        await sleep(backoffMs);
      }
    }
  }
  throw lastErr;
}

async function bulkEnrich() {
  const [totalRow] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(inventoryTable)
    .where(sql`${inventoryTable.enrichedAt} IS NULL`);
  const total = totalRow!.total;

  console.log(`\nItems needing enrichment: ${total}`);
  console.log(`Model: ${MODEL}  batch=${BATCH_SIZE}  concurrency=${CONCURRENCY}  retries=${MAX_RETRIES}\n`);

  if (total === 0) {
    console.log("Nothing to do – all items already enriched.");
    await pool.end();
    return;
  }

  let processed = 0;
  let errors = 0;
  const startTime = Date.now();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await db
      .select({
        id: inventoryTable.id,
        vendor: inventoryTable.vendor,
        catalog: inventoryTable.catalog,
        description: inventoryTable.description,
        pinnedKeywords: inventoryTable.pinnedKeywords,
      })
      .from(inventoryTable)
      .where(sql`${inventoryTable.enrichedAt} IS NULL`)
      .limit(BATCH_SIZE);

    if (batch.length === 0) break;

    // Process wave with limited concurrency
    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      const wave = batch.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(wave.map((item) => enrichWithRetry(item)));

      for (let j = 0; j < results.length; j++) {
        const r = results[j]!;
        const item = wave[j]!;
        if (r.status === "fulfilled") {
          const merged = mergeWithPinned(r.value, item.pinnedKeywords ?? []);
          await db
            .update(inventoryTable)
            .set({ aiKeywords: merged, enrichedAt: new Date(), updatedAt: new Date() })
            .where(eq(inventoryTable.id, item.id));
          processed++;
        } else {
          const poeErr = asPoeEnrichedError(r.reason);
          if (poeErr?.isPoeAuth) {
            // Auth errors mean no further API calls will succeed — abort entirely.
            console.error(`\n✗ Fatal Poe auth error — stopping run immediately.\n  ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
            console.error("  Fix the POE_API_KEY secret and re-run the script.");
            await pool.end();
            process.exit(1);
          }
          // Leave enrichedAt NULL so a future run will retry this item (if transient)
          // or skip it if it was already resolved.
          const label = poeErr && !poeErr.isPoeTransient ? "permanent Poe error" : "error";
          console.error(`  ✗ id=${item.id} (${item.vendor}/${item.catalog}) [${label}]: ${r.reason instanceof Error ? r.reason.message : r.reason}`);
          errors++;
        }
      }

      const done = processed + errors;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const avgMs  = done > 0 ? (Date.now() - startTime) / done : 0;
      const etaSec = avgMs > 0 ? Math.round((avgMs * (total - done)) / 1000) : "?";
      console.log(`  [${elapsed}s] ${done}/${total}  ✓${processed} ✗${errors}  ETA: ${etaSec}s`);

      if (i + CONCURRENCY < batch.length) await sleep(DELAY_MS);
    }

    await sleep(DELAY_MS);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== Enrichment Complete ===`);
  console.log(`Enriched : ${processed}`);
  console.log(`Errors   : ${errors}  (transient errors are retryable – re-run script to process)`);
  console.log(`Time     : ${elapsed}s`);

  await pool.end();
}

bulkEnrich().catch((err) => {
  const poeMsg = poeErrorMessage(err);
  if (poeMsg) {
    console.error(`\nFatal Poe error: ${poeMsg}`);
    console.error("  Fix the POE_API_KEY secret or Poe subscription and re-run.");
  } else {
    console.error("Bulk enrichment failed:", err);
  }
  process.exit(1);
});
