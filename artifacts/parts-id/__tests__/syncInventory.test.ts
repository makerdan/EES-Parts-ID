/**
 * @jest-environment node
 *
 * Unit tests for the syncAllInventory utility.
 *
 * Covers the two regression-prone behaviours fixed in task #215:
 *   1. Every inventory-page fetch carries `cache: 'no-store'` so ETags /
 *      304 responses never serve stale data.
 *   2. A concurrent call while a sync is already in flight returns
 *      immediately without issuing any additional fetches.
 */

import { syncAllInventory } from "../lib/syncInventory";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCallbacks() {
  return {
    setIsSyncing: jest.fn(),
    setSyncProgress: jest.fn(),
    setSyncError: jest.fn(),
    setSyncRetry: jest.fn(),
    buildFuseIndex: jest.fn(),
  };
}

function makeStorage() {
  return { multiSet: jest.fn().mockResolvedValue(undefined) };
}

const OPTS_BASE = {
  apiBase: "http://localhost:8080/api",
  fuseKey: "fuse_key",
  versionKey: "version_key",
  assignmentsKey: "assignments_key",
  treeKey: "tree_key",
} as const;

function inventoryResponse(items: unknown[] = [], total = 0) {
  return {
    ok: true,
    json: jest.fn().mockResolvedValue({ items, total }),
  } as unknown as Response;
}

function emptyInventoryResponse() {
  return inventoryResponse([], 0);
}

function categoriesResponse() {
  return {
    ok: false,
    json: jest.fn(),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. cache: 'no-store' on inventory page fetches
// ---------------------------------------------------------------------------

describe("syncAllInventory — cache: no-store", () => {
  it("passes cache: 'no-store' on the first inventory page fetch", async () => {
    const fetchMock = jest.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/inventory?")) {
        return Promise.resolve(emptyInventoryResponse());
      }
      return Promise.resolve(categoriesResponse());
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const syncInFlightRef = { current: false };
    await syncAllInventory({
      ...OPTS_BASE,
      syncInFlightRef,
      callbacks: makeCallbacks(),
      storage: makeStorage(),
    });

    const inventoryCalls = fetchMock.mock.calls.filter(([url]) =>
      typeof url === "string" && (url as string).includes("/inventory?"),
    );

    expect(inventoryCalls.length).toBeGreaterThanOrEqual(1);

    for (const [, init] of inventoryCalls) {
      expect((init as RequestInit).cache).toBe("no-store");
    }
  });

  it("passes cache: 'no-store' on every inventory page fetch when multiple pages are needed", async () => {
    let callCount = 0;
    const fetchMock = jest.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/inventory?")) {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(inventoryResponse([{ id: 1 }], 2));
        }
        return Promise.resolve(inventoryResponse([{ id: 2 }], 2));
      }
      return Promise.resolve(categoriesResponse());
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const syncInFlightRef = { current: false };
    await syncAllInventory({
      ...OPTS_BASE,
      syncInFlightRef,
      callbacks: makeCallbacks(),
      storage: makeStorage(),
    });

    const inventoryCalls = fetchMock.mock.calls.filter(([url]) =>
      typeof url === "string" && (url as string).includes("/inventory?"),
    );

    expect(inventoryCalls.length).toBe(2);

    for (const [, init] of inventoryCalls) {
      expect((init as RequestInit).cache).toBe("no-store");
    }
  });
});

// ---------------------------------------------------------------------------
// 2. In-flight guard — second call returns early
// ---------------------------------------------------------------------------

