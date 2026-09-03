/**
 * Auth screen resilience tests.
 *
 * Covers the user-visible recovery paths for:
 * - password sign-in and sign-in finalization errors
 * - invalid/expired sign-up verification codes
 * - verification code send/resend failures
 * - banned-screen logout failures
 */

// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

// ── expo-router ──────────────────────────────────────────────────────────────
const mockReplace = jest.fn();
jest.mock("expo-router", () => ({
  Link: ({ children }: { children: unknown }) => {
    const React = require("react");
    return React.createElement(React.Fragment, null, children);
  },
  useRouter: () => ({ replace: mockReplace }),
}));

// ── @clerk/expo ──────────────────────────────────────────────────────────────
const mockSignInPassword = jest.fn();
const mockSignInFinalize = jest.fn();
const mockSignIn = {
  password: mockSignInPassword,
  finalize: mockSignInFinalize,
  status: "idle" as string,
};
const mockUseSignIn = jest.fn();

const mockSignUpPassword = jest.fn();
const mockSendEmailCode = jest.fn();
const mockVerifyEmailCode = jest.fn();
const mockSignUpFinalize = jest.fn();
const mockSignUp = {
  password: mockSignUpPassword,
  finalize: mockSignUpFinalize,
  status: "idle" as string,
  unverifiedFields: [] as string[],
  missingFields: [] as string[],
  verifications: {
    sendEmailCode: mockSendEmailCode,
    verifyEmailCode: mockVerifyEmailCode,
  },
};
const mockUseSignUp = jest.fn();

jest.mock("@clerk/expo", () => ({
  useSignIn: () => mockUseSignIn(),
  useSignUp: () => mockUseSignUp(),
}));

// ── @/contexts/AppContext ────────────────────────────────────────────────────
const mockLogout = jest.fn();
const mockShowToast = jest.fn();
const mockUseApp = jest.fn();

jest.mock("@/contexts/AppContext", () => ({
  useApp: () => mockUseApp(),
}));

// ── @/components/OAuthButtons ────────────────────────────────────────────────
jest.mock("@/components/OAuthButtons", () => ({
  OAuthButtons: () => null,
}));

// ── @/hooks/useColors ────────────────────────────────────────────────────────
jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#fff",
    foreground: "#000",
    card: "#fff",
    border: "#ccc",
    input: "#ccc",
    muted: "#f8fafc",
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
import { act, render } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";

import BannedScreen from "@/app/banned";
import LoginScreen from "@/app/login";
import SignUpScreen from "@/app/sign-up";

// ── Helpers ──────────────────────────────────────────────────────────────────

type RenderResult = Awaited<ReturnType<typeof render>>;

function findTextInput(result: RenderResult, placeholder: string): TestInstance {
  const input = result.root!
    .queryAll(
      (node: TestInstance) =>
        (node.type as string) === "rn-text-input" &&
        node.props.placeholder === placeholder,
      { includeSelf: true },
    )
    .at(0);
  if (!input) throw new Error(`Missing text input: ${placeholder}`);
  return input;
}

function findPressable(result: RenderResult, label: string): TestInstance {
  const button = result.root!
    .queryAll(
      (node: TestInstance) => (node.type as string) === "rn-pressable",
      { includeSelf: true },
    )
    .find((node) =>
      node.queryAll(
        (child: TestInstance) => child.children?.some((value) => value === label) ?? false,
        { includeSelf: true },
      ).length > 0,
    );
  if (!button) throw new Error(`Missing pressable: ${label}`);
  return button;
}

async function changeText(result: RenderResult, placeholder: string, value: string) {
  await act(async () => {
    findTextInput(result, placeholder).props.onChangeText(value);
  });
}

