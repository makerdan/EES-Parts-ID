/**
 * Unit tests for the PostgreSQL-backed SlidingWindowRateLimiter.
 *
 * The DB is mocked so these tests run fully offline and stay fast.
 * Coverage:
 *  - First request is always allowed (new row, prior_count = 0)
 *  - Requests within the limit are allowed (prior_count < maxRequests)
 *  - The exact N-th request (filling the window to maxRequests) is allowed
 *    because prior_count = maxRequests-1 < maxRequests
 *  - The (maxRequests+1)-th request is denied (prior_count = maxRequests)
 *    with a positive retryAfterMs
 *  - Same-ms duplicate: prior_count is a row count from the locked row, NOT
 *    timestamp membership, so a denied request is never misclassified as
 *    allowed even when a concurrent request appended the same `now` value
 *  - retryAfterMs reflects the oldest timestamp in the window
 *  - DB failure falls back to allowing the request (fail-open)
 *  - Limiter namespaces are independent
 */

// ── DB mock ──────────────────────────────────────────────────────────────────
// `check()` uses db.transaction(async (tx) => { await tx.execute(...advisory...); return tx.execute(...upsert...); })
// We mock both the transaction wrapper and the inner execute calls.
const mockTxExecute = jest.fn();
const mockDbExecute = jest.fn();

jest.mock("@workspace/db", () => ({
  db: {
    execute: (...args: unknown[]) => mockDbExecute(...args),
    transaction: jest.fn(
      async (fn: (tx: { execute: typeof mockTxExecute }) => Promise<unknown>) =>
        fn({ execute: mockTxExecute })
    ),
  },
  rateLimitBucketsTable: {},
}));

// ── Logger mock (suppress output in tests) ───────────────────────────────────
jest.mock("../lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { identifyLimiter, translateLimiter } from "../lib/rateLimiter";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Stub one full check() cycle.
 *
 * check() calls tx.execute() twice per invocation:
 *   1st: `SELECT pg_advisory_xact_lock(...)` → no meaningful return value
 *   2nd: the writable CTE upsert → returns `{ rows: [{ prior_count, timestamps }] }`
 *
 * prior_count: number of in-window hits that existed in the locked row
 *              BEFORE this request — the deterministic allow/deny signal.
 * timestamps:  the post-upsert array; used only for the retryAfterMs
 *              calculation when prior_count >= maxRequests.
 */
function stubCheck(prior_count: number, timestamps: Array<number>): void {
  // Advisory lock call returns nothing meaningful
  mockTxExecute.mockResolvedValueOnce({ rows: [] });
  // Upsert CTE returns prior_count + timestamps
  mockTxExecute.mockResolvedValueOnce({ rows: [{ prior_count, timestamps }] });
}

function stubDbTransactionFailure(message = "connection refused"): void {
  const { db } = jest.requireMock("@workspace/db") as {
    db: { transaction: jest.Mock };
  };
  db.transaction.mockRejectedValueOnce(new Error(message));
}

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();

  // Re-bind the transaction mock after clearAllMocks resets it
  const { db } = jest.requireMock("@workspace/db") as {
    db: { transaction: jest.Mock };
  };
  db.transaction.mockImplementation(
    async (fn: (tx: { execute: typeof mockTxExecute }) => Promise<unknown>) =>
      fn({ execute: mockTxExecute })
  );
});

describe("SlidingWindowRateLimiter (PostgreSQL backend)", () => {
  const USER = "user_test_001";
  const NOW = 1_700_000_000_000;
  const WINDOW_MS = 60_000;
  const MAX_REQ = 20; // default for identifyLimiter (env default)

  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(NOW);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("allows the first request (new row, prior_count = 0)", async () => {
    stubCheck(0, [NOW]);

    const result = await identifyLimiter.check(USER);
    expect(result.allowed).toBe(true);
  });

  it("allows requests when prior_count is below maxRequests", async () => {
    stubCheck(5, [NOW - 4000, NOW - 3000, NOW - 2000, NOW - 1000, NOW - 500, NOW]);

    const result = await identifyLimiter.check(USER);
    expect(result.allowed).toBe(true);
  });

  it("allows the exact N-th request (prior_count = maxRequests-1) that fills the window", async () => {
    stubCheck(MAX_REQ - 1, Array.from({ length: MAX_REQ }, (_, i) => NOW - i * 100));

    const result = await identifyLimiter.check(USER);
    expect(result.allowed).toBe(true);
  });

  it("denies when prior_count equals maxRequests (window already full)", async () => {
    const oldest = NOW - WINDOW_MS + 5_000; // 5 s until this entry expires
    const timestamps = Array.from({ length: MAX_REQ }, (_, i) => oldest + i * 100);

    stubCheck(MAX_REQ, timestamps);

    const result = await identifyLimiter.check(USER);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      // retryAfterMs = oldest + windowMs - now = 5000
      expect(result.retryAfterMs).toBe(5_000);
    }
  });

  it("denies even when the returned timestamps contain a same-ms duplicate of now", async () => {
    // Simulates concurrent request A having appended `NOW` before ours arrived.
    // prior_count = maxRequests (the locked row was already full) even though
    // NOW appears in the array. Prior_count is a count — not a membership test.
    const oldest = NOW - WINDOW_MS + 3_000;
    const timestamps = [
      ...Array.from({ length: MAX_REQ - 1 }, (_, i) => oldest + i * 10),
      NOW, // same-ms timestamp from a concurrent request
    ];

    stubCheck(MAX_REQ, timestamps);

    const result = await identifyLimiter.check(USER);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfterMs).toBeGreaterThanOrEqual(1);
    }
  });

  it("retryAfterMs is at least 1 ms when the oldest entry is about to expire", async () => {
    const oldest = NOW - WINDOW_MS + 1; // 1 ms inside the window
    const timestamps = Array.from({ length: MAX_REQ }, (_, i) => oldest + i);

    stubCheck(MAX_REQ, timestamps);

    const result = await identifyLimiter.check(USER);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfterMs).toBeGreaterThanOrEqual(1);
    }
  });

  it("fails open when the DB transaction throws", async () => {
    stubDbTransactionFailure("ECONNREFUSED");

    const result = await identifyLimiter.check(USER);
    expect(result.allowed).toBe(true);
  });

  it("namespaces are independent — each limiter gets its own transaction", async () => {
    stubCheck(0, [NOW]);
    const identifyResult = await identifyLimiter.check(USER);

    stubCheck(0, [NOW]);
    const translateResult = await translateLimiter.check(USER);

    expect(identifyResult.allowed).toBe(true);
    expect(translateResult.allowed).toBe(true);
    // 2 limiters × 2 tx.execute calls each = 4 calls total
    expect(mockTxExecute).toHaveBeenCalledTimes(4);
  });
});
