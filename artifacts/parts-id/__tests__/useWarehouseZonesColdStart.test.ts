/**
 * @jest-environment jsdom
 *
 * Unit tests for useWarehouseZones — cold-start / auth-suppression paths
 * and cleanup / unmount behaviour.
 *
 * Covered:
 *  - cold start, no token, fetch returns 401 → error stays false throughout
 *  - cold start, no token, 401 → token becomes available → retry succeeds
 *    → error stays false and zones populate
 *  - network error (non-401) with no cached data → error becomes true
 *  - network error (non-401) with cached data present → error stays false
 *  - fetch in flight when component unmounts → no setState fires after unmount
 *  - unmount removes the AppState subscription (calls sub.remove())
 *  - unmount calls unsubscribeFromTokenAvailable with the correct handler
 */

// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import { renderHook, act } from "@testing-library/react";
import { AppState } from "react-native";
import { useWarehouseZones } from "../hooks/useWarehouseZones";

// ── retryAsync mock — calls fn(0) once, no delays ────────────────────────────
// The default retryAsync uses 3 attempts with 1 s delays; bypass that so tests
// resolve synchronously without fake timers.
const mockRetryAsync = jest.fn(
  (fn: (attempt: number) => Promise<unknown>) => fn(0),
);

jest.mock("@/utils/retryAsync", () => ({
  retryAsync: (...args: [fn: (attempt: number) => Promise<unknown>]) =>
    mockRetryAsync(...args),
}));

// ── AsyncStorage mock ────────────────────────────────────────────────────────
const mockGetItem = jest.fn<Promise<string | null>, [string]>(() =>
  Promise.resolve(null),
);
const mockSetItem = jest.fn<Promise<void>, [string, string]>(() =>
  Promise.resolve(),
);

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: (...args: [string]) => mockGetItem(...args),
  setItem: (...args: [string, string]) => mockSetItem(...args),
}));

// ── appAuth mock ─────────────────────────────────────────────────────────────
// fetchWithAuth is the actual fetch wrapper; getAuthToken is read in the catch
// block to detect the cold-start race; subscribe/unsubscribe wire up the
// token-available callback so tests can fire it manually.
const mockFetchWithAuth = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
const mockGetAuthToken = jest.fn<string | null, []>().mockReturnValue(null);
const mockSubscribeToTokenAvailable = jest.fn<void, [() => void]>();
const mockUnsubscribeFromTokenAvailable = jest.fn();

jest.mock("@/utils/appAuth", () => ({
  fetchWithAuth: (...args: Parameters<typeof fetch>) =>
    mockFetchWithAuth(...args),
  getAuthToken: () => mockGetAuthToken(),
  subscribeToTokenAvailable: (fn: () => void) =>
    mockSubscribeToTokenAvailable(fn),
  unsubscribeFromTokenAvailable: (...args: [() => void]) =>
    mockUnsubscribeFromTokenAvailable(...args),
}));

// ── apiBase mock ─────────────────────────────────────────────────────────────
jest.mock("@/utils/apiBase", () => ({ API_BASE: "http://localhost:3001" }));

// ── Helpers ───────────────────────────────────────────────────────────────────
const SAMPLE_ZONES = [
  {
    id: 1,
    aisleId: "A1",
    sectionNum: 1,
    isInventory: true,
    svgX: 10,
    svgY: 20,
    svgWidth: 100,
    svgHeight: 50,
    sortOrder: 0,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  },
];

/**
 * Flush all pending microtasks and one macrotask turn so that async state
 * updates triggered by resolved Promises are committed before assertions run.
 */
const flushPromises = (): Promise<void> =>
  act(
    async () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  );

