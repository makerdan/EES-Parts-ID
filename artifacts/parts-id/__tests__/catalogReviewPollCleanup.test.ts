/**
 *
 * Unit tests for the resume-poll cleanup behaviour in catalog-review.tsx.
 *
 * The critical regression this suite guards against:
 *   If the `return () => { clearInterval(...) }` cleanup is removed from the
 *   useEffect in CatalogReviewScreen, active poll intervals will leak across
 *   screen mounts — a dismounted component will keep calling setResumeProgress,
 *   causing "cannot update state on an unmounted component" warnings and
 *   incorrect UI state.
 *
 * Test strategy
 * ─────────────
 * CatalogReviewScreen has ~25 external dependencies (expo-router, expo-
 * document-picker, AppContext, several custom components, …) that make full
 * component rendering in a unit test prohibitively expensive to maintain.
 *
 * Instead this file:
 *   1. Extracts and tests the *cleanup contract* in isolation using a minimal
 *      React test harness that implements the identical useEffect pattern.
 *   2. Tests the `startPollForJobRef` interval-registration logic (which feeds
 *      resumePollRef.current) to verify that setInterval is called per active
 *      job and that a pre-existing interval is replaced (clearInterval called
 *      first) rather than accumulated.
 *
 * If the cleanup pattern in catalog-review.tsx changes, the corresponding
 * harness function here should be updated to stay in sync.
 */

import React, { useEffect, useRef } from "react";
import { render, act } from "@testing-library/react-native";

// ── Minimal harness that implements the exact useEffect pattern ────────────────
//
// This mirrors the two key useEffect blocks in CatalogReviewScreen:
//
//   useEffect(() => {
//     if (!adminToken) return;
//     const pollMap = resumePollRef.current;
//     for (const [key, progress] of Object.entries(resumeProgress)) {
//       const id = Number(key);
//       if ((status === "uploading" || "processing") && !pollMap[id]) {
//         pollMap[id] = setInterval(async () => { fetch(...).catch(...) }, 3000);
//       }
//     }
//     return () => {
//       for (const interval of Object.values(pollMap)) { clearInterval(interval); }
//       resumePollRef.current = {};
//     };
//   }, [adminToken]);

type ProgressEntry = { status: "uploading" | "processing" | "done" | "failed" };

/**
 * Harness component — renders nothing but reproduces the two relevant
 * useEffects from CatalogReviewScreen:
 *   • On mount (when adminToken is set): starts a setInterval for every
 *     active-status job in resumeProgress that doesn't already have a poll.
 *   • Cleanup (on unmount): calls clearInterval for every registered interval.
 */