async function press(result: RenderResult, label: string) {
  const button = findPressable(result, label);
  await act(async () => {
    await button.props.onPress();
  });
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockReplace.mockClear();

  mockSignInPassword.mockReset().mockResolvedValue({ error: null });
  mockSignInFinalize.mockReset().mockResolvedValue(undefined);
  mockSignIn.status = "idle";
  mockUseSignIn.mockReturnValue({
    signIn: mockSignIn,
    errors: { fields: {} },
    fetchStatus: "idle",
  });

  mockSignUpPassword.mockReset().mockResolvedValue({ error: null });
  mockSendEmailCode.mockReset().mockResolvedValue(undefined);
  mockVerifyEmailCode.mockReset().mockResolvedValue({ error: null });
  mockSignUpFinalize.mockReset().mockResolvedValue(undefined);
  mockSignUp.status = "idle";
  mockSignUp.unverifiedFields = [];
  mockSignUp.missingFields = [];
  mockUseSignUp.mockReturnValue({
    signUp: mockSignUp,
    errors: { fields: {} },
    fetchStatus: "idle",
  });

  mockLogout.mockReset().mockResolvedValue(undefined);
  mockShowToast.mockClear();
  mockUseApp.mockReturnValue({
    logout: mockLogout,
    showToast: mockShowToast,
    settings: {},
    updateSetting: jest.fn(),
  });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("LoginScreen — password error recovery", () => {
  it("renders a readable message when password sign-in throws", async () => {
    mockSignInPassword.mockRejectedValue(new Error("Incorrect password"));

    const result = await render(<LoginScreen />);
    await changeText(result, "Enter your email", "worker@example.com");
    await changeText(result, "Enter your password", "wrong-password");

    await press(result, "Sign In →");

    expect(result.queryByText("Incorrect password")).toBeTruthy();
  });

  it("renders a readable message when finalizing a successful sign-in throws", async () => {
    mockSignIn.status = "complete";
    mockSignInFinalize.mockRejectedValue(new Error("Unable to create session"));

    const result = await render(<LoginScreen />);
    await changeText(result, "Enter your email", "worker@example.com");
    await changeText(result, "Enter your password", "correct-password");

    await press(result, "Sign In →");

    expect(mockSignInPassword).toHaveBeenCalledWith({
      emailAddress: "worker@example.com",
      password: "correct-password",
    });
    expect(result.queryByText("Unable to create session")).toBeTruthy();
  });
});

describe("SignUpScreen — verification and send error recovery", () => {
  function useVerificationState() {
    mockSignUp.status = "missing_requirements";
    mockSignUp.unverifiedFields = ["email_address"];
    mockSignUp.missingFields = [];
  }

  it("renders a readable message for an invalid verification code returned by Clerk", async () => {
    useVerificationState();
    mockVerifyEmailCode.mockResolvedValue({
      error: { errors: [{ message: "That verification code is invalid." }] },
    });

    const result = await render(<SignUpScreen />);
    await changeText(result, "Enter 6-digit code", "123456");

    await press(result, "Verify Email →");

    expect(result.queryByText("That verification code is invalid.")).toBeTruthy();
  });

  it("renders a readable message when an expired verification code throws", async () => {
    useVerificationState();
    mockVerifyEmailCode.mockRejectedValue(new Error("This verification code has expired."));

    const result = await render(<SignUpScreen />);
    await changeText(result, "Enter 6-digit code", "654321");

    await press(result, "Verify Email →");

    expect(result.queryByText("This verification code has expired.")).toBeTruthy();
  });

  it("renders an inline error when sending a replacement code returns an error", async () => {
    useVerificationState();
    mockSendEmailCode.mockResolvedValue({
      error: { message: "Email delivery is temporarily unavailable." },
    });

    const result = await render(<SignUpScreen />);
    await press(result, "Resend code");

    expect(result.queryByText("Email delivery is temporarily unavailable.")).toBeTruthy();
  });

  it("renders an inline error when sending a replacement code throws", async () => {
    useVerificationState();
    mockSendEmailCode.mockRejectedValue(new Error("Unable to send email."));

    const result = await render(<SignUpScreen />);
    await press(result, "Resend code");

    expect(result.queryByText("Unable to send email.")).toBeTruthy();
  });
});

describe("BannedScreen — logout error recovery", () => {
  it("re-enables sign out and shows a failure toast when logout throws", async () => {
    mockLogout.mockRejectedValue(new Error("Session cleanup failed"));

    const result = await render(<BannedScreen />);
    await press(result, "Sign Out");

    expect(mockLogout).toHaveBeenCalledTimes(1);
    expect(mockShowToast).toHaveBeenCalledWith(
      "Sign out failed. Please try again.",
      "error",
    );

    const signOutButton = result.getByText("Sign Out").parent;
    expect(signOutButton?.props.disabled).toBe(false);
  });
});