// ── Setup / teardown ──────────────────────────────────────────────────────────
beforeEach(() => {
  mockGetItem.mockReset();
  mockGetItem.mockResolvedValue(null);
  mockSetItem.mockReset();
  mockSetItem.mockResolvedValue(undefined);
  mockFetchWithAuth.mockReset();
  mockGetAuthToken.mockReset();
  mockGetAuthToken.mockReturnValue(null);
  mockSubscribeToTokenAvailable.mockReset();
  mockUnsubscribeFromTokenAvailable.mockReset();
  mockRetryAsync.mockReset();
  mockRetryAsync.mockImplementation(
    (fn: (attempt: number) => Promise<unknown>) => fn(0),
  );
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("useWarehouseZones — cold-start auth suppression", () => {

  // ── 1. No token + 401 → error stays false ────────────────────────────────

  describe("no token present and fetch returns 401", () => {
    it("keeps error=false and loading=false after the 401 (no false-alarm badge)", async () => {
      mockGetAuthToken.mockReturnValue(null);
      mockFetchWithAuth.mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({}),
      } as Response);

      const { result } = renderHook(() => useWarehouseZones());
      await flushPromises();

      expect(result.current.error).toBe(false);
      expect(result.current.loading).toBe(false);
      expect(result.current.zones).toEqual([]);
    });
  });

  // ── 2. No token + 401 → token arrives → retry succeeds ───────────────────

  describe("no token → token becomes available → retry succeeds", () => {
    it("keeps error=false and populates zones once auth settles", async () => {
      // Phase 1: cold start — no token, server returns 401.
      mockGetAuthToken.mockReturnValue(null);
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({}),
      } as Response);

      const { result } = renderHook(() => useWarehouseZones());
      await flushPromises();

      expect(result.current.error).toBe(false);
      // The hook must have registered exactly one token-available subscriber.
      expect(mockSubscribeToTokenAvailable).toHaveBeenCalledTimes(1);

      // Phase 2: token arrives, retry fetch succeeds.
      mockGetAuthToken.mockReturnValue("auth-token-abc");
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ zones: SAMPLE_ZONES }),
      } as Response);

      const tokenAvailableHandler =
        mockSubscribeToTokenAvailable.mock.calls[0][0];

      await act(async () => {
        tokenAvailableHandler();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });

      expect(result.current.error).toBe(false);
      expect(result.current.zones).toEqual(SAMPLE_ZONES);
      expect(result.current.loading).toBe(false);
    });
  });

  // ── 3. Non-auth network error, no cache → error becomes true ─────────────

  describe("non-auth network error with no cached data", () => {
    it("surfaces error=true so a real failure is not silently swallowed", async () => {
      // A token is present, so this is not an auth-related failure.
      mockGetAuthToken.mockReturnValue("auth-token-abc");
      mockFetchWithAuth.mockRejectedValue(new Error("Network failure"));

      const { result } = renderHook(() => useWarehouseZones());
      await flushPromises();

      expect(result.current.error).toBe(true);
      expect(result.current.zones).toEqual([]);
      expect(result.current.loading).toBe(false);
    });

    it("surfaces error=true for a non-401 HTTP error (e.g. 500) when no cache is present", async () => {
      mockGetAuthToken.mockReturnValue("auth-token-abc");
      mockFetchWithAuth.mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
      } as Response);

      const { result } = renderHook(() => useWarehouseZones());
      await flushPromises();

      expect(result.current.error).toBe(true);
      expect(result.current.zones).toEqual([]);
      expect(result.current.loading).toBe(false);
    });
  });

  // ── 4. Network error when cached data is already loaded → error stays false

  describe("network error when cached zones are present", () => {
    it("keeps error=false so the offline map stays usable after a background-refresh failure", async () => {
      // Cache already has zones from a prior successful fetch.
      mockGetItem.mockResolvedValue(JSON.stringify({ zones: SAMPLE_ZONES }));

      // Background refresh fails with a network error.
      mockGetAuthToken.mockReturnValue("auth-token-abc");
      mockFetchWithAuth.mockRejectedValue(new Error("Network failure"));

      const { result } = renderHook(() => useWarehouseZones());
      await flushPromises();

      expect(result.current.error).toBe(false);
      // Cached zones are still served.
      expect(result.current.zones).toEqual(SAMPLE_ZONES);
      expect(result.current.loading).toBe(false);
    });
  });
});