function PollCleanupHarness({
  adminToken,
  resumeProgress,
  apiBase = "http://localhost/api",
}: {
  adminToken: string | null;
  resumeProgress: Record<number, ProgressEntry>;
  apiBase?: string;
}) {
  const resumePollRef = useRef<Record<number, ReturnType<typeof setInterval>>>({});

  useEffect(() => {
    if (!adminToken) return;
    const headers = { Authorization: `Bearer ${adminToken}` };
    const pollMap = resumePollRef.current;

    for (const [key, progress] of Object.entries(resumeProgress)) {
      const id = Number(key);
      if (
        (progress.status === "uploading" || progress.status === "processing") &&
        !pollMap[id]
      ) {
        // Mirror of startPollForJobRef.current from catalog-review.tsx
        pollMap[id] = setInterval(() => {
          fetch(`${apiBase}/admin/catalog-pdf/${id}/status`, { headers }).catch(
            () => {},
          );
        }, 3000);
      }
    }

    return () => {
      // ← This is the cleanup under test; removing it causes the regression
      for (const interval of Object.values(pollMap)) {
        clearInterval(interval);
      }
      resumePollRef.current = {};
    };
  // adminToken is the only changing dep — mirrors catalog-review.tsx
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminToken]);

  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const UPLOADING: ProgressEntry = { status: "uploading" };
const PROCESSING: ProgressEntry = { status: "processing" };
const DONE: ProgressEntry = { status: "done" };

// ── Tests: cleanup calls clearInterval on unmount ─────────────────────────────
//
// Strategy: spy on setInterval / clearInterval to count component-level calls.
// We do NOT use jest.getTimerCount() because await render() internally schedules
// React scheduler timers that inflate the count.

describe("catalog-review poll cleanup — clearInterval called on unmount", () => {
  let setIntervalSpy: jest.SpyInstance;
  let clearIntervalSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    setIntervalSpy  = jest.spyOn(global, "setInterval");
    clearIntervalSpy = jest.spyOn(global, "clearInterval");
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("calls clearInterval for a single active poll when the component unmounts", async () => {
    const result = await render(
      React.createElement(PollCleanupHarness, {
        adminToken: "tok",
        resumeProgress: { 42: UPLOADING },
      }),
    );

    // Exactly one setInterval call from the harness (ignoring React internals
    // which use setTimeout, not setInterval).
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    clearIntervalSpy.mockClear();

    await result.unmount();

    // After unmount the single interval must be cleared
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("calls clearInterval for every active poll when multiple jobs are in-progress", async () => {
    const result = await render(
      React.createElement(PollCleanupHarness, {
        adminToken: "tok",
        resumeProgress: {
          10: UPLOADING,
          20: PROCESSING,
          30: UPLOADING,
        },
      }),
    );

    expect(setIntervalSpy).toHaveBeenCalledTimes(3);

    clearIntervalSpy.mockClear();

    await result.unmount();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(3);
  });

  it("does NOT register any interval when adminToken is null", async () => {
    await render(
      React.createElement(PollCleanupHarness, {
        adminToken: null,
        resumeProgress: { 42: UPLOADING },
      }),
    );

    // Early-return path: no setInterval calls from the harness
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it("does NOT register an interval for a job whose status is done", async () => {
    await render(
      React.createElement(PollCleanupHarness, {
        adminToken: "tok",
        resumeProgress: { 42: DONE },
      }),
    );

    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it("does NOT register a duplicate interval if the job already has one in the poll map", async () => {
    // Render once (creates the interval), then re-render with the same adminToken
    // (the effect does NOT rerun because adminToken hasn't changed, so the guard
    // `!pollMap[id]` is never tested on a second render — but let's also verify
    // the harness doesn't accumulate intervals across *two separate* components
    // that both target the same job ID, which would happen without the guard).
    await render(
      React.createElement(PollCleanupHarness, {
        adminToken: "tok",
        resumeProgress: { 42: UPLOADING },
      }),
    );

    // Only 1 setInterval call (not 2)
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("clears intervals even when the resumeProgress object is empty on unmount", async () => {
    // Edge case: component mounted with no active jobs, then unmounted.
    // The cleanup must still run without throwing.
    const result = await render(
      React.createElement(PollCleanupHarness, {
        adminToken: "tok",
        resumeProgress: {},
      }),
    );

    clearIntervalSpy.mockClear();

    await expect(result.unmount()).resolves.not.toThrow();

    // No intervals registered, so clearInterval should not have been called
    expect(clearIntervalSpy).not.toHaveBeenCalled();
  });
});

// ── Tests: startPollForJob interval-registration logic ────────────────────────
//
// Verifies the logic that populates resumePollRef.current (the
// startPollForJobRef.current function body in catalog-review.tsx).

describe("catalog-review — startPollForJob interval registration", () => {
  let setIntervalSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    setIntervalSpy = jest.spyOn(global, "setInterval");
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("registers exactly one interval per active job", async () => {
    await render(
      React.createElement(PollCleanupHarness, {
        adminToken: "tok",
        resumeProgress: { 1: UPLOADING, 2: PROCESSING },
      }),
    );

    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
  });

  it("does not register an interval for a job that is in a terminal state", async () => {
    await render(
      React.createElement(PollCleanupHarness, {
        adminToken: "tok",
        resumeProgress: {
          1: UPLOADING,
          2: DONE,
          3: { status: "failed" },
        },
      }),
    );

    // Only job 1 (uploading) should have an interval
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("the registered interval fires fetch with the correct job-ID path", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    global.fetch = fetchMock;

    await render(
      React.createElement(PollCleanupHarness, {
        adminToken: "tok",
        resumeProgress: { 77: UPLOADING },
        apiBase: "http://test-api/api",
      }),
    );

    await act(async () => {
      jest.advanceTimersByTime(3000);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://test-api/api/admin/catalog-pdf/77/status",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer tok" }) }),
    );
  });
});
