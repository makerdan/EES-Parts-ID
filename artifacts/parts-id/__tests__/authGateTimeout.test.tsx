/**
 * AuthGate timeout tests (F-048).
 *
 * Covers:
 * - Shows a "Taking too long" error card after 15s when clerkLoaded stays false
 * - Shows the error card after 15s when approval status stays idle/loading
 * - "Try again" navigates to /login when Clerk itself never loaded
 * - "Try again" calls recheckApprovalStatus (not /login) when Clerk is loaded
 *   but approval status is stuck
 * - Timer is cancelled and card is not shown if loading resolves within 15s
 *
 * AuthGate initially renders null (no visible content). After the 15s timeout it
 * renders an overlay card. We use RTLRN's tree-wide queries (queryByText,
 * getByText, fireEvent) rather than result.root.queryAll so they work correctly
 * whether the component renders null or non-null content.
 */

// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

// ── expo-router ──────────────────────────────────────────────────────────────
const mockReplace = jest.fn();
const mockUseSegments = jest.fn<string[], []>(() => []);
jest.mock("expo-router", () => ({
  useSegments: () => mockUseSegments(),
  useRouter: () => ({ replace: mockReplace }),
}));

// ── @clerk/expo ──────────────────────────────────────────────────────────────
const mockUseAuth = jest.fn(() => ({
  isSignedIn: false,
  isLoaded: false, // not loaded → triggers 15s timer
  getToken: jest.fn(),
}));
jest.mock("@clerk/expo", () => ({
  useAuth: () => mockUseAuth(),
}));

// ── @/contexts/AppContext ────────────────────────────────────────────────────
const mockRecheckApprovalStatus = jest.fn(() => Promise.resolve());
const mockUseApp = jest.fn(() => ({
  approvalStatus: "idle" as string,
  recheckApprovalStatus: mockRecheckApprovalStatus,
  settings: {},
  updateSetting: jest.fn(),
}));
jest.mock("@/contexts/AppContext", () => ({
  useApp: () => mockUseApp(),
}));

import React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";

import { AuthGate } from "@/components/AuthGate";

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
  mockReplace.mockClear();
  mockRecheckApprovalStatus.mockClear();
  mockUseSegments.mockReturnValue([]);
  // Default: Clerk not loaded → timer should start
  mockUseAuth.mockReturnValue({ isSignedIn: false, isLoaded: false, getToken: jest.fn() });
  mockUseApp.mockReturnValue({
    approvalStatus: "idle",
    recheckApprovalStatus: mockRecheckApprovalStatus,
    settings: {},
    updateSetting: jest.fn(),
  });
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("AuthGate — 15-second load timeout (F-048)", () => {
  it("shows the timeout error card after 15s when clerkLoaded is false", async () => {
    const result = await render(<AuthGate />);
    await flushMicrotasks();

    // No error card yet — still within the 15s window
    expect(result.queryByText(/Taking too long/)).toBeNull();

    // Advance past 15s
    await act(async () => { jest.advanceTimersByTime(15_000); });
    await flushMicrotasks();

    expect(result.queryByText("Taking too long to load")).toBeTruthy();
  });

  it("shows the timeout error card after 15s when approvalStatus stays loading", async () => {
    mockUseAuth.mockReturnValue({ isSignedIn: true, isLoaded: true, getToken: jest.fn() });
    mockUseApp.mockReturnValue({
      approvalStatus: "loading",
      recheckApprovalStatus: mockRecheckApprovalStatus,
      settings: {},
      updateSetting: jest.fn(),
    });

    const result = await render(<AuthGate />);
    await flushMicrotasks();

    expect(result.queryByText(/Taking too long/)).toBeNull();

    await act(async () => { jest.advanceTimersByTime(15_000); });
    await flushMicrotasks();

    expect(result.queryByText("Taking too long to load")).toBeTruthy();
  });

  it("does NOT show the timeout card if Clerk loads within 15s", async () => {
    const result = await render(<AuthGate />);
    await flushMicrotasks();

    // Clerk becomes available before the 15s window expires
    mockUseAuth.mockReturnValue({ isSignedIn: false, isLoaded: true, getToken: jest.fn() });
    await result.rerender(<AuthGate />);
    await flushMicrotasks();

    // Advance just past what would have been the timeout window
    await act(async () => { jest.advanceTimersByTime(15_000); });
    await flushMicrotasks();

    // Timer was cancelled when clerkLoaded flipped — card must NOT appear
    expect(result.queryByText(/Taking too long/)).toBeNull();
  });

  it("Try again navigates to /login when Clerk itself never loaded", async () => {
    // clerkLoaded stays false
    const result = await render(<AuthGate />);
    await flushMicrotasks();

    await act(async () => { jest.advanceTimersByTime(15_000); });
    await flushMicrotasks();

    // "Try again" button is visible — press it
    const btn = result.getByText("Try again");
    await act(async () => { fireEvent.press(btn); });
    await flushMicrotasks();

    // Clerk never loaded → only real recovery is returning to /login
    expect(mockReplace).toHaveBeenCalledWith({ pathname: "/login" });
    expect(mockRecheckApprovalStatus).not.toHaveBeenCalled();
  });

  it("Try again calls recheckApprovalStatus when Clerk loaded but approval is stuck", async () => {
    mockUseAuth.mockReturnValue({ isSignedIn: true, isLoaded: true, getToken: jest.fn() });
    mockUseApp.mockReturnValue({
      approvalStatus: "loading",
      recheckApprovalStatus: mockRecheckApprovalStatus,
      settings: {},
      updateSetting: jest.fn(),
    });

    const result = await render(<AuthGate />);
    await flushMicrotasks();

    await act(async () => { jest.advanceTimersByTime(15_000); });
    await flushMicrotasks();

    const btn = result.getByText("Try again");
    await act(async () => { fireEvent.press(btn); });
    await flushMicrotasks();

    expect(mockRecheckApprovalStatus).toHaveBeenCalled();
    // Clerk is fine — must NOT navigate to /login
    expect(mockReplace).not.toHaveBeenCalledWith({ pathname: "/login" });
  });
});
