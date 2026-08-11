/**
 * sso-callback resilience tests (F-047).
 *
 * Covers:
 * - Renders an immediate error when the URL has no OAuth params (code/state)
 * - Shows a timeout error after 30s when handleRedirectCallback never resolves
 */

// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

// ── react-native — override Platform.OS to "web" so the useEffect actually runs
jest.mock("react-native", () => {
  const make = (tag: string) =>
    function RNMock({ children, ...props }: Record<string, unknown>) {
      const React = require("react");
      return React.createElement(tag, props, children);
    };
  return {
    View: make("rn-view"),
    Text: make("Text"),
    Pressable: make("rn-pressable"),
    ActivityIndicator: make("rn-activity"),
    StyleSheet: {
      create: (s: unknown) => s,
      hairlineWidth: 0.5,
      flatten: (s: unknown) => s,
      absoluteFill: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
      absoluteFillObject: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
    },
    Platform: {
      OS: "web",
      select: (opts: Record<string, unknown>) =>
        opts.web !== undefined ? opts.web : opts.default,
    },
  };
});

// ── expo-router ─────────────────────────────────────────────────────────────
const mockReplace = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

// ── @clerk/expo ──────────────────────────────────────────────────────────────
const mockHandleRedirectCallback = jest.fn();
jest.mock("@clerk/expo", () => ({
  useClerk: () => ({ handleRedirectCallback: mockHandleRedirectCallback }),
}));

// ── @/hooks/useColors ────────────────────────────────────────────────────────
jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#fff",
    foreground: "#000",
    primary: "#3b82f6",
    primaryForeground: "#fff",
    mutedForeground: "#64748b",
  }),
}));

import React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";

import SsoCallback from "@/app/sso-callback";

// ── Helpers ──────────────────────────────────────────────────────────────────

const flushMicrotasks = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

// Snapshot the original global.window so we can restore it
const originalWindow = (global as Record<string, unknown>).window;

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
  mockReplace.mockClear();
  mockHandleRedirectCallback.mockReset();
});

afterEach(() => {
  (global as Record<string, unknown>).window = originalWindow;
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SsoCallback — missing OAuth params (F-047)", () => {
  it("renders an immediate error when URL has no code or state param", async () => {
    (global as Record<string, unknown>).window = { location: { search: "" } };

    const result = await render(<SsoCallback />);
    await flushMicrotasks();

    // handleRedirectCallback must NOT have been called
    expect(mockHandleRedirectCallback).not.toHaveBeenCalled();

    // Error card shown immediately — use RTLRN tree-wide queries
    expect(result.queryByText("Sign-in link invalid")).toBeTruthy();
    expect(result.queryByText(/go back and try again/i)).toBeTruthy();
  });

  it("renders an error immediately when only unrelated params are present", async () => {
    (global as Record<string, unknown>).window = {
      location: { search: "?foo=bar&baz=qux" },
    };

    const result = await render(<SsoCallback />);
    await flushMicrotasks();

    expect(mockHandleRedirectCallback).not.toHaveBeenCalled();
    expect(result.queryByText("Sign-in link invalid")).toBeTruthy();
  });

  it("navigates to /login when the Go back button is pressed", async () => {
    (global as Record<string, unknown>).window = { location: { search: "" } };

    const result = await render(<SsoCallback />);
    await flushMicrotasks();

    // Error card is shown — press the "Go back to sign-in" button
    const btn = result.getByText("Go back to sign-in");
    await act(async () => { fireEvent.press(btn); });
    await flushMicrotasks();

    expect(mockReplace).toHaveBeenCalledWith({ pathname: "/login" });
  });
});

describe("SsoCallback — 30-second callback timeout (F-047)", () => {
  it("shows timeout error after 30s when handleRedirectCallback never resolves", async () => {
    // Params are present so the effect proceeds to handleRedirectCallback
    (global as Record<string, unknown>).window = {
      location: { search: "?code=abc&state=xyz" },
    };

    // handleRedirectCallback hangs forever
    mockHandleRedirectCallback.mockReturnValue(new Promise(() => {}));

    const result = await render(<SsoCallback />);
    await flushMicrotasks();

    // handleRedirectCallback was called
    expect(mockHandleRedirectCallback).toHaveBeenCalled();

    // No timeout error yet
    expect(result.queryByText("Sign-in taking too long")).toBeNull();

    // Advance past the 30s timeout
    await act(async () => { jest.advanceTimersByTime(30_000); });
    await flushMicrotasks();

    // Timeout error card shown
    expect(result.queryByText("Sign-in taking too long")).toBeTruthy();
    expect(result.queryByText(/go back and try again/i)).toBeTruthy();
  });

  it("does NOT show timeout error if handleRedirectCallback resolves before 30s", async () => {
    (global as Record<string, unknown>).window = {
      location: { search: "?code=abc&state=xyz" },
    };

    // Resolves quickly via the navigate callback
    mockHandleRedirectCallback.mockImplementation(
      (_opts: unknown, navigate: (to: string) => Promise<void>) => {
        navigate("/");
        return Promise.resolve();
      },
    );

    const result = await render(<SsoCallback />);
    await flushMicrotasks();

    // Advance less than 30s
    await act(async () => { jest.advanceTimersByTime(10_000); });
    await flushMicrotasks();

    expect(result.queryByText("Sign-in taking too long")).toBeNull();
  });
});
