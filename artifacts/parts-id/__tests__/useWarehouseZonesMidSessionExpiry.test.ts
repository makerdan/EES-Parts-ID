/**
 * @jest-environment jsdom
 *
 * Unit tests for useWarehouseZones — mid-session token expiry paths.
 *
 * Covered:
 *  - token expires mid-session (401 while hasDataRef is already true)
 *    → error stays false (no false-alarm badge), cached zones remain visible
 *  - token expires mid-session → onUnauthorized clears the token
 *    → tokenAvailable fires when the user re-authenticates
 *    → backgroundFetch runs and zones reload with fresh data
 */

// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import { renderHook, act } from "@testing-library/react";
import { useWarehouseZones } from "../hooks/useWarehouseZones";
import {
  mockFetchWithAuth, mockGetAuthToken,
  mockSubscribeToTokenAvailable, mockUnsubscribeFromTokenAvailable,
  mockGetItem, mockSetItem, mockRetryAsync,
  flushPromises, setupBeforeEach,
} from "./helpers/zonesMockSetup";

// ── Mock factories ────────────────────────────────────────────────────────────
jest.mock("@/utils/retryAsync", () => ({
  retryAsync: (...args: [fn: (attempt: number) => Promise<unknown>]) =>
    require("./helpers/zonesMockSetup").mockRetryAsync(...args),
}));

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: (...args: [string]) => require("./helpers/zonesMockSetup").mockGetItem(...args),
  setItem: (...args: [string, string]) => require("./helpers/zonesMockSetup").mockSetItem(...args),
}));

jest.mock("@/utils/appAuth", () => ({
  fetchWithAuth: (...args: Parameters<typeof fetch>) =>
    require("./helpers/zonesMockSetup").mockFetchWithAuth(...args),
  getAuthToken: () => require("./helpers/zonesMockSetup").mockGetAuthToken(),
  subscribeToTokenAvailable: (fn: () => void) =>
    require("./helpers/zonesMockSetup").mockSubscribeToTokenAvailable(fn),
  unsubscribeFromTokenAvailable: (...args: [() => void]) =>
    require("./helpers/zonesMockSetup").mockUnsubscribeFromTokenAvailable(...args),
}));

// ── apiBase mock ─────────────────────────────────────────────────────────────
jest.mock("@/utils/apiBase", () => ({ API_BASE: "http://localhost:3001" }));

// ── Helpers ───────────────────────────────────────────────────────────────────
const INITIAL_ZONES = [
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

const REFRESHED_ZONES = [
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
    updatedAt: "2024-06-01T00:00:00Z",
  },
  {
    id: 2,
    aisleId: "B1",
    sectionNum: 1,
    isInventory: false,
    svgX: 120,
    svgY: 20,
    svgWidth: 100,
    svgHeight: 50,
    sortOrder: 1,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-06-01T00:00:00Z",
  },
];

// ── Setup / teardown ──────────────────────────────────────────────────────────
beforeEach(() => { setupBeforeEach(); });

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("useWarehouseZones — mid-session token expiry", () => {

  // ── 1. Mid-session 401, hasDataRef already true → error stays false ────────

  describe("401 arrives while zones are already loaded", () => {
    it("keeps error=false and preserves cached zones (no false-alarm badge)", async () => {
      // Phase 1: successful initial fetch — hook has data.
      mockGetAuthToken.mockReturnValue("valid-token");
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ zones: INITIAL_ZONES }),
      } as Response);

      const { result } = renderHook(() => useWarehouseZones());
      await flushPromises();

      // Verify initial state: zones loaded, no error.
      expect(result.current.zones).toEqual(INITIAL_ZONES);
      expect(result.current.error).toBe(false);
      expect(result.current.loading).toBe(false);

      // Phase 2: token expires mid-session — next background refresh gets a 401.
      // After onUnauthorized fires the token is cleared.
      mockGetAuthToken.mockReturnValue(null);
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({}),
      } as Response);

      await act(async () => {
        result.current.refetch();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });

      // Error badge must NOT appear — the map stays usable with cached zones.
      expect(result.current.error).toBe(false);
      // Existing zones are still served; we don't clear state on a 401.
      expect(result.current.zones).toEqual(INITIAL_ZONES);
      expect(result.current.loading).toBe(false);
    });
  });

  // ── 2. Token expires → onUnauthorized clears it → tokenAvailable → reload ──

  describe("token expires → re-authentication → zones reload", () => {
    it("triggers backgroundFetch via tokenAvailable and populates fresh zones", async () => {
      // Phase 1: successful initial fetch — hook has data.
      mockGetAuthToken.mockReturnValue("valid-token");
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ zones: INITIAL_ZONES }),
      } as Response);

      const { result } = renderHook(() => useWarehouseZones());
      await flushPromises();

      expect(result.current.zones).toEqual(INITIAL_ZONES);
      expect(result.current.error).toBe(false);

      // The hook must have registered a tokenAvailable subscriber.
      expect(mockSubscribeToTokenAvailable).toHaveBeenCalledTimes(1);
      const tokenAvailableHandler =
        mockSubscribeToTokenAvailable.mock.calls[0][0];

      // Phase 2: background refresh returns 401 (token expired mid-session).
      // onUnauthorized clears the token — getAuthToken() returns null.
      mockGetAuthToken.mockReturnValue(null);
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({}),
      } as Response);

      await act(async () => {
        result.current.refetch();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });

      // Error is still suppressed; zones still show from prior fetch.
      expect(result.current.error).toBe(false);
      expect(result.current.zones).toEqual(INITIAL_ZONES);

      // Phase 3: user re-authenticates — a new token arrives and onUnauthorized
      // fires tokenAvailable. The hook should re-fetch and serve fresh zones.
      mockGetAuthToken.mockReturnValue("new-valid-token");
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ zones: REFRESHED_ZONES }),
      } as Response);

      await act(async () => {
        tokenAvailableHandler();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });

      // Fresh zones replace the stale ones.
      expect(result.current.zones).toEqual(REFRESHED_ZONES);
      expect(result.current.error).toBe(false);
      expect(result.current.loading).toBe(false);
    });
  });
});
