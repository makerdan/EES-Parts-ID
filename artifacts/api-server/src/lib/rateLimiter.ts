/**
 * Lightweight in-memory sliding-window rate limiter.
 *
 * Keyed on an arbitrary string (Clerk userId for app users, IP for admin
 * requests).  Each limiter instance tracks a separate namespace so that
 * identify/translate-query/part-card limits are fully independent.
 *
 * The implementation stores only hit timestamps — there is no external
 * dependency and no timer to clean up.  Old buckets are pruned on each hit
 * so memory stays bounded by (maxRequests × active_users).
 */

interface LimiterConfig {
  /** Maximum requests allowed in the window. */
  maxRequests: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

interface BucketState {
  timestamps: number[];
}

export class SlidingWindowRateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly buckets = new Map<string, BucketState>();

  constructor(config: LimiterConfig) {
    this.maxRequests = config.maxRequests;
    this.windowMs = config.windowMs;
  }

  /**
   * Record a hit for `key` and check whether the rate limit is exceeded.
   *
   * Returns:
   *  - `{ allowed: true }` when the request is within limits.
   *  - `{ allowed: false, retryAfterMs: number }` when the limit is exceeded;
   *    `retryAfterMs` is the time in ms until the oldest hit ages out of the
   *    window, after which one more request will be permitted.
   */
  check(key: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { timestamps: [] };
      this.buckets.set(key, bucket);
    }

    // Prune timestamps outside the window.
    bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);

    if (bucket.timestamps.length >= this.maxRequests) {
      // Oldest hit in window: once it ages out, one slot opens.
      const oldest = bucket.timestamps[0]!;
      const retryAfterMs = oldest + this.windowMs - now;
      return { allowed: false, retryAfterMs: Math.max(1, retryAfterMs) };
    }

    bucket.timestamps.push(now);
    return { allowed: true };
  }

  /**
   * Clear all recorded hits across every key.
   *
   * Intended for test isolation so one test's requests do not consume another
   * test's rate-limit budget. Not used in production request paths.
   */
  reset(): void {
    this.buckets.clear();
  }
}

const IDENTIFY_MAX = Number(process.env.RATE_LIMIT_IDENTIFY_PER_MIN ?? 20);
const TRANSLATE_MAX = Number(process.env.RATE_LIMIT_TRANSLATE_PER_MIN ?? 60);
const PART_CARD_MAX = Number(process.env.RATE_LIMIT_PART_CARD_PER_MIN ?? 30);
const WINDOW_MS = 60_000;

export const identifyLimiter = new SlidingWindowRateLimiter({
  maxRequests: IDENTIFY_MAX,
  windowMs: WINDOW_MS,
});

export const translateLimiter = new SlidingWindowRateLimiter({
  maxRequests: TRANSLATE_MAX,
  windowMs: WINDOW_MS,
});

export const partCardLimiter = new SlidingWindowRateLimiter({
  maxRequests: PART_CARD_MAX,
  windowMs: WINDOW_MS,
});
