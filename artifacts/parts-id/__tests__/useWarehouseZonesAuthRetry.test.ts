/**
 * @jest-environment jsdom
 *
 * useWarehouseZones — slow-auth cold-start retry path
 *
 * Covered:
 *  - initial fetch fails silently (no error badge) when no token is present on
 *    cold start — hook suppresses the error badge for auth failures
 *  - zones remain empty and loading=false after the silent auth failure
 *  - subscribeToTokenAvailable callback is registered on mount
 *  - backgroundFetch retries when the callback fires and a token is now present
 *  - zones state is populated and error stays false after the successful retry
 *  - loading returns to false after the retry completes
 *  - token-available callback is a no-op (hasDataRef guard) when zones are
 *    already loaded — no duplicate fetch is issued
 *  - token-available callback is a no-op when zones came from the cache
 *  - unsubscribeFromTokenAvailable is called on unmount
 *  - state is not updated after unmount when the callback fires post-unmount
 */

// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

import { renderHook, act } from "@testing-library/react";
import { useWarehouseZones } from "../hooks/useWarehouseZones";

// ---------------------------------------------------------------------------
// retryAsync mock — bypass retry delays so tests run without fake timers.
// The real implementation waits 1 000 ms between attempts; we want a
// single-attempt, zero-delay shim for deterministic hook tests.
// ---------------------------------------------------------------------------
jest.mock("@/utils/retryAsync", () => ({
  retryAsync: async (fn: (attempt: number) => Promise<unknown>) => fn(0),
}));

// ---------------------------------------------------------------------------
// appAuth mock
//   fetchWithAuth       — controlled via mockFetchWithAuth
//   getAuthToken        — controlled via mockGetAuthToken (null = no token yet)
//   subscribeToTokenAvailable — captures the callback the hook registers
//   unsubscribeFromTokenAvailable — tracked for unmount-cleanup assertion
// ---------------------------------------------------------------------------
let capturedTokenAvailableCallback: (() => void) | null = null;

const mockFetchWithAuth = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
const mockGetAuthToken = jest.fn<string | null, []>();
const mockUnsubscribeFromTokenAvailable = jest.fn();

jest.mock("@/utils/appAuth", () => ({
  fetchWithAuth: (...args: Parameters<typeof fetch>) => mockFetchWithAuth(...args),
  getAuthToken: () => mockGetAuthToken(),
  subscribeToTokenAvailable: (fn: () => void) => {
    capturedTokenAvailableCallback = fn;
  },
  unsubscribeFromTokenAvailable: (...args: [() => void]) =>
    mockUnsubscribeFromTokenAvailable(...args),
}));

// ---------------------------------------------------------------------------
// AsyncStorage mock — empty cache by default (no prior fetch to fall back on)
// ---------------------------------------------------------------------------
const mockGetItem = jest.fn<Promise<string | null>, [string]>();
const mockSetItem = jest.fn<Promise<void>, [string, string]>();

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: (...args: [string]) => mockGetItem(...args),
    setItem: (...args: [string, string]) => mockSetItem(...args),
  },
}));

