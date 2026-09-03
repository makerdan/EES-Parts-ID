/**
 * Shared test helpers for MapScreen-level tests.
 *
 * Usage:
 *   import { makeAppMock, flushPromises } from "./helpers/appMocks";
 *
 * In component tests that use act() from @testing-library/react-native, wrap flushPromises:
 *   const flush = () => act(async () => { await flushPromises(); });
 */

import type { AppContextValue } from "@/contexts/AppContext";

/**
 * Returns a default AppContext mock suitable for MapScreen tests.
 * Pass `overrides` to customise individual fields per-test or inject
 * tracked jest.fn() references for assertion.
 *
 * Typed against AppContextValue so TypeScript will emit a compile error
 * if a required field is added to AppContextValue but omitted here.
 *
 * `settings` is seeded from DEFAULT_SETTINGS via jest.requireActual so it
 * can never silently drift when AppContext.tsx changes the defaults.
 */
export function makeAppMock(overrides: Partial<AppContextValue> = {}): AppContextValue {
  const { DEFAULT_SETTINGS } = jest.requireActual<{
    DEFAULT_SETTINGS: AppContextValue["settings"];
  }>("@/contexts/AppContext");
  return {
    isAuthenticated:           false,
    approvalStatus:            "approved",
    recheckApprovalStatus:     jest.fn(),
    settings:                  { ...DEFAULT_SETTINGS },
    updateSetting:             jest.fn(),
    logout:                    jest.fn(),
    logoutAdmin:               jest.fn(),
    clearCache:                jest.fn(),
    isLoading:                 false,
    isAdmin:                   false,
    adminToken:                null,
    registerLogoutHandler:     jest.fn(() => () => {}),
    setPendingMapFocus:        jest.fn(),
    showToast:                 jest.fn(),
    setPinnedParts:            jest.fn(),
    pendingMapFocus:           null,
    pendingMeasureSearch:      null,
    setPendingMeasureSearch:   jest.fn(),
    pendingInventorySearch:    null,
    setPendingInventorySearch: jest.fn(),
    pendingLidarDims:          null,
    setPendingLidarDims:       jest.fn(),
    textFontScale:             1.0,
    pinnedParts:               [],
    resumeProgress:            {},
    setResumeProgress:         jest.fn(),
    ...overrides,
  };
}

/**
 * Raw flush helper — drains the microtask queue without advancing timers,
 * so it works correctly whether fake or real timers are active.
 *
 * Wrap in `act()` from @testing-library/react-native when calling from component tests:
 *   await act(async () => { fireEvent.press(btn); await rawFlush(); });
 *
 * ── How many iterations are needed? ─────────────────────────────────────────
 * Each `await` inside an async event handler consumes one position in the
 * microtask queue.  Because rawFlush's own awaits interleave with the
 * handler's awaits (the queues alternate: H1, R1, H2, R2, …), two rawFlush
 * iterations are needed per handler await to ensure the handler's continuation
 * runs *before* the rawFlush itself returns (and before act() resolves).
 *
 * Worked example — AdminMapCalibrationScreen handleConfirm success path:
 *   await upsertAnchor(1)          → H1  (tick 1 of handler)
 *   await upsertAnchor(2)          → H2  (tick 3 after interleave)
 *   await upsertAnchor(3)          → H3  (tick 5)
 *   await removeItem(…).catch(…)   → H4a + H4b  (ticks 7 & 9)
 *   setIsConfirming(false)         → fires at H4b (tick 9)
 *
 * With 4 rawFlush iterations the R4 tick arrives at step 8, rawFlush
 * resolves, and H4b (setIsConfirming) fires *after* act's callback returns —
 * causing "overlapping act() calls" warnings in tests that assert on the
 * post-confirm state.  With 10 iterations R10 arrives at step 20, well
 * after H4b (step 9), so all state updates are in React's queue before
 * act() tries to flush them.
 *
 * Rule of thumb: use at least 2× (number of awaits in the deepest handler
 * called by the event under test) iterations.  10 covers chains up to 5
 * awaits deep and leaves headroom for future growth.
 *
 * ── fireEvent.press and the "overlapping act() calls" warning ────────────────
 * In RTLRN 14, `fireEvent.press` is async and wraps the call in its own inner
 * act().  A single unawaited `fireEvent.press` inside `await act()` is safe:
 * one inner act (A1) pushes the scope depth once, and by the time rawFlush
 * completes, A1 has popped cleanly (depth mismatch is 0).
 *
 * However, TWO OR MORE unawaited `fireEvent.press` calls inside the same
 * `await act()` create concurrently-open inner acts (A1 at depth+1, A2 at
 * depth+2).  When A1 pops, actScopeDepth is still depth+2 (A2 is still open),
 * so React 19's check `prevDepth !== actScopeDepth - 1` fails and emits one
 * "overlapping act() calls" warning per mismatched pop — three total (A1 pop,
 * A2 pop, outer cleanup).
 *
 * Fix: for tests that must fire the same button's handler twice synchronously
 * (e.g. a double-tap guard), call `element.props.onPress()` directly rather
 * than going through `fireEvent.press`.  This never creates an inner act scope,
 * so the entire sequence lives inside the single outer `await act()`:
 *
 *   // Walk up from the text node to the Pressable
 *   let node: any = tree.getByText(/label/i).parent;
 *   while (node && !node.props?.onPress) node = node.parent;
 *   const onPress = node.props.onPress as () => void;
 *
 *   await act(async () => {
 *     onPress();             // first tap — no inner act scope created
 *     onPress();             // second tap — same
 *     resolveSlot({ ok: false });
 *     await rawFlush();
 *   });
 */
export const flushPromises = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
