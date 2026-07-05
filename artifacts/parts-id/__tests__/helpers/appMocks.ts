/**
 * Shared test helpers for MapScreen-level tests.
 *
 * Usage:
 *   import { makeAppMock, flushPromises } from "./helpers/appMocks";
 *
 * In component tests that use act() from react-test-renderer, wrap flushPromises:
 *   const flush = () => act(async () => { await flushPromises(); });
 */

/**
 * Returns a default AppContext mock suitable for MapScreen tests.
 * Pass `overrides` to customise individual fields per-test or inject
 * tracked jest.fn() references for assertion.
 */
export function makeAppMock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    settings: {
      textSize:                   "normal" as const,
      defaultConfidenceThreshold: 50,
      themeMode:                  "system" as const,
      shelfViewEnabled:           true,
      scanSound:                  true,
      dimensionUnit:              "mm" as const,
    },
    updateSetting:           jest.fn(),
    logout:                  jest.fn(),
    clearCache:              jest.fn(),
    isLoading:               false,
    isAdmin:                 false,
    adminToken:              null,
    registerLogoutHandler:   jest.fn(() => () => {}),
    setPendingMapFocus:      jest.fn(),
    showToast:               jest.fn(),
    setPinnedParts:          jest.fn(),
    pendingMapFocus:         null,
    pendingMeasureSearch:    null,
    setPendingMeasureSearch: jest.fn(),
    textFontScale:           1.0,
    pinnedParts:             [],
    ...overrides,
  };
}

/**
 * Raw flush helper — drains the microtask queue without advancing timers,
 * so it works correctly whether fake or real timers are active.
 *
 * Wrap in `act()` from react-test-renderer when calling from component tests:
 *   const flushPromises = () => act(async () => { await fp(); });
 */
export const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
