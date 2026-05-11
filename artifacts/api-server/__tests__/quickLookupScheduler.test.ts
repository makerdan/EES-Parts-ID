/**
 * Unit tests for the Quick Lookup background refresh scheduler.
 *
 * The scheduler fires seedQuickLookups() on a configurable interval under a
 * PostgreSQL advisory lock so concurrent server processes don't double-seed.
 *
 * `startQuickLookupScheduler` accepts an optional `seedFn` parameter so tests
 * can inject a stub without needing to mock the entire module graph (openai,
 * drizzle, etc.). Only the pg pool (for advisory lock queries) is mocked here.
 */

// ── Mocks — must come before any imports ─────────────────────────────────────

// Mock openai to prevent ESM import errors from p-limit / yocto-queue that
// are pulled in by @workspace/integrations-openai-ai-server's batch helpers.
jest.mock('@workspace/integrations-openai-ai-server', () => ({
  openai: { chat: { completions: { create: jest.fn() } } },
  generateImageBuffer: jest.fn(),
  editImages: jest.fn(),
  batchProcess: jest.fn(),
  batchProcessWithSSE: jest.fn(),
  isRateLimitError: jest.fn(() => false),
}));

jest.mock('@workspace/integrations-openai-ai-server/batch', () => ({
  batchProcess: jest.fn(),
  batchProcessWithSSE: jest.fn(),
  isRateLimitError: jest.fn(() => false),
}));

// Mock the pg pool so no real Postgres connection is opened.
const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockPoolConnect = jest.fn();

