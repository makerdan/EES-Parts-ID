/**
 * Seeder for the `quick_lookup_cache` table.
 *
 * Iterates the 12 canonical Quick Lookup chip definitions, checks whether
 * each row is missing or older than 30 days, and calls the AI for any that
 * need refreshing. The full streamed response is collected before writing so
 * partial text never lands in the database.
 *
 * Called non-blocking from the server startup path — errors are logged but
 * never propagate to crash the process.
 *
 * Exposes `isQuickLookupSeederReady()` so the health-check endpoint can
 * return 503 until all chips are seeded. The Replit proxy uses this to
 * gate traffic on production deploys, guaranteeing every chip tap is
 * instant from the very first request.
 *
 * Readiness guarantee: `_ready` is only set to `true` after a post-seed
 * verification query confirms that all 12 canonical chip labels are present
 * in the database. Individual chip failures are retried up to MAX_RETRIES
 * times before the verification step runs.
 */
import { db, pool, quickLookupCache } from '@workspace/db';
import { eq, inArray } from 'drizzle-orm';
import { openai } from '@workspace/integrations-openai-ai-server';
import { logger } from './logger';

let _ready = false;

/**
 * Returns true once seedQuickLookups() has verified that all 12 canonical
 * chip labels are present in the database. Used by the /healthz endpoint to
 * block traffic until the cache is fully pre-populated.
 */
export function isQuickLookupSeederReady(): boolean {
  return _ready;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Number of times to retry a chip that fails on the first attempt. */
const MAX_RETRIES = 2;

/** Delay (ms) between retries to avoid hammering the AI on transient errors. */
const RETRY_DELAY_MS = 2_000;

const SYSTEM_PROMPT =
  'You are a concise electrical supply reference assistant for warehouse workers. Answer questions about electrical parts, NEC codes, NEMA ratings, wire gauges, breaker types, conduit sizing, and terminology. Use **bold** for key terms and - bullets for lists. Keep answers under 200 words. Be precise and practical.';

const CHIPS = [
  {
    label: '1G',
    question:
      'What is a 1-gang electrical box, what devices does it hold, and what are the standard dimensions?',
  },
  {
    label: 'GFCI',
    question: 'What does GFCI stand for, how does it work, and where is it required by the NEC?',
  },
  {
    label: 'AFCI',
    question:
      'What is an AFCI breaker or receptacle, how does it work, and where does the NEC require it?',
  },
  {
    label: 'TRWR',
    question:
      'What does TRWR mean on a receptacle — what is Tamper Resistant and Weather Resistant, and where is each required?',
  },
  {
    label: 'Decora',
    question:
      'What is a Decora style switch or receptacle, who makes them, and how do they differ from standard toggle style?',
  },
  {
    label: 'Romex',
    question:
      'What is Romex (NM-B cable), what do the numbers on the sheath mean, and when is it allowed by code?',
  },
  {
    label: 'MC Cable',
    question:
      'What is MC cable (Metal Clad armored cable), how does it differ from Romex, and when should it be used?',
  },
  {
    label: 'EMT',
    question:
      'What is EMT (Electrical Metallic Tubing) conduit, what are its common uses, and how does it differ from rigid conduit?',
  },
  {
    label: 'Toggle vs Rocker',
    question:
      'What is the difference between a toggle switch and a rocker (paddle) switch — are they interchangeable?',
  },
  {
    label: 'Duplex',
    question:
      'What is a duplex receptacle, how does it differ from simplex and quadplex outlets, and what are standard amperage ratings?',
  },
  {
    label: '15A vs 20A',
    question:
      'What is the difference between 15 amp and 20 amp circuits, receptacles, and breakers — how do I tell them apart?',
  },
  {
    label: 'AWG',
    question:
      'What does AWG mean, how does wire gauge numbering work, and which gauge should I use for common circuits?',
  },
] as const;

const ALL_CHIP_LABELS = CHIPS.map((c) => c.label);

async function fetchAnswer(question: string): Promise<string> {
  const stream = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_completion_tokens: 512,
    stream: true,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: question },
    ],
  });

  let fullText = '';
  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content;
    if (content) fullText += content;
  }
  return fullText;
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function seedChip(
  chip: (typeof CHIPS)[number],
  staleThreshold: Date
): Promise<'skipped' | 'upserted' | 'failed'> {
  const [existing] = await db
    .select()
    .from(quickLookupCache)
    .where(eq(quickLookupCache.label, chip.label))
    .limit(1);

  const isStale = !existing || existing.refreshedAt < staleThreshold;
  if (!isStale) {
    logger.debug({ label: chip.label }, 'Quick lookup cache hit — skipping');
    return 'skipped';
  }

  logger.info({ label: chip.label }, 'Fetching quick lookup answer from AI');
  const answer = await fetchAnswer(chip.question);

  if (!answer.trim()) {
    logger.warn({ label: chip.label }, 'AI returned empty answer — skipping upsert');
    return 'failed';
  }

  await db
    .insert(quickLookupCache)
    .values({
      label: chip.label,
      question: chip.question,
      answer,
    })
    .onConflictDoUpdate({
      target: quickLookupCache.label,
      set: {
        question: chip.question,
        answer,
        refreshedAt: new Date(),
      },
    });

  logger.info({ label: chip.label }, 'Quick lookup cache upserted');
  return 'upserted';
}

