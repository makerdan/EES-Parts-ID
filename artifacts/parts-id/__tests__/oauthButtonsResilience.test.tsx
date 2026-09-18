/**
 * OAuthButtons resilience tests (F-046).
 *
 * Covers:
 * - Shared oauthLoading flag disables both provider buttons while one flow is active
 * - 60-second timeout clears the loading flag and surfaces an error message
 * - Per-attempt token prevents a stale completion from overwriting a newer attempt
 *
 * Strategy: OAuthButtons renders text labels when idle and ActivityIndicator when loading.
 * We use RTLRN's queryByText to detect state (label visible ↔ idle; label absent ↔ loading)
 * and fireEvent.press on the label text (RTLRN bubbles to the enclosing Pressable's onPress).
 */

// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

// ── expo-router ─────────────────────────────────────────────────────────────
const mockReplace = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

// ── expo-auth-session ───────────────────────────────────────────────────────
jest.mock("expo-auth-session", () => ({
  makeRedirectUri: jest.fn(() => "myapp://redirect"),
}));

// ── @clerk/expo ──────────────────────────────────────────────────────────────
// Platform.OS is "ios" in the RN mock, so the native path (startSSOFlow) runs.
const mockStartSSOFlow = jest.fn();

jest.mock("@clerk/expo", () => ({
  useSSO: () => ({ startSSOFlow: mockStartSSOFlow }),
  useClerk: () => ({ client: null }),
}));

// ── @/contexts/AppContext ────────────────────────────────────────────────────
const mockShowToast = jest.fn();
jest.mock("@/contexts/AppContext", () => ({
  useApp: () => ({ showToast: mockShowToast }),
}));

// ── @/hooks/useColors ────────────────────────────────────────────────────────
jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    foreground: "#000",
    background: "#fff",
    card: "#fff",
    border: "#ccc",
    primary: "#3b82f6",
    primaryForeground: "#fff",
    mutedForeground: "#64748b",
    destructive: "#ef4444",
    accentForeground: "#000",
    accent: "#f1f5f9",
    radius: 8,
  }),
}));

import React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";

import { OAuthButtons } from "@/components/OAuthButtons";

// ── Helpers ──────────────────────────────────────────────────────────────────

const flushMicrotasks = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

type RenderResult = Awaited<ReturnType<typeof render>>;

// True when the label text is NOT visible (meaning the ActivityIndicator
// replaced it — i.e. that button is in its loading state).
function isButtonLoading(result: RenderResult, label: string): boolean {
  return result.queryByText(label) === null;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
  mockReplace.mockClear();
  mockStartSSOFlow.mockReset();
  mockShowToast.mockClear();
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("OAuthButtons — shared loading flag (F-046)", () => {
  it("disables both provider buttons while a Google OAuth flow is in flight", async () => {
    // startSSOFlow hangs forever — simulates a slow OAuth flow
    mockStartSSOFlow.mockReturnValue(new Promise(() => {}));

    const result = await render(<OAuthButtons mode="sign-in" />);
    await flushMicrotasks();

    // Both labels visible → both idle
    expect(isButtonLoading(result, "Continue with Google")).toBe(false);
    expect(isButtonLoading(result, "Continue with Apple")).toBe(false);

    // Press Google — RTLRN bubbles press up to the enclosing Pressable
    await act(async () => {
      fireEvent.press(result.getByText("Continue with Google"));
    });
    await flushMicrotasks();

    // Both labels replaced by ActivityIndicator → both buttons in loading state
    expect(isButtonLoading(result, "Continue with Google")).toBe(true);
    expect(isButtonLoading(result, "Continue with Apple")).toBe(true);
  });

  it("re-enables buttons and shows a timeout error after 60 seconds", async () => {
    mockStartSSOFlow.mockReturnValue(new Promise(() => {}));

    const result = await render(<OAuthButtons mode="sign-in" />);
    await flushMicrotasks();

    // Kick off Google flow
    await act(async () => {
      fireEvent.press(result.getByText("Continue with Google"));
    });
    await flushMicrotasks();

    // In-flight — both labels hidden
    expect(isButtonLoading(result, "Continue with Google")).toBe(true);
    expect(isButtonLoading(result, "Continue with Apple")).toBe(true);

    // Advance past 60s timeout
    await act(async () => { jest.advanceTimersByTime(60_000); });
    await flushMicrotasks();

    // Labels visible again — loading cleared
    expect(isButtonLoading(result, "Continue with Google")).toBe(false);
    expect(isButtonLoading(result, "Continue with Apple")).toBe(false);

    // Timeout error message shown inline
    expect(result.queryByText("Sign-in timed out. Please try again.")).toBeTruthy();

    // showToast called so the error survives navigation to sign-up/login
    expect(mockShowToast).toHaveBeenCalledWith(
      "Sign-in timed out. Please try again.",
      "error",
    );
  });

  it("shows a toast when the provider flow throws an error, so the message survives navigation", async () => {
    // startSSOFlow rejects with a non-cancel error
    mockStartSSOFlow.mockRejectedValue(new Error("Network request failed"));

    const result = await render(<OAuthButtons mode="sign-in" />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.press(result.getByText("Continue with Google"));
    });
    await flushMicrotasks();

    // Inline error shown
    expect(result.queryByText("Google sign-in failed. Please try again.")).toBeTruthy();

    // Toast fired so the message persists if the user navigates to sign-up
    expect(mockShowToast).toHaveBeenCalledWith(
      "Google sign-in failed. Please try again.",
      "error",
    );
  });

  it("stale attempt settling after timeout does not clear a new in-flight attempt", async () => {
    // First attempt: controllable — we decide when it resolves
    let resolveFirst!: (v: unknown) => void;
    mockStartSSOFlow.mockReturnValueOnce(
      new Promise<unknown>((res) => { resolveFirst = res; }),
    );

    const result = await render(<OAuthButtons mode="sign-in" />);
    await flushMicrotasks();

    // Start first (Google) attempt
    await act(async () => {
      fireEvent.press(result.getByText("Continue with Google"));
    });
    await flushMicrotasks();

    // Advance 60s → timeout fires, buttons re-enabled
    await act(async () => { jest.advanceTimersByTime(60_000); });
    await flushMicrotasks();

    // Buttons re-enabled after timeout
    expect(isButtonLoading(result, "Continue with Google")).toBe(false);
    expect(isButtonLoading(result, "Continue with Apple")).toBe(false);

    // Start a second (Apple) attempt — hangs indefinitely
    mockStartSSOFlow.mockReturnValue(new Promise(() => {}));
    await act(async () => {
      fireEvent.press(result.getByText("Continue with Apple"));
    });
    await flushMicrotasks();

    // Second attempt in flight — both labels hidden
    expect(isButtonLoading(result, "Continue with Apple")).toBe(true);

    // First (stale) attempt resolves — per-attempt token must block it from
    // interfering with the second attempt's lock on the loading state.
    await act(async () => {
      resolveFirst({ createdSessionId: null, setActive: jest.fn() });
    });
    await flushMicrotasks();

    // Apple flow still running — label must still be hidden
    expect(isButtonLoading(result, "Continue with Apple")).toBe(true);
  });
});