// ---------------------------------------------------------------------------
// apiBase mock
// ---------------------------------------------------------------------------
jest.mock("@/utils/apiBase", () => ({ API_BASE: "http://localhost:3001" }));

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------
const MOCK_ZONES = [
  {
    id: 1,
    aisleId: "A1",
    sectionNum: 1,
    isInventory: true,
    svgX: 10,
    svgY: 20,
    svgWidth: 100,
    svgHeight: 50,
    sortOrder: 1,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flush all pending microtasks + one real setTimeout(0) inside act(). */
const flushPromises = (): Promise<void> =>
  act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
beforeEach(() => {
  capturedTokenAvailableCallback = null;
  mockFetchWithAuth.mockReset();
  mockGetAuthToken.mockReset();
  mockGetAuthToken.mockReturnValue(null);   // default: no token yet
  mockUnsubscribeFromTokenAvailable.mockReset();
  mockGetItem.mockResolvedValue(null);      // no cached zones
  mockSetItem.mockResolvedValue(undefined);
});

afterEach(() => {
  jest.clearAllTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("useWarehouseZones — slow-auth retry via subscribeToTokenAvailable", () => {

  // ── Silent auth failure on cold start ─────────────────────────────────────

  describe("initial auth failure is suppressed (no error badge)", () => {
    it("sets error=false, zones=[], loading=false after 401 with no token present", async () => {
      // No token at all (getAuthToken returns null already via beforeEach)
      mockFetchWithAuth.mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({}),
      } as Response);

      const { result } = renderHook(() => useWarehouseZones());
      await flushPromises();

      // Error badge must NOT appear — this is the auth-suppression behaviour
      expect(result.current.error).toBe(false);
      expect(result.current.zones).toEqual([]);
      expect(result.current.loading).toBe(false);
    });

    it("also suppresses error when token is absent and fetch throws a non-HTTP error", async () => {
      mockFetchWithAuth.mockRejectedValue(new Error("Network request failed"));

      const { result } = renderHook(() => useWarehouseZones());
      await flushPromises();

      expect(result.current.error).toBe(false);
      expect(result.current.zones).toEqual([]);
      expect(result.current.loading).toBe(false);
    });

    it("registers a token-available subscriber on mount", async () => {
      mockFetchWithAuth.mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({}),
      } as Response);

      renderHook(() => useWarehouseZones());
      await flushPromises();

      expect(capturedTokenAvailableCallback).not.toBeNull();
      expect(typeof capturedTokenAvailableCallback).toBe("function");
    });
  });

  // ── Token-available retry ─────────────────────────────────────────────────

  describe("token-available notification triggers a successful retry", () => {
    it("populates zones and keeps error=false after the callback fires", async () => {
      // Phase 1: cold start — no token, fetch returns 401, silent failure
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({}),
      } as Response);

      const { result } = renderHook(() => useWarehouseZones());
      await flushPromises();

      expect(result.current.zones).toEqual([]);
      expect(result.current.error).toBe(false);

      // Phase 2: token arrives — retry fetch succeeds
      mockGetAuthToken.mockReturnValue("tok-abc123");
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ zones: MOCK_ZONES }),
      } as Response);

      expect(capturedTokenAvailableCallback).not.toBeNull();
      await act(async () => {
        capturedTokenAvailableCallback!();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });

      expect(result.current.zones).toEqual(MOCK_ZONES);
      expect(result.current.error).toBe(false);
      expect(result.current.loading).toBe(false);
    });

    it("issues exactly one additional fetch call after the token-available notification", async () => {
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({}),
      } as Response);

      renderHook(() => useWarehouseZones());
      await flushPromises();

      const callsAfterInitialFail = mockFetchWithAuth.mock.calls.length;

      mockGetAuthToken.mockReturnValue("tok-abc123");
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ zones: MOCK_ZONES }),
      } as Response);

      await act(async () => {
        capturedTokenAvailableCallback!();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });

      expect(mockFetchWithAuth.mock.calls.length).toBe(callsAfterInitialFail + 1);
    });

    it("sets loading=false after the retry resolves", async () => {
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({}),
      } as Response);

      const { result } = renderHook(() => useWarehouseZones());
      await flushPromises();

      // loading should have settled to false after the silent failure too
      expect(result.current.loading).toBe(false);

      mockGetAuthToken.mockReturnValue("tok-abc123");
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ zones: MOCK_ZONES }),
      } as Response);

      await act(async () => {
        capturedTokenAvailableCallback!();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });

      expect(result.current.loading).toBe(false);
    });
  });

  // ── hasDataRef guard ──────────────────────────────────────────────────────

  describe("token-available callback is a no-op when zones are already loaded", () => {
    it("does not issue another fetch when the first fetch succeeded", async () => {
      mockGetAuthToken.mockReturnValue("tok-abc123");
      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ zones: MOCK_ZONES }),
      } as Response);

      const { result } = renderHook(() => useWarehouseZones());
      await flushPromises();

      expect(result.current.zones).toEqual(MOCK_ZONES);
      const callCountAfterLoad = mockFetchWithAuth.mock.calls.length;

      // Token-available fires — must NOT trigger another fetch (hasDataRef=true)
      await act(async () => {
        capturedTokenAvailableCallback!();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });

      expect(mockFetchWithAuth.mock.calls.length).toBe(callCountAfterLoad);
    });

    it("does not issue another fetch when zones were served from cache", async () => {
      // Cache contains zones from a prior session
      mockGetItem.mockResolvedValue(JSON.stringify({ zones: MOCK_ZONES }));
      // Background fetch also succeeds (both paths set hasDataRef)
      mockGetAuthToken.mockReturnValue("tok-abc123");
      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ zones: MOCK_ZONES }),
      } as Response);

      const { result } = renderHook(() => useWarehouseZones());
      await flushPromises();

      expect(result.current.zones).toEqual(MOCK_ZONES);
      const callCountAfterLoad = mockFetchWithAuth.mock.calls.length;

      await act(async () => {
        capturedTokenAvailableCallback!();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });

      expect(mockFetchWithAuth.mock.calls.length).toBe(callCountAfterLoad);
    });
  });

  // ── Unmount cleanup ───────────────────────────────────────────────────────

  describe("unmount cleanup", () => {
    it("calls unsubscribeFromTokenAvailable on unmount", () => {
      mockFetchWithAuth.mockReturnValue(new Promise(() => {})); // never resolves

      const { unmount } = renderHook(() => useWarehouseZones());

      expect(mockUnsubscribeFromTokenAvailable).not.toHaveBeenCalled();
      unmount();
      expect(mockUnsubscribeFromTokenAvailable).toHaveBeenCalledTimes(1);
    });

    it("does not update state after unmount when token-available fires post-unmount", async () => {
      // Phase 1: cold start silent failure
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({}),
      } as Response);

      const { result, unmount } = renderHook(() => useWarehouseZones());
      await flushPromises();

      expect(result.current.zones).toEqual([]);

      // Capture callback then unmount
      const callbackBeforeUnmount = capturedTokenAvailableCallback!;
      unmount();

      // Retry would succeed — but mountedRef=false, so state must not change
      mockGetAuthToken.mockReturnValue("tok-abc123");
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ zones: MOCK_ZONES }),
      } as Response);

      // Fire callback after unmount; must not throw or update state
      await act(async () => {
        callbackBeforeUnmount();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });

      // State snapshot must remain the pre-unmount values
      expect(result.current.zones).toEqual([]);
    });
  });
});