export async function seedQuickLookups(): Promise<void> {
  logger.info('Quick lookup cache seeder starting');

  const staleThreshold = new Date(Date.now() - THIRTY_DAYS_MS);

  const failedLabels = new Set<string>();

  for (const chip of CHIPS) {
    try {
      const result = await seedChip(chip, staleThreshold);
      if (result === 'failed') {
        failedLabels.add(chip.label);
      }
    } catch (err) {
      logger.error({ err, label: chip.label }, 'Failed to seed quick lookup — will retry');
      failedLabels.add(chip.label);
    }
  }

  if (failedLabels.size > 0) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      logger.info({ labels: [...failedLabels], attempt }, 'Retrying failed quick lookup chips');
      await delay(RETRY_DELAY_MS);

      const toRetry = CHIPS.filter((c) => failedLabels.has(c.label));
      for (const chip of toRetry) {
        try {
          const result = await seedChip(chip, staleThreshold);
          if (result !== 'failed') {
            failedLabels.delete(chip.label);
          }
        } catch (err) {
          logger.error({ err, label: chip.label, attempt }, 'Retry failed for quick lookup chip');
        }
      }

      if (failedLabels.size === 0) break;
    }
  }

  logger.info('Quick lookup cache seeder loop complete — verifying all chips present');

  try {
    const rows = await db
      .select({ label: quickLookupCache.label })
      .from(quickLookupCache)
      .where(inArray(quickLookupCache.label, ALL_CHIP_LABELS as unknown as string[]));

    const presentLabels = new Set(rows.map((r) => r.label));
    const missingLabels = ALL_CHIP_LABELS.filter((l) => !presentLabels.has(l));

    if (missingLabels.length === 0) {
      logger.info('Quick lookup cache fully verified — all 12 chips present');
      _ready = true;
    } else {
      logger.error(
        { missingLabels },
        'Quick lookup cache verification failed — some chips missing after retries; server will remain at 503'
      );
    }
  } catch (err) {
    logger.error(
      { err },
      'Quick lookup cache verification query failed — server will remain at 503'
    );
  }
}

// ── Background refresh scheduler ──────────────────────────────────────────────

/**
 * PostgreSQL session-level advisory lock key reserved for the quick-lookup
 * refresh scheduler. Distinct from the series auto-assign key (20250001) to
 * avoid cross-feature lock contention.
 */
const SCHEDULER_ADVISORY_LOCK_KEY = 20250002;

const DEFAULT_SCHEDULE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Prevents the same process from double-running if a tick fires before the
 * previous refresh completes (e.g. very short interval in tests). */
let _seederRunning = false;

let _scheduleTimer: NodeJS.Timeout | null = null;

/** Minimal interface for the pg PoolClient used by the advisory lock. */
interface PgPoolClient {
  query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
  release(): void;
}

/**
 * Attempts to run the provided seed function under a PostgreSQL advisory lock
 * so that concurrent server processes (e.g. on a rolling deploy) don't
 * double-seed.
 *
 * Uses `pg_try_advisory_lock` (non-blocking): if another process already holds
 * the lock the refresh is skipped for this tick and retried on the next tick.
 *
 * `_seederRunning` is reset in the outermost `finally` block so that a
 * transient `pool.connect()` failure never permanently disables future ticks.
 *
 * @param seedFn - The function to call while the advisory lock is held.
 *                 Defaults to `seedQuickLookups`. Overridable for testing.
 */
async function scheduledRefresh(seedFn: () => Promise<void>): Promise<void> {
  if (_seederRunning) {
    logger.debug('Quick lookup scheduled refresh skipped — previous run still in progress');
    return;
  }
  _seederRunning = true;

  // Declare client outside try so the finally block can release it even if
  // pool.connect() throws (transient DB outage, pool exhaustion, etc.).
  let client: PgPoolClient | null = null;
  try {
    client = await pool.connect();

    const { rows } = await client.query<{ pg_try_advisory_lock: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint)',
      [SCHEDULER_ADVISORY_LOCK_KEY]
    );
    const lockAcquired = rows[0]?.pg_try_advisory_lock ?? false;

    if (!lockAcquired) {
      logger.info(
        'Quick lookup scheduled refresh skipped — another process holds the advisory lock'
      );
      return;
    }

    try {
      await seedFn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [SCHEDULER_ADVISORY_LOCK_KEY]);
    }
  } catch (err) {
    logger.error({ err }, 'Quick lookup scheduled refresh failed');
  } finally {
    client?.release();
    _seederRunning = false;
  }
}

/**
 * Start the background quick-lookup refresh scheduler.
 *
 * Fires `seedQuickLookups()` every `intervalMs` milliseconds (default: 24 h)
 * under a PostgreSQL advisory lock so concurrent processes don't double-seed.
 * The timer is `.unref()`-ed so it never prevents the process from exiting
 * during tests or graceful shutdowns.
 *
 * @param intervalMs - How often to refresh (ms). Default: 24 hours.
 * @param seedFn     - The seed function to run on each tick. Overridable for
 *                     testing without needing to mock the entire module graph.
 *
 * Safe to call once at server startup; subsequent calls are no-ops.
 */
export function startQuickLookupScheduler(
  intervalMs: number = DEFAULT_SCHEDULE_INTERVAL_MS,
  seedFn: () => Promise<void> = seedQuickLookups
): void {
  if (_scheduleTimer) return;
  const safeInterval = Math.max(1_000, Math.floor(intervalMs));
  _scheduleTimer = setInterval(() => {
    void scheduledRefresh(seedFn);
  }, safeInterval);
  _scheduleTimer.unref?.();
  logger.info({ intervalMs: safeInterval }, 'Quick lookup refresh scheduler started');
}

/**
 * Cancel the background refresh scheduler.
 * Called from the graceful-shutdown path so the timer doesn't fire mid-drain.
 */
export function stopQuickLookupScheduler(): void {
  if (_scheduleTimer) {
    clearInterval(_scheduleTimer);
    _scheduleTimer = null;
    logger.info('Quick lookup refresh scheduler stopped');
  }
}
