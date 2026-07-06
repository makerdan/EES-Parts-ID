/**
 * Unit tests for AuthGate (components/AuthGate.tsx).
 *
 * AuthGate is the single source of truth for post-auth navigation.
 * These tests lock in the sso-callback exemption: while Clerk is still
 * processing OAuth token params on /sso-callback, AuthGate must NOT redirect
 * the user away — even though isSignedIn is still false.  Once isSignedIn
 * flips to true, AuthGate resumes normal routing.
 *
 * Rendering strategy
 * ──────────────────
 * AuthGate renders null; we drive it via its useEffect side-effects.
 * react-test-renderer + act() flushes effects synchronously so we can assert
 * on the router mock immediately after render.
 */

(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

// ── expo-router ────────────────────────────────────────────────────────────
const mockReplace = jest.fn();
const mockUseSegments = jest.fn<string[], []>(() => []);
const mockUseRouter = jest.fn(() => ({ replace: mockReplace }));

jest.mock("expo-router", () => ({
  useSegments: mockUseSegments,
  useRouter: mockUseRouter,
}));

// ── @clerk/expo ────────────────────────────────────────────────────────────
// Override the moduleNameMapper entry with an explicit mock so we hold a
// direct reference to the useAuth jest.fn that the component will call.
const mockUseAuth = jest.fn(() => ({
  isSignedIn: false,
  isLoaded: true,
  getToken: jest.fn(),
}));

jest.mock("@clerk/expo", () => ({
  useAuth: mockUseAuth,
}));

// ── @/contexts/AppContext ──────────────────────────────────────────────────
// Same pattern: explicit jest.mock keeps the reference stable and shared with
// the imported component.
const mockUseApp = jest.fn(() => ({
  approvalStatus: "idle" as string,
  settings: {},
  updateSetting: jest.fn(),
}));

jest.mock("@/contexts/AppContext", () => ({
  useApp: mockUseApp,
}));

// Import after all mocks are registered.
import { AuthGate } from "@/components/AuthGate";

// ── helpers ────────────────────────────────────────────────────────────────

function renderAuthGate() {
  let renderer!: ReturnType<typeof TestRenderer.create>;
  act(() => {
    renderer = TestRenderer.create(React.createElement(AuthGate));
  });
  return renderer;
}

// ── setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockReplace.mockClear();
  mockUseSegments.mockReturnValue([]);
  mockUseAuth.mockReturnValue({ isSignedIn: false, isLoaded: true, getToken: jest.fn() });
  mockUseApp.mockReturnValue({ approvalStatus: "idle", settings: {}, updateSetting: jest.fn() });
});

// ── sso-callback exemption (the core contract) ─────────────────────────────

describe("AuthGate — sso-callback exemption", () => {
  it("does NOT redirect to /login when isSignedIn=false and segment is sso-callback", () => {
    mockUseSegments.mockReturnValue(["sso-callback"]);
    mockUseAuth.mockReturnValue({ isSignedIn: false, isLoaded: true, getToken: jest.fn() });

    renderAuthGate();

    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("redirects to /(tabs) once isSignedIn flips true while on sso-callback (approved)", () => {
    mockUseSegments.mockReturnValue(["sso-callback"]);
    mockUseAuth.mockReturnValue({ isSignedIn: true, isLoaded: true, getToken: jest.fn() });
    mockUseApp.mockReturnValue({ approvalStatus: "approved", settings: {}, updateSetting: jest.fn() });

    renderAuthGate();

    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith("/(tabs)");
  });

  it("redirects to /pending once isSignedIn flips true while on sso-callback (pending approval)", () => {
    mockUseSegments.mockReturnValue(["sso-callback"]);
    mockUseAuth.mockReturnValue({ isSignedIn: true, isLoaded: true, getToken: jest.fn() });
    mockUseApp.mockReturnValue({ approvalStatus: "pending", settings: {}, updateSetting: jest.fn() });

    renderAuthGate();

    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith("/pending");
  });

  it("redirects to /banned once isSignedIn flips true while on sso-callback (banned)", () => {
    mockUseSegments.mockReturnValue(["sso-callback"]);
    mockUseAuth.mockReturnValue({ isSignedIn: true, isLoaded: true, getToken: jest.fn() });
    mockUseApp.mockReturnValue({ approvalStatus: "banned", settings: {}, updateSetting: jest.fn() });

    renderAuthGate();

    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith("/banned");
  });
});

// ── baseline redirect behaviour (non-sso-callback routes) ─────────────────

describe("AuthGate — baseline redirect behaviour", () => {
  it("redirects to /login when isSignedIn=false and not on an exempt route", () => {
    mockUseSegments.mockReturnValue(["some-protected-route"]);
    mockUseAuth.mockReturnValue({ isSignedIn: false, isLoaded: true, getToken: jest.fn() });

    renderAuthGate();

    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith("/login");
  });

  it("does NOT redirect when isSignedIn=false and already at /login", () => {
    mockUseSegments.mockReturnValue(["login"]);
    mockUseAuth.mockReturnValue({ isSignedIn: false, isLoaded: true, getToken: jest.fn() });

    renderAuthGate();

    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("does NOT redirect when isSignedIn=false and already at /sign-up", () => {
    mockUseSegments.mockReturnValue(["sign-up"]);
    mockUseAuth.mockReturnValue({ isSignedIn: false, isLoaded: true, getToken: jest.fn() });

    renderAuthGate();

    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("does nothing when Clerk has not finished loading yet", () => {
    mockUseSegments.mockReturnValue(["some-route"]);
    mockUseAuth.mockReturnValue({ isSignedIn: false, isLoaded: false, getToken: jest.fn() });

    renderAuthGate();

    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("does nothing when signed in but approvalStatus is still loading", () => {
    mockUseSegments.mockReturnValue(["sso-callback"]);
    mockUseAuth.mockReturnValue({ isSignedIn: true, isLoaded: true, getToken: jest.fn() });
    mockUseApp.mockReturnValue({ approvalStatus: "loading", settings: {}, updateSetting: jest.fn() });

    renderAuthGate();

    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("does nothing when signed in but approvalStatus is idle", () => {
    mockUseSegments.mockReturnValue(["sso-callback"]);
    mockUseAuth.mockReturnValue({ isSignedIn: true, isLoaded: true, getToken: jest.fn() });
    mockUseApp.mockReturnValue({ approvalStatus: "idle", settings: {}, updateSetting: jest.fn() });

    renderAuthGate();

    expect(mockReplace).not.toHaveBeenCalled();
  });
});
