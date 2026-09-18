/**
 * Auth recovery workflow tests.
 *
 * These tests mount the real Expo auth routes and drive them like a user
 * moving through the recovery workflow. They intentionally cover the retry
 * after failure, not only the first error render:
 * - password sign-in failure -> retry -> route transition
 * - verification/send failure -> retry -> verification finalization
 * - pending and banned logout failure -> readable state -> second attempt
 */

// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

const mockReplace = jest.fn();
jest.mock("expo-router", () => ({
  Link: ({ children }: { children: unknown }) => {
    const React = require("react");
    return React.createElement(React.Fragment, null, children);
  },
  useRouter: () => ({ replace: mockReplace }),
}));

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

const mockLogout = jest.fn();
const mockRecheckApprovalStatus = jest.fn();
const mockShowToast = jest.fn();
const mockUseApp = jest.fn();

jest.mock("@/contexts/AppContext", () => ({
  useApp: () => mockUseApp(),
}));

jest.mock("@/components/OAuthButtons", () => ({
  OAuthButtons: () => null,
}));

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
import PendingScreen from "@/app/pending";
import SignUpScreen from "@/app/sign-up";

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

const flushMicrotasks = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

beforeEach(() => {
  mockReplace.mockClear();

  mockSignInPassword.mockReset().mockResolvedValue({ error: null });
  mockSignInFinalize.mockReset().mockImplementation(
    async ({
      navigate,
    }: {
      navigate: (options: { decorateUrl: (url: string) => string }) => void;
    }) => {
      navigate({ decorateUrl: (url) => url });
    },
  );
  mockSignIn.status = "idle";
  mockUseSignIn.mockReturnValue({
    signIn: mockSignIn,
    errors: { fields: {} },
    fetchStatus: "idle",
  });

  mockSignUpPassword.mockReset().mockResolvedValue({ error: null });
  mockSendEmailCode.mockReset().mockResolvedValue(undefined);
  mockVerifyEmailCode.mockReset().mockResolvedValue({ error: null });
  mockSignUpFinalize.mockReset().mockImplementation(
    async ({
      navigate,
    }: {
      navigate: (options: { decorateUrl: (url: string) => string }) => void;
    }) => {
      navigate({ decorateUrl: (url) => url });
    },
  );
  mockSignUp.status = "idle";
  mockSignUp.unverifiedFields = [];
  mockSignUp.missingFields = [];
  mockUseSignUp.mockReturnValue({
    signUp: mockSignUp,
    errors: { fields: {} },
    fetchStatus: "idle",
  });

  mockLogout.mockReset().mockResolvedValue(undefined);
  mockRecheckApprovalStatus.mockReset().mockResolvedValue(undefined);
  mockShowToast.mockClear();
  mockUseApp.mockReturnValue({
    logout: mockLogout,
    recheckApprovalStatus: mockRecheckApprovalStatus,
    approvalStatus: "pending",
    showToast: mockShowToast,
    settings: {},
    updateSetting: jest.fn(),
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe("Auth recovery workflow", () => {
  it("recovers from a failed password sign-in and completes navigation on retry", async () => {
    mockSignIn.status = "complete";
    mockSignInPassword
      .mockRejectedValueOnce(new Error("Incorrect password"))
      .mockResolvedValueOnce({ error: null });

    const result = await render(<LoginScreen />);
    await changeText(result, "Enter your email", "worker@example.com");
    await changeText(result, "Enter your password", "wrong-password");

    await press(result, "Sign In →");

    expect(result.queryByText("Incorrect password")).toBeTruthy();
    expect(result.queryByText("Parts ID")).toBeTruthy();

    await press(result, "Sign In →");

    expect(mockSignInPassword).toHaveBeenCalledTimes(2);
    expect(mockSignInFinalize).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith("/(tabs)");
  });

  it("recovers from verification delivery and code failures without losing the verification route", async () => {
    mockSignUp.status = "missing_requirements";
    mockSignUp.unverifiedFields = ["email_address"];
    mockSignUp.missingFields = [];
    mockSendEmailCode
      .mockRejectedValueOnce(new Error("Email delivery is temporarily unavailable."))
      .mockResolvedValueOnce(undefined);
    mockVerifyEmailCode
      .mockResolvedValueOnce({
        error: { errors: [{ message: "That verification code is invalid." }] },
      })
      .mockResolvedValueOnce({ error: null, status: "complete" });

    const result = await render(<SignUpScreen />);

    expect(result.queryByText("Check your email")).toBeTruthy();

    await press(result, "Resend code");
    expect(result.queryByText("Email delivery is temporarily unavailable.")).toBeTruthy();

    await press(result, "Resend code");
    expect(result.queryByText("Email delivery is temporarily unavailable.")).toBeNull();
    expect(result.queryByText("Check your email")).toBeTruthy();

    await changeText(result, "Enter 6-digit code", "123456");
    await press(result, "Verify Email →");

    expect(result.queryByText("That verification code is invalid.")).toBeTruthy();
    expect(result.queryByText("Check your email")).toBeTruthy();

    await press(result, "Verify Email →");

    expect(mockVerifyEmailCode).toHaveBeenCalledTimes(2);
    expect(mockSignUpFinalize).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith("/(tabs)");
  });

  it("keeps pending users on a readable screen and allows sign-out retry after failure", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
    mockLogout
      .mockRejectedValueOnce(new Error("Session cleanup failed"))
      .mockResolvedValueOnce(undefined);

    const result = await render(<PendingScreen />);
    await flushMicrotasks();

    await press(result, "Sign Out");

    expect(result.queryByText("Account Pending Approval")).toBeTruthy();
    expect(result.queryByText("Check failed")).toBeNull();
    expect(mockShowToast).toHaveBeenCalledWith(
      "Sign out failed. Please try again.",
      "error",
    );
    expect(findPressable(result, "Sign Out").props.disabled).toBe(false);

    await press(result, "Sign Out");
    expect(mockLogout).toHaveBeenCalledTimes(2);
    expect(result.queryByText("Account Pending Approval")).toBeTruthy();
  });

  it("keeps banned users on a readable screen and allows sign-out retry after failure", async () => {
    mockUseApp.mockReturnValue({
      logout: mockLogout
        .mockRejectedValueOnce(new Error("Session cleanup failed"))
        .mockResolvedValueOnce(undefined),
      recheckApprovalStatus: mockRecheckApprovalStatus,
      approvalStatus: "banned",
      showToast: mockShowToast,
      settings: {},
      updateSetting: jest.fn(),
    });

    const result = await render(<BannedScreen />);

    await press(result, "Sign Out");

    expect(result.queryByText("Account Disabled")).toBeTruthy();
    expect(mockShowToast).toHaveBeenCalledWith(
      "Sign out failed. Please try again.",
      "error",
    );
    expect(findPressable(result, "Sign Out").props.disabled).toBe(false);

    await press(result, "Sign Out");
    expect(mockLogout).toHaveBeenCalledTimes(2);
    expect(result.queryByText("Account Disabled")).toBeTruthy();
  });
});