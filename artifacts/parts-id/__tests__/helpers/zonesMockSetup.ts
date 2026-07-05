/**
 * Shared mock wiring and fixtures for useWarehouseZones hook tests.
 *
 * Usage — in each useWarehouseZones*.test.ts:
 *
 *   1. Import mock vars, SAMPLE_ZONES, flushPromises, and setupBeforeEach.
 *   2. Keep jest.mock() calls in the test file, using require() inside the
 *      factory so Jest hoisting does not break the shared variable references.
 *   3. Call setupBeforeEach() inside beforeEach().
 *
 * Example jest.mock() pattern:
 *   jest.mock("@/utils/appAuth", () => ({
 *     fetchWithAuth: (...args: Parameters<typeof fetch>) =>
 *       require("./helpers/zonesMockSetup").mockFetchWithAuth(...args),
 *     getAuthToken: () => require("./helpers/zonesMockSetup").mockGetAuthToken(),
 *     subscribeToTokenAvailable: (fn: () => void) =>
 *       require("./helpers/zonesMockSetup").mockSubscribeToTokenAvailable(fn),
 *     unsubscribeFromTokenAvailable: (...args: [() => void]) =>
 *       require("./helpers/zonesMockSetup").mockUnsubscribeFromTokenAvailable(...args),
 *   }));
 */

import { act } from "@testing-library/react";

// ── retryAsync ────────────────────────────────────────────────────────────────
export const mockRetryAsync = jest.fn(
  (fn: (attempt: number) => Promise<unknown>) => fn(0),
);

// ── AsyncStorage ──────────────────────────────────────────────────────────────
export const mockGetItem = jest.fn<Promise<string | null>, [string]>(() =>
  Promise.resolve(null),
);
export const mockSetItem = jest.fn<Promise<void>, [string, string]>(() =>
  Promise.resolve(),
);

// ── appAuth ───────────────────────────────────────────────────────────────────
export const mockFetchWithAuth = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
export const mockGetAuthToken  = jest.fn<string | null, []>().mockReturnValue(null);
export const mockSubscribeToTokenAvailable   = jest.fn<void, [() => void]>();
export const mockUnsubscribeFromTokenAvailable = jest.fn();

// ── Fixture ───────────────────────────────────────────────────────────────────
export const SAMPLE_ZONES = [
  {
    id:         1,
    aisleId:    "A1",
    sectionNum: 1,
    isInventory: true,
    svgX:       10,
    svgY:       20,
    svgWidth:   100,
    svgHeight:  50,
    sortOrder:  0,
    createdAt:  "2024-01-01T00:00:00Z",
    updatedAt:  "2024-01-01T00:00:00Z",
  },
];

// ── flushPromises ─────────────────────────────────────────────────────────────
export const flushPromises = (): Promise<void> =>
  act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));

// ── beforeEach setup ──────────────────────────────────────────────────────────
export function setupBeforeEach(): void {
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
}
