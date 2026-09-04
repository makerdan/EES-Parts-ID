/**
 *
 * Unit tests verifying that the pending sync-retry timer is cancelled when the
 * logout handler fires while a retry is scheduled.
 *
 * The regression this suite guards against
 * ────────────────────────────────────────
 * `syncAllInventory` in `app/(tabs)/index.tsx` schedules itself via
 * `syncRetryTimerRef` when a sync fails. The component clears this timer on
 * unmount, but if the user logs out while the component stays mounted the retry
 * would fire after logout and call `setSyncProgress` / `setSyncError` against
 * auth-sensitive inventory state. The logout handler must cancel the pending
 * timer before that happens.
 *
 * Test strategy
 * ─────────────
 * The component has many external dependencies that make full rendering
 * expensive. Instead, this file extracts and tests the *logout-cleanup contract*
 * in isolation using a minimal React harness that mirrors the exact pattern:
 *
 *   registerLogoutHandler(() => {
 *     if (syncRetryTimerRef.current !== null) {
 *       clearTimeout(syncRetryTimerRef.current);
 *       syncRetryTimerRef.current = null;
 *     }
 *     setSyncRetryPending(false);
 *     …
 *   });
 *
 * If this block changes in index.tsx the corresponding harness should be
 * updated to stay in sync.
 */

import React, { useEffect, useRef, useState } from "react";
import { render, act } from "@testing-library/react-native";

// ── Types ─────────────────────────────────────────────────────────────────────

type LogoutHandler = () => void;
type RegisterLogoutHandler = (handler: LogoutHandler) => () => void;

// ── Harness ───────────────────────────────────────────────────────────────────
//
// Reproduces the two pieces of index.tsx under test:
//
//   1. A `syncRetryTimerRef` that holds a pending setTimeout handle when a sync
//      has failed and an auto-retry is scheduled.
//
//   2. The `registerLogoutHandler` useEffect that clears the timer (and resets
//      `syncRetryPending`) when the logout handler is invoked.
//
// `registerLogoutHandler` is injected so tests can control when the handler
// fires and inspect the effects.

