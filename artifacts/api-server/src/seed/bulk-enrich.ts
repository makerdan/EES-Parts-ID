/**
 * Bulk enrichment script – generates AI search keywords for all unenriched
 * inventory items (enrichedAt IS NULL).
 *
 * Usage (from workspace root):
 *   DATABASE_URL="$DATABASE_URL" OPENAI_API_KEY="$OPENAI_API_KEY" \
 *   pnpm --filter @workspace/api-server exec tsx src/seed/bulk-enrich.ts
 *
 * Options (env vars):
 *   ENRICH_BATCH_SIZE   – items fetched from DB per wave  (default: 10)
 *   ENRICH_CONCURRENCY  – parallel OpenAI calls per wave  (default: 5)
 *   ENRICH_DELAY_MS     – ms to sleep between waves       (default: 200)
 *   ENRICH_RETRIES      – per-item retry attempts         (default: 3)
 *   ENRICH_MODEL        – OpenAI model to use             (default: gpt-4o-mini)
 */

import { db, pool } from "@workspace/db";
import { inventoryTable } from "@workspace/db";
import { sql, eq } from "drizzle-orm";
import { generateKeywords } from "../utils/generateKeywords";
import { deriveTradeSizeTokens, parseTradeSizeInches, tradeSizeChipLabel } from "../utils/tradeSize";

const BATCH_SIZE   = parseInt(process.env["ENRICH_BATCH_SIZE"]   ?? "10",  10);
const CONCURRENCY  = parseInt(process.env["ENRICH_CONCURRENCY"]  ?? "5",   10);
const DELAY_MS     = parseInt(process.env["ENRICH_DELAY_MS"]     ?? "200", 10);
const MAX_RETRIES  = parseInt(process.env["ENRICH_RETRIES"]      ?? "3",   10);
const MODEL        = process.env["ENRICH_MODEL"] ?? "gpt-4o-mini";

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function enrichWithRetry(item: {
  id: number;
  vendor: string;
  catalog: string;
  description: string | null;
}): Promise<string[]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await generateKeywords(item, MODEL);
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
        await sleep(backoffMs);
      }
    }
  }
  throw lastErr;
}

async function bulkEnrich() {
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(inventoryTable)
    .where(sql`${inventoryTable.enrichedAt} IS NULL`);

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

  while (true) {
    const batch = await db
      .select({
        id: inventoryTable.id,
        vendor: inventoryTable.vendor,
        catalog: inventoryTable.catalog,
        description: inventoryTable.description,
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
          // Derive canonical trade size for conduit/pipe items and append
          // size keyword tokens so the "Trade Size" chip and free-text
          // searches work even when the AI didn't volunteer them.
          const tradeTokens = deriveTradeSizeTokens(item);
          const existing = new Set(r.value.map(k => k.toLowerCase()));
          const merged = [
            ...r.value,
            ...tradeTokens.filter(t => !existing.has(t.toLowerCase())),
          ];
          const tradeSizeInches =
            parseTradeSizeInches(item.catalog) ??
            parseTradeSizeInches(item.description);
          const tradeSize = tradeSizeInches !== null
            ? tradeSizeChipLabel(tradeSizeInches)
            : null;
          await db
            .update(inventoryTable)
            .set({
              aiKeywords: merged,
              enrichedAt: new Date(),
              updatedAt: new Date(),
              ...(tradeSize !== null ? { tradeSize } : {}),
            })
            .where(eq(inventoryTable.id, item.id));
          processed++;
        } else {
          // Leave enrichedAt NULL so a future run will retry this item
          console.error(`  ✗ id=${item.id} (${item.vendor}/${item.catalog}): ${r.reason}`);
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
  console.log(`Errors   : ${errors}  (retryable – re-run script to process)`);
  console.log(`Time     : ${elapsed}s`);

  await pool.end();
}

bulkEnrich().catch((err) => {
  console.error("Bulk enrichment failed:", err);
  process.exit(1);
});
