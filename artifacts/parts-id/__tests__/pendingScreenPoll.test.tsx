/**
 * PendingScreen polling tests (F-049).
 *
 * Covers:
 * - An approval check fires immediately on mount (not after the first 30s delay)
 * - The in-flight guard prevents concurrent poll calls
 * - Periodic polling continues every 30s after the initial immediate check
 */

// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

// ── @/hooks/useColors ────────────────────────────────────────────────────────
jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#fff",
    foreground: "#000",
    card: "#fff",
    border: "#ccc",
    primary: "#3b82f6",
    primaryForeground: "#fff",
    mutedForeground: "#64748b",
    accentForeground: "#000",
    accent: "#f1f5f9",
    destructive: "#ef4444",
    radius: 8,
  }),
}));

// ── @/contexts/AppContext ────────────────────────────────────────────────────
const mockRecheckApprovalStatus = jest.fn(() => Promise.resolve());
const mockLogout = jest.fn(() => Promise.resolve());
const mockUseApp = jest.fn();

jest.mock("@/contexts/AppContext", () => ({
  useApp: () => mockUseApp(),
}));

import React from "react";
import { act, render } from "@testing-library/react-native";

import PendingScreen from "@/app/pending";

// ── Helpers ──────────────────────────────────────────────────────────────────

const flushMicrotasks = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
  mockRecheckApprovalStatus.mockReset().mockResolvedValue(undefined);
  mockLogout.mockReset().mockResolvedValue(undefined);
  mockUseApp.mockReturnValue({
    approvalStatus: "pending",
    recheckApprovalStatus: mockRecheckApprovalStatus,
    logout: mockLogout,
    settings: {},
    updateSetting: jest.fn(),
  });
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PendingScreen — immediate poll on mount (F-049)", () => {
  it("calls recheckApprovalStatus once immediately on mount without waiting 30s", async () => {
    await render(<PendingScreen />);
    await flushMicrotasks();

    // Should have been called once immediately — before any timer fires
    expect(mockRecheckApprovalStatus).toHaveBeenCalledTimes(1);
  });

  it("does not fire a second poll before the 30s interval elapses", async () => {
    await render(<PendingScreen />);
    await flushMicrotasks();

    // Advance just under one interval
    await act(async () => { jest.advanceTimersByTime(29_999); });
    await flushMicrotasks();

    // Still only the initial immediate check
    expect(mockRecheckApprovalStatus).toHaveBeenCalledTimes(1);
  });

  it("fires a second poll at the 30s interval mark", async () => {
    await render(<PendingScreen />);
    await flushMicrotasks();

    // Immediate check: 1 call
    expect(mockRecheckApprovalStatus).toHaveBeenCalledTimes(1);

    // Advance one full interval
    await act(async () => { jest.advanceTimersByTime(30_000); });
    await flushMicrotasks();

    // Periodic poll fires: 2 calls total
    expect(mockRecheckApprovalStatus).toHaveBeenCalledTimes(2);
  });
});

describe("PendingScreen — in-flight overlap guard (F-049)", () => {
  it("does not fire a concurrent poll when a previous one is still in flight", async () => {
    // First call hangs — never resolves
    let resolveFirst!: () => void;
    mockRecheckApprovalStatus
      .mockReturnValueOnce(new Promise<void>((res) => { resolveFirst = res; }))
      .mockResolvedValue(undefined);

    await render(<PendingScreen />);
    await flushMicrotasks();

    // Initial check in flight (first call, never resolved)
    expect(mockRecheckApprovalStatus).toHaveBeenCalledTimes(1);

    // Advance one interval — interval fires, but in-flight guard must block it
    await act(async () => { jest.advanceTimersByTime(30_000); });
    await flushMicrotasks();

    // Still only 1 call — overlap blocked
    expect(mockRecheckApprovalStatus).toHaveBeenCalledTimes(1);

    // Resolve the first in-flight call
    await act(async () => { resolveFirst(); });
    await flushMicrotasks();

    // Now the guard is clear — next interval fires normally
    await act(async () => { jest.advanceTimersByTime(30_000); });
    await flushMicrotasks();

    expect(mockRecheckApprovalStatus).toHaveBeenCalledTimes(2);
  });
});