describe("syncAllInventory — in-flight guard", () => {
  it("returns early without fetching when a sync is already in progress", async () => {
    let resolveFirstSync!: () => void;
    const firstSyncSettled = new Promise<void>(resolve => {
      resolveFirstSync = resolve;
    });

    let fetchCallCount = 0;
    const fetchMock = jest.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/inventory?")) {
        fetchCallCount++;
        // Block until we release from outside the test, simulating a slow network.
        return new Promise<Response>(resolve => {
          firstSyncSettled.then(() =>
            resolve(emptyInventoryResponse()),
          );
        });
      }
      return Promise.resolve(categoriesResponse());
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const syncInFlightRef = { current: false };
    const callbacks = makeCallbacks();
    const storage = makeStorage();

    const firstCall = syncAllInventory({
      ...OPTS_BASE,
      syncInFlightRef,
      callbacks,
      storage,
    });

    // Give the first call time to start and set syncInFlightRef.current = true.
    await new Promise<void>(r => setTimeout(r, 0));

    expect(syncInFlightRef.current).toBe(true);

    // Second call — must return immediately without issuing any new fetch.
    await syncAllInventory({
      ...OPTS_BASE,
      syncInFlightRef,
      callbacks,
      storage,
    });

    // Only the first call should have touched fetch at this point.
    expect(fetchCallCount).toBe(1);

    // Let the first sync complete cleanly.
    resolveFirstSync();
    await firstCall;

    // Even after the first sync finishes, the second call issued no extra fetches.
    expect(fetchCallCount).toBe(1);
  });

  it("allows a new sync to start after the previous one completes", async () => {
    const fetchMock = jest.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/inventory?")) {
        return Promise.resolve(emptyInventoryResponse());
      }
      return Promise.resolve(categoriesResponse());
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const syncInFlightRef = { current: false };
    const callbacks = makeCallbacks();
    const storage = makeStorage();

    await syncAllInventory({ ...OPTS_BASE, syncInFlightRef, callbacks, storage });
    expect(syncInFlightRef.current).toBe(false);

    const fetchCountAfterFirst = fetchMock.mock.calls.filter(([url]) =>
      typeof url === "string" && (url as string).includes("/inventory?"),
    ).length;

    await syncAllInventory({ ...OPTS_BASE, syncInFlightRef, callbacks, storage });

    const fetchCountAfterSecond = fetchMock.mock.calls.filter(([url]) =>
      typeof url === "string" && (url as string).includes("/inventory?"),
    ).length;

    expect(fetchCountAfterSecond).toBeGreaterThan(fetchCountAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// 3. Storage failure tolerance — cache write error does not surface as sync error
// ---------------------------------------------------------------------------

describe("syncAllInventory — storage failure tolerance", () => {
  it("does not call setSyncError(true) when the large cache write fails but page fetches succeed", async () => {
    const fetchMock = jest.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/inventory?")) {
        return Promise.resolve(emptyInventoryResponse());
      }
      return Promise.resolve(categoriesResponse());
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    // First call = version key write (small, must succeed).
    // Second call = large cache write (throws quota error).
    let storageCallCount = 0;
    const storage = {
      multiSet: jest.fn().mockImplementation(() => {
        storageCallCount++;
        if (storageCallCount === 1) return Promise.resolve(undefined);
        return Promise.reject(new Error("QuotaExceededError: The quota has been exceeded."));
      }),
    };

    const syncInFlightRef = { current: false };
    const callbacks = makeCallbacks();

    await syncAllInventory({
      ...OPTS_BASE,
      serverVersion: "v42",
      syncInFlightRef,
      callbacks,
      storage,
    });

    // Sync must NOT show an error banner — the page fetches all succeeded.
    expect(callbacks.setSyncError).not.toHaveBeenCalledWith(true);
    // In-flight ref must be cleared so future syncs can run.
    expect(syncInFlightRef.current).toBe(false);
    // setIsSyncing(false) must have been called (spinner clears).
    expect(callbacks.setIsSyncing).toHaveBeenLastCalledWith(false);
    // The in-memory index must have been built despite the storage failure.
    expect(callbacks.buildFuseIndex).toHaveBeenCalledTimes(1);

    // First multiSet call must contain ONLY the version key (small isolated write).
    const firstCallPairs = storage.multiSet.mock.calls[0]![0] as [string, string][];
    expect(firstCallPairs).toHaveLength(1);
    expect(firstCallPairs[0]![0]).toBe(OPTS_BASE.versionKey);
    expect(firstCallPairs[0]![1]).toBe("v42");

    // Second multiSet call must contain the fuse key (large cache write).
    const secondCallPairs = storage.multiSet.mock.calls[1]![0] as [string, string][];
    expect(secondCallPairs[0]![0]).toBe(OPTS_BASE.fuseKey);
  });

  it("does call setSyncError(true) when the version key write fails (page fetch succeeds)", async () => {
    jest.useFakeTimers();
    try {
      const fetchMock = jest.fn().mockImplementation((url: string) => {
        if (typeof url === "string" && url.includes("/inventory?")) {
          return Promise.resolve(emptyInventoryResponse());
        }
        return Promise.resolve(categoriesResponse());
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      // Version-key write fails — this propagates out of attemptSync and triggers retries.
      const storage = {
        multiSet: jest.fn().mockRejectedValue(new Error("QuotaExceededError")),
      };

      const syncInFlightRef = { current: false };
      const callbacks = makeCallbacks();

      const syncPromise = syncAllInventory({
        ...OPTS_BASE,
        serverVersion: "v42",
        syncInFlightRef,
        callbacks,
        storage,
      });

      // Advance through all exponential-backoff delays (2s + 4s + 8s = 14s).
      await jest.runAllTimersAsync();
      await syncPromise;

      // Version write failure IS a real error — all retries exhaust and banner appears.
      expect(callbacks.setSyncError).toHaveBeenCalledWith(true);
      expect(syncInFlightRef.current).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Retry exhaustion — setSyncError called after all retries fail
// ---------------------------------------------------------------------------

describe("syncAllInventory — retry exhaustion", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("calls setSyncError(true) after all retries are exhausted", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: jest.fn(),
    } as unknown as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    const syncInFlightRef = { current: false };
    const callbacks = makeCallbacks();

    const syncPromise = syncAllInventory({
      ...OPTS_BASE,
      syncInFlightRef,
      callbacks,
      storage: makeStorage(),
    });

    // Advance through all exponential-backoff delays (2s + 4s + 8s = 14s).
    await jest.runAllTimersAsync();
    await syncPromise;

    expect(callbacks.setSyncError).toHaveBeenCalledWith(true);
    // Should NOT have been called with false after the final failure
    // (it is reset to false at the very start, before the loop).
    const calls = callbacks.setSyncError.mock.calls.map(([v]: [boolean]) => v);
    expect(calls[calls.length - 1]).toBe(true);
  });

  it("resets syncInFlightRef to false even after all retries fail", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: jest.fn(),
    } as unknown as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    const syncInFlightRef = { current: false };
    const callbacks = makeCallbacks();

    const syncPromise = syncAllInventory({
      ...OPTS_BASE,
      syncInFlightRef,
      callbacks,
      storage: makeStorage(),
    });

    await jest.runAllTimersAsync();
    await syncPromise;

    expect(syncInFlightRef.current).toBe(false);
    expect(callbacks.setIsSyncing).toHaveBeenLastCalledWith(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Retry progress — setSyncRetry receives correct attempt/max on each retry
// ---------------------------------------------------------------------------

describe("syncAllInventory — setSyncRetry values", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("calls setSyncRetry with incrementing attempt numbers on each retry", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: jest.fn(),
    } as unknown as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    const syncInFlightRef = { current: false };
    const callbacks = makeCallbacks();

    const syncPromise = syncAllInventory({
      ...OPTS_BASE,
      syncInFlightRef,
      callbacks,
      storage: makeStorage(),
    });

    await jest.runAllTimersAsync();
    await syncPromise;

    // setSyncRetry is called once per retry (attempts 1, 2, 3) then once
    // with null in the finally block.
    const retryCalls = callbacks.setSyncRetry.mock.calls as Array<
      [{ attempt: number; max: number } | null]
    >;
    const nonNullCalls = retryCalls.filter(([v]) => v !== null) as Array<
      [{ attempt: number; max: number }]
    >;

    // Exactly MAX_AUTO_RETRIES non-null calls (one per retry attempt).
    expect(nonNullCalls).toHaveLength(3);

    // Each call carries the correct attempt number and the fixed max.
    expect(nonNullCalls[0]![0]).toEqual({ attempt: 1, max: 3 });
    expect(nonNullCalls[1]![0]).toEqual({ attempt: 2, max: 3 });
    expect(nonNullCalls[2]![0]).toEqual({ attempt: 3, max: 3 });
  });

  it("does not call setSyncRetry with a non-null value when the first attempt succeeds", async () => {
    const fetchMock = jest.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/inventory?")) {
        return Promise.resolve(emptyInventoryResponse());
      }
      return Promise.resolve(categoriesResponse());
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const syncInFlightRef = { current: false };
    const callbacks = makeCallbacks();

    const syncPromise = syncAllInventory({
      ...OPTS_BASE,
      syncInFlightRef,
      callbacks,
      storage: makeStorage(),
    });

    await jest.runAllTimersAsync();
    await syncPromise;

    const nonNullRetryCalls = callbacks.setSyncRetry.mock.calls.filter(
      ([v]: [unknown]) => v !== null,
    );
    expect(nonNullRetryCalls).toHaveLength(0);
  });
});
