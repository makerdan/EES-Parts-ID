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
 *  - triggerRestart maps unrecognised healthz status to "ok" after restart
 *  - triggerRestart falls back to status="error" after max attempts
 *  - triggerRestart is a no-op when adminToken is null
 *  - second concurrent triggerRestart call is ignored while one is in progress
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

  // ── triggerRestart ─────────────────────────────────────────────────────────

  describe("triggerRestart", () => {
    it("immediately sets restarting=true and status='unknown'", async () => {
      jest.useFakeTimers();

      mockFetch.mockImplementation((url) => {
        if (String(url).includes("/admin/restart")) {
          return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
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
          return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
        }
        return new Promise(() => {});
      });

      const { result } = renderHook(() =>
        useApiStatus({ apiBase: API_BASE, adminToken: ADMIN_TOKEN }),
      );

      await act(async () => { result.current.triggerRestart(); });
      await flushMicrotasks();

      expect(mockFetch).toHaveBeenCalledWith(`${API_BASE}/admin/restart`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
    });

    it("polls /healthz after restart and clears restarting when server is up", async () => {
      jest.useFakeTimers();

      let healthzCallCount = 0;
      mockFetch.mockImplementation((url) => {
        if (String(url).includes("/admin/restart")) {
          return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
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

      await act(async () => { result.current.triggerRestart(); });
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
    });

    it("maps an unrecognised healthz status to 'ok' after a successful restart", async () => {
      jest.useFakeTimers();

      // resumePoll returns an unrecognised status ("booting") — the hook maps
      // that to "ok" (the safe default).  Subsequent polling from startPolling()
      // returns a normal "ok" so the status stays "ok".
      let healthzCallCount = 0;
      mockFetch.mockImplementation((url) => {
        if (String(url).includes("/admin/restart")) {
          return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
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

      // First resumePoll fires (gets "booting" → mapped to "ok")
      await act(async () => { jest.advanceTimersByTime(1500); });
      await flushMicrotasks();

      expect(result.current.status).toBe("ok");
      expect(result.current.restarting).toBe(false);
    });

    it("sets status='error' and restarting=false after max attempts are exhausted", async () => {
      jest.useFakeTimers();

      mockFetch.mockImplementation((url) => {
        if (String(url).includes("/admin/restart")) {
          return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
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

    it("is a no-op when adminToken is null", async () => {
      const { result } = renderHook(() =>
        useApiStatus({ apiBase: API_BASE, adminToken: null }),
      );

      await act(async () => {
        await result.current.triggerRestart();
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.current.restarting).toBe(false);
      expect(result.current.status).toBe("unknown");
    });

    it("ignores a second concurrent triggerRestart call while one is already in progress", async () => {
      jest.useFakeTimers();

      let restartCallCount = 0;
      mockFetch.mockImplementation((url) => {
        if (String(url).includes("/admin/restart")) {
          restartCallCount++;
          return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
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