// ── Cleanup / unmount ─────────────────────────────────────────────────────────

describe("useWarehouseZones — cleanup on unmount", () => {
  beforeEach(() => {
    mockGetItem.mockReset();
    mockGetItem.mockResolvedValue(null);
    mockSetItem.mockReset();
    mockSetItem.mockResolvedValue(undefined);
    mockFetchWithAuth.mockReset();
    mockGetAuthToken.mockReset();
    mockGetAuthToken.mockReturnValue("auth-token-abc");
    mockSubscribeToTokenAvailable.mockReset();
    mockUnsubscribeFromTokenAvailable.mockReset();
    mockRetryAsync.mockReset();
    mockRetryAsync.mockImplementation(
      (fn: (attempt: number) => Promise<unknown>) => fn(0),
    );
    // Clear the AppState.addEventListener call history between tests.
    (AppState.addEventListener as jest.Mock).mockClear();
  });

  // ── 5. In-flight fetch → no setState after unmount ───────────────────────

  describe("fetch in flight when component unmounts", () => {
    it("does not update state after unmount when the in-flight fetch resolves late", async () => {
      // Set up a deferred fetch that we resolve manually after unmount.
      let resolveRequest!: () => void;
      const deferredFetch = new Promise<Response>((res) => {
        resolveRequest = () =>
          res({
            ok: true,
            status: 200,
            json: async () => ({ zones: SAMPLE_ZONES }),
          } as Response);
      });
      mockFetchWithAuth.mockReturnValue(deferredFetch);

      const { unmount, result } = renderHook(() => useWarehouseZones());

      // Unmount while the fetch is still in flight.
      act(() => {
        unmount();
      });

      // Now resolve the fetch — mountedRef.current is already false.
      await act(async () => {
        resolveRequest();
        await new Promise<void>((r) => setTimeout(r, 0));
      });

      // The cache write is outside the mountedRef guard, so it proves the
      // fetch actually completed and the guard was exercised.
      expect(mockSetItem).toHaveBeenCalledTimes(1);

      // No state update fired: zones remain at their initial empty value.
      expect(result.current.zones).toEqual([]);
    });
  });

  // ── 6. AppState subscription is cleaned up on unmount ────────────────────

  describe("AppState subscription cleanup", () => {
    it("calls sub.remove() when the component unmounts", async () => {
      const mockRemove = jest.fn();
      (AppState.addEventListener as jest.Mock).mockReturnValueOnce({
        remove: mockRemove,
      });

      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ zones: SAMPLE_ZONES }),
      } as Response);

      const { unmount } = renderHook(() => useWarehouseZones());
      await flushPromises();

      act(() => {
        unmount();
      });

      expect(mockRemove).toHaveBeenCalledTimes(1);
    });
  });

  // ── 7. unsubscribeFromTokenAvailable called with the correct handler ──────

  describe("tokenAvailable subscription cleanup", () => {
    it("calls unsubscribeFromTokenAvailable with the same handler that was subscribed", async () => {
      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ zones: SAMPLE_ZONES }),
      } as Response);

      const { unmount } = renderHook(() => useWarehouseZones());
      await flushPromises();

      // Capture the handler reference that was passed to subscribe.
      expect(mockSubscribeToTokenAvailable).toHaveBeenCalledTimes(1);
      const subscribedHandler = mockSubscribeToTokenAvailable.mock.calls[0][0];

      act(() => {
        unmount();
      });

      expect(mockUnsubscribeFromTokenAvailable).toHaveBeenCalledTimes(1);
      expect(mockUnsubscribeFromTokenAvailable).toHaveBeenCalledWith(
        subscribedHandler,
      );
    });
  });
});
