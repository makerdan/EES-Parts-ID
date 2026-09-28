/** @jest-environment jsdom */

jest.mock("react-native", () => jest.requireActual("react-native-web"));
jest.mock("expo-router", () => {
  const React = jest.requireActual("react");
  return {
    Link: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    useRouter: () => ({ replace: jest.fn() }),
  };
});
jest.mock("@clerk/expo", () => ({
  useSignIn: () => ({
    signIn: {
      password: jest.fn(),
      finalize: jest.fn(),
      status: "idle",
    },
    errors: { fields: {} },
    fetchStatus: "idle",
  }),
}));
jest.mock("@/components/OAuthButtons", () => ({ OAuthButtons: () => null }));
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
    radius: 8,
  }),
}));

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import LoginScreen from "@/app/login";

describe("LoginScreen web accessibility semantics", () => {
  it("keeps persistent input names and exposes main and level-one heading roles", () => {
    render(<LoginScreen />);

    const emailInput = screen.getByLabelText("Email");
    const passwordInput = screen.getByLabelText("Password");

    expect(emailInput.getAttribute("aria-label")).toBe("Email");
    expect(passwordInput.getAttribute("aria-label")).toBe("Password");

    fireEvent.change(emailInput, { target: { value: "worker@example.com" } });
    fireEvent.change(passwordInput, { target: { value: "warehouse-password" } });

    expect(screen.getByLabelText("Email").getAttribute("value")).toBe(
      "worker@example.com",
    );
    expect(screen.getByLabelText("Password").getAttribute("value")).toBe(
      "warehouse-password",
    );
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(
      screen.getByRole("heading", { name: "Parts ID", level: 1 }),
    ).toBeTruthy();
  });
});