function SyncRetryLogoutHarness({
  registerLogoutHandler,
  initialRetryPending = false,
}: {
  registerLogoutHandler: RegisterLogoutHandler;
  initialRetryPending?: boolean;
}) {
  const syncRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, setSyncRetryPending] = useState(initialRetryPending);

  // Seed a real pending timer when the harness mounts with initialRetryPending
  // so there is a live handle in syncRetryTimerRef for the logout handler to
  // cancel.
  useEffect(() => {
    if (initialRetryPending) {
      syncRetryTimerRef.current = setTimeout(() => {
        // Would normally call syncAllInventory() — intentionally a no-op here
      }, 30_000);
    }
    return () => {
      // Unmount cleanup (mirrors the useEffect in index.tsx)
      if (syncRetryTimerRef.current !== null) {
        clearTimeout(syncRetryTimerRef.current);
        syncRetryTimerRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirror of the registerLogoutHandler useEffect in index.tsx
  useEffect(() => {
    return registerLogoutHandler(() => {
      if (syncRetryTimerRef.current !== null) {
        clearTimeout(syncRetryTimerRef.current);
        syncRetryTimerRef.current = null;
      }
      setSyncRetryPending(false);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerLogoutHandler]);

  return React.createElement("view", { testID: "harness" });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Creates a `registerLogoutHandler` implementation that stores the registered
 * handler and exposes a `fireLogout()` helper so tests can trigger it.
 */
function makeLogoutRegistry() {
  let registeredHandler: LogoutHandler | null = null;

  const registerLogoutHandler: RegisterLogoutHandler = (handler) => {
    registeredHandler = handler;
    return () => {
      registeredHandler = null;
    };
  };

  const fireLogout = () => {
    if (registeredHandler) registeredHandler();
  };

  return { registerLogoutHandler, fireLogout };
}

// ── Tests ─────────────────────────────────────────────────────────────────────
//
// Strategy: spy on setTimeout / clearTimeout to count harness-level calls.
// We do NOT use jest.getTimerCount() because await render() internally schedules
// React scheduler timers (setTimeout(fn,0)) that inflate the count, even with
// doNotFake: ["setImmediate", "nextTick"].

describe("syncRetryTimer logout cleanup — clearTimeout called when logout fires", () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("calls clearTimeout on the pending retry timer when the logout handler fires", async () => {
    const clearTimeoutSpy = jest.spyOn(global, "clearTimeout");
    const { registerLogoutHandler, fireLogout } = makeLogoutRegistry();

    const result = await render(
      React.createElement(SyncRetryLogoutHarness, {
        registerLogoutHandler,
        initialRetryPending: true,
      }),
    );

    // Clear spy so we only count calls from the logout handler, not from
    // React internals or the render() act() wrapper.
    clearTimeoutSpy.mockClear();

    // Use async act so the setSyncRetryPending(false) state update is fully
    // flushed before the assertion (prevents pending React work leaking into
    // subsequent tests under fake timers).
    await act(async () => {
      fireLogout();
    });

    // clearTimeout must have been called exactly once to cancel the pending retry
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);

    // Explicitly unmount so RTLN's auto-cleanup queue is empty before afterEach.
    await result.unmount();
  });

  it("does NOT call clearTimeout when there is no pending retry timer", async () => {
    const clearTimeoutSpy = jest.spyOn(global, "clearTimeout");
    const { registerLogoutHandler, fireLogout } = makeLogoutRegistry();

    const result = await render(
      React.createElement(SyncRetryLogoutHarness, {
        registerLogoutHandler,
        initialRetryPending: false,
      }),
    );

    clearTimeoutSpy.mockClear();

    await act(async () => {
      fireLogout();
    });

    expect(clearTimeoutSpy).not.toHaveBeenCalled();

    await result.unmount();
  });

  it("the pending retry timer does NOT fire after the logout handler cancels it", async () => {
    const retrySpy = jest.fn();
    const { registerLogoutHandler, fireLogout } = makeLogoutRegistry();

    // Use a custom harness variant that calls retrySpy when the timer fires
    function HarnessWithSpy({
      registerLogoutHandler: reg,
    }: { registerLogoutHandler: RegisterLogoutHandler }) {
      const timerRef = useRef<number | ReturnType<typeof setTimeout> | null>(null);

      useEffect(() => {
        timerRef.current = setTimeout(retrySpy, 30_000);
        return () => {
          if (timerRef.current !== null) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
          }
        };
      }, []);

      useEffect(() => {
        return reg(() => {
          if (timerRef.current !== null) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
          }
        });
      // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      return null;
    }

    const result = await render(
      React.createElement(HarnessWithSpy, { registerLogoutHandler }),
    );

    await act(async () => {
      fireLogout();
    });

    expect(retrySpy).not.toHaveBeenCalled();

    await result.unmount();
  });

  it("the pending retry timer still fires normally if logout is never called", async () => {
    // Use real timers for just this test to avoid React-scheduler fake-timer
    // cross-contamination from previous tests that advance fake time.
    jest.useRealTimers();

    const retrySpy = jest.fn();
    const { registerLogoutHandler } = makeLogoutRegistry();

    function HarnessTimerOnly({
      registerLogoutHandler: reg,
    }: { registerLogoutHandler: RegisterLogoutHandler }) {
      const timerRef = useRef<number | ReturnType<typeof setTimeout> | null>(null);

      useEffect(() => {
        timerRef.current = setTimeout(retrySpy, 50);
        return () => {
          if (timerRef.current !== null) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
          }
        };
      }, []);

      useEffect(() => {
        return reg(() => {
          if (timerRef.current !== null) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
          }
        });
      // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      return null;
    }

    const result = await render(
      React.createElement(HarnessTimerOnly, { registerLogoutHandler }),
    );

    // Wait for the real 50ms timer to fire (no logout was called).
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Without logout the retry callback should run normally
    expect(retrySpy).toHaveBeenCalledTimes(1);

    await result.unmount();
  });
});
