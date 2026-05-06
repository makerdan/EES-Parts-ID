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
