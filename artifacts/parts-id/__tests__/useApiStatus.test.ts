/**
 * @jest-environment jsdom
 *
 * Unit tests for the useApiStatus hook.
 *
 * Covered:
 *  - initial state (status="unknown", restarting=false)
 *  - successful poll returning "ok", "degraded", or "error"
 *  - poll with unknown status value falls back to "error"
 *  - poll with non-ok HTTP response sets "error"
 *  - poll fetch throw sets "error"
 *  - focus/blur starts and stops the polling interval
 *  - no polling when adminToken is null
 *  - triggerRestart sets restarting=true / status="unknown" immediately
 *  - triggerRestart polls /healthz until server responds, then clears restarting
 *  - triggerRestart does not announce recovery for an unrecognised healthz status
 *  - triggerRestart falls back to status="error" after max attempts
 *  - triggerRestart stops after a hanging restart POST timeout without recovery polling
 *  - triggerRestart reports authorization when adminToken is null
 *  - second concurrent triggerRestart call is ignored while one is in progress
 *  - AppState "active" restarts polling and resets status when screen is focused
 *  - AppState "active" is a no-op when the screen is not focused
 *  - AppState non-"active" transitions do not affect polling
 *  - AppState subscription is removed on unmount
 *  - AppState "active" is a no-op when adminToken is null
 */

// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

import { renderHook, act } from "@testing-library/react";
import { useApiStatus } from "../hooks/useApiStatus";

// ---------------------------------------------------------------------------
// expo-router mock — capture the useFocusEffect callback so tests can
// manually trigger focus and the returned cleanup to simulate blur.
// ---------------------------------------------------------------------------
let capturedFocusCallback: (() => (() => void) | void) | null = null;

jest.mock("expo-router", () => ({
  useFocusEffect: (cb: () => (() => void) | void) => {
    capturedFocusCallback = cb;
  },
}));

// ---------------------------------------------------------------------------
// react-native mock — expose a controllable AppState so tests can simulate
// foreground/background transitions.
// ---------------------------------------------------------------------------
let capturedAppStateListener: ((state: string) => void) | null = null;
const mockSubscriptionRemove = jest.fn();

jest.mock("react-native", () => ({
  AppState: {
    addEventListener: jest.fn((_event: string, cb: (state: string) => void) => {
      capturedAppStateListener = cb;
      return { remove: mockSubscriptionRemove };
    }),
  },
}));

// ---------------------------------------------------------------------------
// fetch mock — installed on global so the hook can call it unmodified.
// Each test configures mockFetch via .mockResolvedValue / .mockImplementation.
// ---------------------------------------------------------------------------
const mockFetch = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
// @ts-ignore
global.fetch = mockFetch;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const API_BASE = "http://localhost:3001";
const ADMIN_TOKEN = "test-admin-token";

/** Simulate the screen coming into focus; returns the blur/cleanup fn. */
function triggerFocus(): (() => void) | void {
  if (!capturedFocusCallback) throw new Error("useFocusEffect was never called");
  return capturedFocusCallback();
}

/** Simulate an AppState change event. */
function triggerAppState(nextState: string): void {
  if (!capturedAppStateListener) throw new Error("AppState.addEventListener was never called");
  capturedAppStateListener(nextState);
}

/**
 * Flush all pending microtasks (promise callbacks) without advancing fake
 * timers.  Wrapping inside act() ensures React state-update batches are
 * committed before assertions run.
 */
const flushMicrotasks = (): Promise<void> =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

/** Flush promises via a real 0 ms task (only safe when NOT using fake timers). */
const flushPromises = (): Promise<void> =>
  act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