jest.mock('@workspace/db', () => ({
  db: {},
  pool: { connect: mockPoolConnect },
  quickLookupCache: {},
  inArray: jest.fn(),
  eq: jest.fn(),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────
import { startQuickLookupScheduler, stopQuickLookupScheduler } from '../src/lib/seedQuickLookups';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Configures the pool mock to grant (or deny) the advisory lock.
 * Lock acquisition is the gate that prevents duplicate seeding across
 * concurrent server processes — tests verify both the happy path and the
 * "lock already held" skip path.
 */
function setupPoolMock(lockAcquired: boolean): void {
  mockClientQuery.mockImplementation((sql: string) => {
    if (sql.includes('pg_try_advisory_lock')) {
      return Promise.resolve({ rows: [{ pg_try_advisory_lock: lockAcquired }] });
    }
    // pg_advisory_unlock
    return Promise.resolve({ rows: [] });
  });
  mockPoolConnect.mockResolvedValue({
    query: mockClientQuery,
    release: mockClientRelease,
  });
}

/** Flushes pending microtasks so async chains inside setInterval callbacks settle. */
async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Quick Lookup background refresh scheduler', () => {
  beforeAll(() => {
    jest.useFakeTimers();
    jest.setTimeout(10_000);
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  beforeEach(() => {
    setupPoolMock(true);
  });

  afterEach(() => {
    // Stop the scheduler to clear the module-level timer between tests.
    // stopQuickLookupScheduler() only clears the timer (does not set a permanent
    // stopped flag), so the next test can call startQuickLookupScheduler() freely.
    stopQuickLookupScheduler();
    jest.clearAllMocks();
  });

  it('fires seedFn after the configured interval elapses', async () => {
    const seedFn = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const INTERVAL_MS = 5_000;

    startQuickLookupScheduler(INTERVAL_MS, seedFn);

    // seedFn should NOT be called before the first tick.
    expect(seedFn).not.toHaveBeenCalled();

    jest.advanceTimersByTime(INTERVAL_MS);
    await flush();

    expect(seedFn).toHaveBeenCalledTimes(1);
  });

  it('does not fire seedFn before the interval elapses', () => {
    const seedFn = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);

    startQuickLookupScheduler(10_000, seedFn);

    jest.advanceTimersByTime(9_999);

    expect(seedFn).not.toHaveBeenCalled();
  });

  it('fires seedFn on every subsequent tick', async () => {
    const seedFn = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const INTERVAL_MS = 5_000;

    startQuickLookupScheduler(INTERVAL_MS, seedFn);

    jest.advanceTimersByTime(INTERVAL_MS);
    await flush();
    jest.advanceTimersByTime(INTERVAL_MS);
    await flush();
    jest.advanceTimersByTime(INTERVAL_MS);
    await flush();

    expect(seedFn).toHaveBeenCalledTimes(3);
  });

  it('acquires the pg advisory lock before calling seedFn', async () => {
    const seedFn = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);

    startQuickLookupScheduler(5_000, seedFn);
    jest.advanceTimersByTime(5_000);
    await flush();

    const lockCall = mockClientQuery.mock.calls.find(([sql]: [string]) =>
      String(sql).includes('pg_try_advisory_lock')
    );
    expect(lockCall).toBeDefined();
    expect(seedFn).toHaveBeenCalledTimes(1);
  });

  it('releases the pg advisory lock after seedFn completes', async () => {
    const seedFn = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);

    startQuickLookupScheduler(5_000, seedFn);
    jest.advanceTimersByTime(5_000);
    await flush();

    const unlockCall = mockClientQuery.mock.calls.find(([sql]: [string]) =>
      String(sql).includes('pg_advisory_unlock')
    );
    expect(unlockCall).toBeDefined();
  });

  it('skips seedFn when another process holds the advisory lock', async () => {
    setupPoolMock(false); // advisory lock not acquired
    const seedFn = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);

    startQuickLookupScheduler(5_000, seedFn);
    jest.advanceTimersByTime(5_000);
    await flush();

    expect(seedFn).not.toHaveBeenCalled();
  });

  it('releases the pg connection even when the lock is not acquired', async () => {
    setupPoolMock(false);
    const seedFn = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);

    startQuickLookupScheduler(5_000, seedFn);
    jest.advanceTimersByTime(5_000);
    await flush();

    expect(mockClientRelease).toHaveBeenCalled();
  });

  it('cancels the timer when stopQuickLookupScheduler() is called', async () => {
    const seedFn = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);

    startQuickLookupScheduler(5_000, seedFn);
    stopQuickLookupScheduler();

    jest.advanceTimersByTime(20_000);
    await flush();

    expect(seedFn).not.toHaveBeenCalled();
  });

  it('is idempotent — a second startQuickLookupScheduler() call is a no-op', async () => {
    const seedFn = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);

    startQuickLookupScheduler(5_000, seedFn);
    startQuickLookupScheduler(5_000, seedFn); // second call must be a no-op

    jest.advanceTimersByTime(5_000);
    await flush();

    // Only one tick despite two start() calls.
    expect(seedFn).toHaveBeenCalledTimes(1);
  });

  it('releases the pg connection even when seedFn throws', async () => {
    const seedFn = jest.fn<Promise<void>, []>().mockRejectedValue(new Error('AI call failed'));

    startQuickLookupScheduler(5_000, seedFn);
    jest.advanceTimersByTime(5_000);
    await flush();

    expect(mockClientRelease).toHaveBeenCalled();
  });

  it('resets _seederRunning and retries on the next tick when pool.connect() rejects', async () => {
    // Simulate a transient DB outage on the first tick.
    mockPoolConnect.mockRejectedValueOnce(new Error('connection refused'));
    // Restore normal pool behaviour for the second tick.
    mockPoolConnect.mockResolvedValue({
      query: mockClientQuery,
      release: mockClientRelease,
    });

    const seedFn = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);

    startQuickLookupScheduler(5_000, seedFn);

    // First tick — pool.connect() throws; seedFn must not be called.
    jest.advanceTimersByTime(5_000);
    await flush();
    expect(seedFn).not.toHaveBeenCalled();

    // Second tick — connection succeeds; seedFn must be called, proving
    // that _seederRunning was reset and the scheduler can retry.
    jest.advanceTimersByTime(5_000);
    await flush();
    expect(seedFn).toHaveBeenCalledTimes(1);
  });
});