beforeEach(() => {
  capturedFocusCallback = null;
  capturedAppStateListener = null;
  mockSubscriptionRemove.mockReset();
  mockFetch.mockReset();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("useApiStatus", () => {

  // ── Initial state ──────────────────────────────────────────────────────────

  describe("initial state", () => {
    it("has status='unknown', restarting=false, and exposes triggerRestart", () => {
      mockFetch.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() =>
        useApiStatus({ apiBase: API_BASE, adminToken: ADMIN_TOKEN }),
      );

      expect(result.current.status).toBe("unknown");
      expect(result.current.restarting).toBe(false);
      expect(typeof result.current.triggerRestart).toBe("function");
    });
  });

  // ── Poll status transitions ────────────────────────────────────────────────

  describe("poll status transitions", () => {
    it.each<[string, "ok" | "degraded" | "error"]>([
      ["ok", "ok"],
      ["degraded", "degraded"],
      ["error", "error"],
    ])(
      'sets status to "%s" when /healthz returns { status: "%s" }',
      async (serverStatus, expected) => {
        mockFetch.mockResolvedValue({
          ok: true,
          json: async () => ({ status: serverStatus }),
        } as Response);

        const { result } = renderHook(() =>
          useApiStatus({ apiBase: API_BASE, adminToken: ADMIN_TOKEN }),
        );

        act(() => { triggerFocus(); });
        await flushPromises();

        expect(result.current.status).toBe(expected);
      },
    );

    it("sets status to 'error' when /healthz returns an unrecognised status value", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: "starting-up" }),
      } as Response);

      const { result } = renderHook(() =>
        useApiStatus({ apiBase: API_BASE, adminToken: ADMIN_TOKEN }),
      );

      act(() => { triggerFocus(); });
      await flushPromises();

      expect(result.current.status).toBe("error");
    });

    it("sets status to 'error' when /healthz returns a non-ok HTTP status", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        json: async () => ({}),
      } as Response);

      const { result } = renderHook(() =>
        useApiStatus({ apiBase: API_BASE, adminToken: ADMIN_TOKEN }),
      );

      act(() => { triggerFocus(); });
      await flushPromises();

      expect(result.current.status).toBe("error");
    });

    it("sets status to 'error' when the fetch request throws (network failure)", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      const { result } = renderHook(() =>
        useApiStatus({ apiBase: API_BASE, adminToken: ADMIN_TOKEN }),
      );

      act(() => { triggerFocus(); });
      await flushPromises();

      expect(result.current.status).toBe("error");
    });

    it("calls /healthz with cache: 'no-store' and an AbortSignal", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: "ok" }),
      } as Response);

      const { result } = renderHook(() =>
        useApiStatus({ apiBase: API_BASE, adminToken: ADMIN_TOKEN }),
      );

      act(() => { triggerFocus(); });
      await flushPromises();

      expect(mockFetch).toHaveBeenCalledWith(
        `${API_BASE}/healthz`,
        expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
      );
      expect(result.current.status).toBe("ok");
    });
  });

  // ── Focus / blur polling lifecycle ─────────────────────────────────────────

  describe("focus/blur polling lifecycle", () => {
    it("aborts an in-flight health request when the focused screen blurs", async () => {
      jest.useFakeTimers();
      let observedSignal: AbortSignal | undefined;
      mockFetch.mockImplementation((_url, init) => {
        observedSignal = (init as RequestInit | undefined)?.signal ?? undefined;
        return new Promise<Response>(() => {});
      });

      const { unmount } = renderHook(() =>
        useApiStatus({ apiBase: API_BASE, adminToken: ADMIN_TOKEN, intervalMs: 1000 }),
      );

      act(() => { triggerFocus(); });
      expect(observedSignal).toBeInstanceOf(AbortSignal);
      expect(observedSignal?.aborted).toBe(false);

      const blur = capturedFocusCallback?.();
      act(() => { if (typeof blur === "function") blur(); });

      expect(observedSignal?.aborted).toBe(true);
      await unmount();
    });

    it("does not overlap health polls while the previous request is pending", async () => {
      jest.useFakeTimers();
      let resolveFetch: ((value: Response) => void) | null = null;
      mockFetch.mockImplementation(() =>
        new Promise<Response>(resolve => { resolveFetch = resolve; }),
      );

      const { unmount } = renderHook(() =>
        useApiStatus({ apiBase: API_BASE, adminToken: ADMIN_TOKEN, intervalMs: 1000 }),
      );

      act(() => { triggerFocus(); });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      await act(async () => { jest.advanceTimersByTime(5000); });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveFetch?.({
          ok: true,
          json: async () => ({ status: "ok" }),
        } as Response);
      });
      await flushMicrotasks();
      await unmount();
    });

    it("starts polling immediately on focus and fires again on each interval tick", async () => {
      jest.useFakeTimers();

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: "ok" }),
      } as Response);

      renderHook(() =>
        useApiStatus({ apiBase: API_BASE, adminToken: ADMIN_TOKEN, intervalMs: 1000 }),
      );

      act(() => { triggerFocus(); });
      await flushMicrotasks();

      const callsAfterFocus = mockFetch.mock.calls.length;
      expect(callsAfterFocus).toBeGreaterThanOrEqual(1);

      // One interval tick — should fire another poll
      await act(async () => { jest.advanceTimersByTime(1000); });
      await flushMicrotasks();

      expect(mockFetch.mock.calls.length).toBeGreaterThan(callsAfterFocus);
    });

    it("stops polling after blur (interval is cleared)", async () => {
      jest.useFakeTimers();

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: "ok" }),
      } as Response);

      renderHook(() =>
        useApiStatus({ apiBase: API_BASE, adminToken: ADMIN_TOKEN, intervalMs: 1000 }),
      );

      let blur: (() => void) | void;
      act(() => { blur = triggerFocus(); });
      await flushMicrotasks();

      // Blur — stop the interval
      act(() => {
        if (typeof blur === "function") blur();
      });
      const callsAtBlur = mockFetch.mock.calls.length;

      // Several more ticks — no new polls should fire
      await act(async () => { jest.advanceTimersByTime(5000); });
      await flushMicrotasks();

      expect(mockFetch.mock.calls.length).toBe(callsAtBlur);
    });

    it("resets status to 'unknown' immediately on focus before the first poll resolves", async () => {
      jest.useFakeTimers();

      // First poll: set status to "ok" so the hook has a known non-unknown state
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "ok" }),
      } as Response);

      const { result } = renderHook(() =>
        useApiStatus({ apiBase: API_BASE, adminToken: ADMIN_TOKEN, intervalMs: 60_000 }),
      );

      // First focus — poll resolves to "ok"
      let blur: (() => void) | void;
      act(() => { blur = triggerFocus(); });
      await flushMicrotasks();
      expect(result.current.status).toBe("ok");

      // Blur the tab
      act(() => { if (typeof blur === "function") blur(); });

      // Second focus: next poll is pending (never resolves)
      mockFetch.mockReturnValue(new Promise(() => {}));
      act(() => { triggerFocus(); });

      // Status must be "unknown" immediately — before the poll resolves
      expect(result.current.status).toBe("unknown");
    });

    it("does not start polling when adminToken is null", async () => {
      jest.useFakeTimers();

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: "ok" }),
      } as Response);

      renderHook(() =>
        useApiStatus({ apiBase: API_BASE, adminToken: null, intervalMs: 1000 }),
      );

      act(() => { triggerFocus(); });
      await flushMicrotasks();
      await act(async () => { jest.advanceTimersByTime(5000); });
      await flushMicrotasks();

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ── AppState background/foreground lifecycle ───────────────────────────────

  describe("AppState background/foreground lifecycle", () => {
    it("restarts polling and resets status to 'unknown' when app becomes active while screen is focused", async () => {
      jest.useFakeTimers();

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: "ok" }),
      } as Response);

      const { result } = renderHook(() =>
        useApiStatus({ apiBase: API_BASE, adminToken: ADMIN_TOKEN, intervalMs: 60_000 }),
      );

      // Bring the screen into focus so isFocusedRef = true
      act(() => { triggerFocus(); });
      await flushMicrotasks();
      expect(result.current.status).toBe("ok");

      const callsAfterFocus = mockFetch.mock.calls.length;

      // Simulate app returning to foreground
      mockFetch.mockReturnValue(new Promise(() => {}));
      act(() => { triggerAppState("active"); });

      // Status must reset to "unknown" immediately
      expect(result.current.status).toBe("unknown");

      // A new poll must have been dispatched
      await flushMicrotasks();
      expect(mockFetch.mock.calls.length).toBeGreaterThan(callsAfterFocus);
    });

    it("does not restart polling when app becomes active but the screen is not focused", async () => {
      jest.useFakeTimers();

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: "ok" }),
      } as Response);

      const { result } = renderHook(() =>
        useApiStatus({ apiBase: API_BASE, adminToken: ADMIN_TOKEN, intervalMs: 60_000 }),
      );

      // Focus then immediately blur so isFocusedRef = false
      let blur: (() => void) | void;
      act(() => { blur = triggerFocus(); });
      await flushMicrotasks();
      act(() => { if (typeof blur === "function") blur(); });

      const callsAfterBlur = mockFetch.mock.calls.length;

      // App comes to foreground, but screen is not focused
      act(() => { triggerAppState("active"); });
      await flushMicrotasks();

      expect(mockFetch.mock.calls.length).toBe(callsAfterBlur);
    });

    it("does not restart polling on non-active AppState transitions", async () => {
      jest.useFakeTimers();

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: "ok" }),
      } as Response);

      const { result } = renderHook(() =>
        useApiStatus({ apiBase: API_BASE, adminToken: ADMIN_TOKEN, intervalMs: 60_000 }),
      );

      act(() => { triggerFocus(); });
      await flushMicrotasks();
      expect(result.current.status).toBe("ok");

      const callsAfterFocus = mockFetch.mock.calls.length;

      act(() => { triggerAppState("background"); });
      await flushMicrotasks();
      act(() => { triggerAppState("inactive"); });
      await flushMicrotasks();

      expect(mockFetch.mock.calls.length).toBe(callsAfterFocus);
      expect(result.current.status).toBe("ok");
    });

    it("is a no-op when adminToken is null", async () => {
      jest.useFakeTimers();

      renderHook(() =>
        useApiStatus({ apiBase: API_BASE, adminToken: null, intervalMs: 60_000 }),
      );

      act(() => { triggerFocus(); });
      act(() => { triggerAppState("active"); });
      await flushMicrotasks();

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("removes the AppState subscription on unmount", () => {
      mockFetch.mockReturnValue(new Promise(() => {}));

      const { unmount } = renderHook(() =>
        useApiStatus({ apiBase: API_BASE, adminToken: ADMIN_TOKEN }),
      );

      expect(mockSubscriptionRemove).not.toHaveBeenCalled();
      unmount();
      expect(mockSubscriptionRemove).toHaveBeenCalledTimes(1);
    });
  });

  // ── triggerRestart ─────────────────────────────────────────────────────────

  describe("triggerRestart", () => {
    it("immediately sets restarting=true and status='unknown'", async () => {
      jest.useFakeTimers();

      mockFetch.mockImplementation((url) => {
        if (String(url).includes("/admin/restart")) {
          return Promise.resolve({ status: 202, ok: true, json: async () => ({ restarting: true }) } as Response);
        }
        return new Promise(() => {});
      });

      const { result } = renderHook(() =>
        useApiStatus({ apiBase: API_BASE, adminToken: ADMIN_TOKEN }),
      );

      await act(async () => {
        result.current.triggerRestart();
      });

      expect(result.current.restarting).toBe(true);
      expect(result.current.status).toBe("unknown");
    });

    it("POSTs to /admin/restart with the Bearer token", async () => {
      jest.useFakeTimers();

      mockFetch.mockImplementation((url) => {
        if (String(url).includes("/admin/restart")) {
          return Promise.resolve({ status: 202, ok: true, json: async () => ({ restarting: true }) } as Response);
        }
        return new Promise(() => {});
      });

      const { result } = renderHook(() =>
        useApiStatus({ apiBase: API_BASE, adminToken: ADMIN_TOKEN }),
      );

      await act(async () => { result.current.triggerRestart(); });
      await flushMicrotasks();

      expect(mockFetch).toHaveBeenCalledWith(
        `${API_BASE}/admin/restart`,
        expect.objectContaining({
          method: "POST",
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it("reports authorization denial and does not start recovery polling", async () => {
      mockFetch.mockResolvedValue({
        status: 403,
        ok: false,
        json: async () => ({ error: "Admin access required" }),
      } as Response);

      const { result } = renderHook(() =>
        useApiStatus({ apiBase: API_BASE, adminToken: ADMIN_TOKEN }),
      );

      let outcome: string | undefined;
      await act(async () => {
        outcome = await result.current.triggerRestart();
      });

      expect(outcome).toBe("authorization");
      expect(result.current.restartState).toBe("authorization");
      expect(result.current.restarting).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("reports a rejected request and does not start recovery polling", async () => {
      mockFetch.mockResolvedValue({
        status: 409,
        ok: false,
        json: async () => ({ code: "RESTART_IN_PROGRESS" }),
      } as Response);

      const { result } = renderHook(() =>
        useApiStatus({ apiBase: API_BASE, adminToken: ADMIN_TOKEN }),
      );

      let outcome: string | undefined;
      await act(async () => {
        outcome = await result.current.triggerRestart();
      });

      expect(outcome).toBe("rejected");
      expect(result.current.restartState).toBe("rejected");
      expect(result.current.restarting).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("reports a server failure and does not start recovery polling", async () => {
      mockFetch.mockResolvedValue({
        status: 503,
        ok: false,
        json: async () => ({ error: "API restart is unavailable" }),
      } as Response);

      const { result } = renderHook(() =>
        useApiStatus({ apiBase: API_BASE, adminToken: ADMIN_TOKEN }),
      );

      let outcome: string | undefined;
      await act(async () => {
        outcome = await result.current.triggerRestart();
      });

      expect(outcome).toBe("server_failure");
      expect(result.current.restartState).toBe("server_failure");
      expect(result.current.restarting).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("requires the accepted restart contract before starting recovery polling", async () => {
      mockFetch.mockResolvedValue({
        status: 202,
        ok: true,
        json: async () => ({ restarting: false }),
      } as Response);

      const { result } = renderHook(() =>
        useApiStatus({ apiBase: API_BASE, adminToken: ADMIN_TOKEN }),
      );

      let outcome: string | undefined;
      await act(async () => {
        outcome = await result.current.triggerRestart();
      });

      expect(outcome).toBe("server_failure");
      expect(result.current.restartState).toBe("server_failure");
      expect(result.current.restarting).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("polls /healthz after restart and clears restarting when server is up", async () => {
      jest.useFakeTimers();

      let healthzCallCount = 0;
      mockFetch.mockImplementation((url) => {
        if (String(url).includes("/admin/restart")) {
          return Promise.resolve({ status: 202, ok: true, json: async () => ({ restarting: true }) } as Response);
        }
        // /healthz: reject twice, then succeed on the third attempt
        healthzCallCount++;
        if (healthzCallCount < 3) {
          return Promise.reject(new Error("Server restarting"));
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({ status: "ok" }),
        } as Response);
      });

      const { result } = renderHook(() =>
        useApiStatus({ apiBase: API_BASE, adminToken: ADMIN_TOKEN }),
      );

      let restartOutcome: Promise<string> | null = null;
      await act(async () => {
        restartOutcome = result.current.triggerRestart();
      });
      await flushMicrotasks();

      // First resumePoll (fails)
      await act(async () => { jest.advanceTimersByTime(1500); });
      await flushMicrotasks();
      expect(result.current.restarting).toBe(true);

      // Second resumePoll (fails)
      await act(async () => { jest.advanceTimersByTime(1500); });
      await flushMicrotasks();
      expect(result.current.restarting).toBe(true);

      // Third resumePoll (succeeds)
      await act(async () => { jest.advanceTimersByTime(1500); });
      await flushMicrotasks();

      expect(result.current.status).toBe("ok");
      expect(result.current.restarting).toBe(false);
      expect(await restartOutcome!).toBe("recovered");
    });

    it("does not announce recovery for an unrecognised healthz status", async () => {
      jest.useFakeTimers();

      // An unrecognised health status is not proof that the server recovered.
      // The next bounded recovery attempt returns a real healthy response.
      let healthzCallCount = 0;
      mockFetch.mockImplementation((url) => {
        if (String(url).includes("/admin/restart")) {
          return Promise.resolve({ status: 202, ok: true, json: async () => ({ restarting: true }) } as Response);
        }
        healthzCallCount++;
        const status = healthzCallCount === 1 ? "booting" : "ok";
        return Promise.resolve({
          ok: true,
          json: async () => ({ status }),
        } as Response);
      });

      const { result } = renderHook(() =>
        useApiStatus({ apiBase: API_BASE, adminToken: ADMIN_TOKEN }),
      );

      await act(async () => { result.current.triggerRestart(); });
      await flushMicrotasks();

      // First resumePoll fires but does not complete recovery.
      await act(async () => { jest.advanceTimersByTime(1500); });
      await flushMicrotasks();

      expect(result.current.status).toBe("unknown");
      expect(result.current.restarting).toBe(true);

      // Second resumePoll returns a valid health response.
      await act(async () => { jest.advanceTimersByTime(1500); });
      await flushMicrotasks();

      expect(result.current.status).toBe("ok");
      expect(result.current.restarting).toBe(false);
    });

    it("sets status='error' and restarting=false after max attempts are exhausted", async () => {
      jest.useFakeTimers();

      mockFetch.mockImplementation((url) => {
        if (String(url).includes("/admin/restart")) {
          return Promise.resolve({ status: 202, ok: true, json: async () => ({ restarting: true }) } as Response);
        }
        return Promise.reject(new Error("Server down"));
      });

      const { result } = renderHook(() =>
        useApiStatus({ apiBase: API_BASE, adminToken: ADMIN_TOKEN }),
      );

      await act(async () => { result.current.triggerRestart(); });
      await flushMicrotasks();

      // Exhaust all 20 attempts (1 500 ms each)
      for (let i = 0; i < 20; i++) {
        await act(async () => { jest.advanceTimersByTime(1500); });
        await flushMicrotasks();
      }

      expect(result.current.status).toBe("error");
      expect(result.current.restarting).toBe(false);
    });

    it("stops after a hanging restart POST timeout without starting recovery polling", async () => {
      jest.useFakeTimers();

      // The restart POST hangs forever — only resolves when its AbortSignal fires
      let restartAborted = false;
      mockFetch.mockImplementation((url, opts) => {
        if (String(url).includes("/admin/restart")) {
          return new Promise<Response>((_resolve, reject) => {
            const signal = (opts as RequestInit | undefined)?.signal;
            if (signal) {
              signal.addEventListener("abort", () => {
                restartAborted = true;
                reject(new DOMException("The operation was aborted.", "AbortError"));
              });
            }
          });
        }
        // A correct implementation never reaches /healthz after a timeout.
        throw new Error("unexpected recovery poll");
      });

      const { result } = renderHook(() =>
        useApiStatus({ apiBase: API_BASE, adminToken: ADMIN_TOKEN }),
      );

      // Fire triggerRestart — it will hang on the POST
      act(() => { result.current.triggerRestart(); });
      await flushMicrotasks();

      // Verify we are still stuck in "restarting" (POST hasn't resolved)
      expect(result.current.restarting).toBe(true);
      expect(restartAborted).toBe(false);

      // Advance past the 10 s POST timeout — the AbortController fires
      await act(async () => { jest.advanceTimersByTime(10_000); });
      await flushMicrotasks();

      // The POST was aborted
      expect(restartAborted).toBe(true);

      // Recovery polling must not begin after the request was not accepted.
      await act(async () => { jest.advanceTimersByTime(1500); });
      await flushMicrotasks();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.current.status).toBe("unknown");
      expect(result.current.restarting).toBe(false);
      expect(result.current.restartState).toBe("timeout");
    });

    it("cleans up an accepted restart when the hook unmounts before recovery", async () => {
      jest.useFakeTimers();

      mockFetch.mockResolvedValue({
        status: 202,
        ok: true,
        json: async () => ({ restarting: true }),
      } as Response);

      const { result, unmount } = renderHook(() =>
        useApiStatus({ apiBase: API_BASE, adminToken: ADMIN_TOKEN }),
      );

      await act(async () => {
        result.current.triggerRestart();
      });
      await flushMicrotasks();
      expect(result.current.restartState).toBe("recovering");

      unmount();
      await act(async () => { jest.advanceTimersByTime(30_000); });
      await flushMicrotasks();

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("exhausts max attempts when the server hangs (fetch timeout fires instead of rejecting)", async () => {
      jest.useFakeTimers();

      mockFetch.mockImplementation((url, opts) => {
        if (String(url).includes("/admin/restart")) {
          return Promise.resolve({ status: 202, ok: true, json: async () => ({ restarting: true }) } as Response);
        }
        // /healthz: hangs forever — only resolves when the AbortSignal fires
        return new Promise<Response>((_resolve, reject) => {
          const signal = (opts as RequestInit | undefined)?.signal;
          if (signal) {
            signal.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }
        });
      });

      const { result } = renderHook(() =>
        useApiStatus({ apiBase: API_BASE, adminToken: ADMIN_TOKEN }),
      );

      await act(async () => { result.current.triggerRestart(); });
      await flushMicrotasks();

      // Each attempt: 1 500 ms schedule delay + 5 000 ms fetch timeout = 6 500 ms
      for (let i = 0; i < 20; i++) {
        // Trigger the resumePoll setTimeout (1 500 ms)
        await act(async () => { jest.advanceTimersByTime(1500); });
        await flushMicrotasks();
        // Trigger the AbortController timeout (5 000 ms), which aborts the hanging fetch
        await act(async () => { jest.advanceTimersByTime(5000); });
        await flushMicrotasks();
      }

      expect(result.current.status).toBe("error");
      expect(result.current.restarting).toBe(false);
    });

    it("reports authorization when adminToken is null", async () => {
      const { result } = renderHook(() =>
        useApiStatus({ apiBase: API_BASE, adminToken: null }),
      );

      let outcome: string | undefined;
      await act(async () => {
        outcome = await result.current.triggerRestart();
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.current.restarting).toBe(false);
      expect(result.current.status).toBe("unknown");
      expect(result.current.restartState).toBe("authorization");
      expect(outcome).toBe("authorization");
    });

    it("ignores a second concurrent triggerRestart call while one is already in progress", async () => {
      jest.useFakeTimers();

      let restartCallCount = 0;
      mockFetch.mockImplementation((url) => {
        if (String(url).includes("/admin/restart")) {
          restartCallCount++;
          return Promise.resolve({ status: 202, ok: true, json: async () => ({ restarting: true }) } as Response);
        }
        return new Promise(() => {});
      });

      const { result } = renderHook(() =>
        useApiStatus({ apiBase: API_BASE, adminToken: ADMIN_TOKEN }),
      );

      await act(async () => { result.current.triggerRestart(); });
      await act(async () => { result.current.triggerRestart(); });
      await flushMicrotasks();

      expect(restartCallCount).toBe(1);
    });
  });
});
