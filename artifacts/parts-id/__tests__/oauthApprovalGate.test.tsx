/**
 * @jest-environment node
 *
 * Confirms that OAuth sign-in lands pending and banned users on the correct
 * screens, and that the OAuthButtons "/(tabs)" navigation is safely overridden
 * by AuthGate for non-approved users.
 *
 * Strategy:
 *  1. Source inspection — verify AuthGate contains the routing guards for
 *     every approval state and that OAuthButtons calls router.replace("/(tabs)")
 *     after a successful OAuth flow.
 *  2. Logic unit tests — exercise the routing decision extracted from AuthGate's
 *     useEffect for every approvalStatus × current-segment combination that an
 *     OAuth sign-in can produce.
 *  3. OAuthButtons runtime tests — mount the component with a mocked
 *     startOAuthFlow, fire the button, and assert that router.replace("/(tabs)")
 *     is called. This confirms the component navigates as documented; AuthGate
 *     then overrides the destination for pending/banned users.
 */

// Required for act() to work in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import * as fs from "fs";
import * as path from "path";
import React from "react";
import renderer, { act } from "react-test-renderer";

// ── Source paths ──────────────────────────────────────────────────────────────

const LAYOUT_PATH      = path.resolve(__dirname, "../app/_layout.tsx");
const AUTHGATE_PATH    = path.resolve(__dirname, "../components/AuthGate.tsx");
const TABS_LAYOUT_PATH = path.resolve(__dirname, "../app/(tabs)/_layout.tsx");
const OAUTH_PATH       = path.resolve(__dirname, "../components/OAuthButtons.tsx");

// ── expo-router ───────────────────────────────────────────────────────────────

const mockReplace = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSegments: jest.fn(() => []),
  Stack: {
    Screen: jest.fn(() => null),
  },
}));

// ── @clerk/expo (OAuthButtons is platform-split) ──────────────────────────────
//
// OAuthButtons splits by platform:
//   • Native (this test env — Platform.OS is "ios"): useSSO()/startSSOFlow(),
//     which receives { strategy, redirectUrl } and resolves with
//     { createdSessionId, setActive }. The default implementation routes by
//     strategy so Google and Apple presses return distinct session IDs.
//   • Web: useClerk().client.signIn.authenticateWithRedirect() (full-page
//     redirect). Mocked below so the hook can be called unconditionally; it is
//     never exercised in the native test path (Platform.OS is "ios").

const mockSetActive = jest.fn(() => Promise.resolve());
const mockStartSSO = jest.fn((opts: { strategy: string }) => {
  if (opts.strategy === "oauth_apple")
    return Promise.resolve({ createdSessionId: "session-456", setActive: mockSetActive });
  return Promise.resolve({ createdSessionId: "session-123", setActive: mockSetActive });
});
const mockAuthenticateWithRedirect = jest.fn(() => Promise.resolve());

jest.mock("@clerk/expo", () => ({
  useSSO: jest.fn(() => ({ startSSOFlow: mockStartSSO })),
  useAuth: jest.fn(() => ({ isSignedIn: false })),
  useClerk: jest.fn(() => ({
    signOut: jest.fn(),
    handleRedirectCallback: jest.fn(),
    client: { signIn: { authenticateWithRedirect: mockAuthenticateWithRedirect } },
  })),
  ClerkProvider: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  ClerkLoaded: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  tokenCache: null,
}));

// ── expo-auth-session (native redirect URI builder) ───────────────────────────

jest.mock("expo-auth-session", () => ({
  makeRedirectUri: jest.fn(() => "partsid://sso-callback"),
}));

// ── useColors ─────────────────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

// ─────────────────────────────────────────────────────────────────────────────
// § 1 — AuthGate source inspection
// ─────────────────────────────────────────────────────────────────────────────

describe("AuthGate — source inspection", () => {
  // AuthGate lives in components/AuthGate.tsx; _layout.tsx only renders <AuthGate />.
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(AUTHGATE_PATH, "utf8");
  });

  it("defines an AuthGate function in components/AuthGate.tsx", () => {
    expect(source).toContain("function AuthGate(");
  });

  it("reads approvalStatus from useApp()", () => {
    expect(source).toMatch(/const\s*\{[^}]*approvalStatus[^}]*\}\s*=\s*useApp\(\)/);
  });

  it("redirects to /pending when approvalStatus is 'pending'", () => {
    expect(source).toMatch(/approvalStatus\s*===\s*["']pending["']/);
    expect(source).toContain('"/pending"');
  });

  it("redirects to /banned when approvalStatus is 'banned'", () => {
    expect(source).toMatch(/approvalStatus\s*===\s*["']banned["']/);
    expect(source).toContain('"/banned"');
  });

  it("skips redirect when already on /pending (no redirect loop)", () => {
    // Must check !atPending before replacing so pending users aren't bounced
    // back and forth infinitely.
    expect(source).toMatch(/atPending/);
    expect(source).toMatch(/approvalStatus\s*===\s*["']pending["'][^}]*!atPending|!atPending[^}]*approvalStatus\s*===\s*["']pending["']/s);
  });

  it("skips redirect when already on /banned (no redirect loop)", () => {
    expect(source).toMatch(/atBanned/);
    expect(source).toMatch(/approvalStatus\s*===\s*["']banned["'][^}]*!atBanned|!atBanned[^}]*approvalStatus\s*===\s*["']banned["']/s);
  });

  it("waits for clerkLoaded before making any routing decision", () => {
    expect(source).toMatch(/if\s*\(!clerkLoaded\)\s*return/);
  });

  it("skips routing while approvalStatus is 'loading' or 'idle'", () => {
    expect(source).toMatch(/approvalStatus\s*===\s*["']loading["']/);
    expect(source).toMatch(/approvalStatus\s*===\s*["']idle["']/);
  });

  it("AuthGate is rendered inside RootLayout (not conditionally gated)", () => {
    // AuthGate must always be in the tree so it can react to state changes from
    // any sign-in path — email/password or OAuth. This assertion targets
    // _layout.tsx (where <AuthGate /> is mounted), not AuthGate.tsx.
    const layoutSource = fs.readFileSync(LAYOUT_PATH, "utf8");
    expect(layoutSource).toContain("<AuthGate />");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 2 — AuthGate routing logic unit tests
//
// The core routing decision is extracted as a pure function that mirrors the
// useEffect in AuthGate.  Testing it in isolation is faster and more reliable
// than mounting the full layout; any deviation from the source is caught by the
// source-inspection tests above.
// ─────────────────────────────────────────────────────────────────────────────

type ApprovalStatus = "idle" | "loading" | "pending" | "approved" | "banned";

/**
 * Mirrors the routing decision in AuthGate's useEffect.
 * Returns the replacement path that router.replace() would be called with,
 * or null if no redirect should happen.
 */
function authGateDecision(opts: {
  isSignedIn: boolean;
  approvalStatus: ApprovalStatus;
  segments: string[];
}): string | null {
  const { isSignedIn, approvalStatus, segments } = opts;
  const seg0 = segments[0] as string | undefined;
  const inTabs    = seg0 === "(tabs)";
  const atLogin   = seg0 === "login";
  const atSignUp  = seg0 === "sign-up";
  const atPending = seg0 === "pending";
  const atBanned  = seg0 === "banned";

  if (!isSignedIn) {
    if (!atLogin && !atSignUp) return "/login";
    return null;
  }

  // Signed in — wait for status to settle
  if (approvalStatus === "loading" || approvalStatus === "idle") return null;

  if (approvalStatus === "pending" && !atPending) return "/pending";
  if (approvalStatus === "banned"  && !atBanned)  return "/banned";
  if (approvalStatus === "approved" && !inTabs)   return "/(tabs)";
  return null;
}

describe("AuthGate routing decision — pending user", () => {
  it("redirects to /pending when OAuth sign-in completes (currently at login screen)", () => {
    // OAuth flow: user was on /login, setActive() fires → isSignedIn becomes
    // true, OAuthButtons calls router.replace("/(tabs)"), but AuthGate then
    // fires and overrides with /pending.
    const destination = authGateDecision({
      isSignedIn: true,
      approvalStatus: "pending",
      segments: ["login"],
    });
    expect(destination).toBe("/pending");
  });

  it("redirects to /pending when landing on /(tabs) (OAuthButtons' replace ran first)", () => {
    // This is the key scenario: OAuthButtons called router.replace("/(tabs)")
    // but AuthGate fires on the next render cycle and corrects the destination.
    const destination = authGateDecision({
      isSignedIn: true,
      approvalStatus: "pending",
      segments: ["(tabs)"],
    });
    expect(destination).toBe("/pending");
  });

  it("does NOT redirect when already on /pending (prevents loop)", () => {
    const destination = authGateDecision({
      isSignedIn: true,
      approvalStatus: "pending",
      segments: ["pending"],
    });
    expect(destination).toBeNull();
  });
});

describe("AuthGate routing decision — banned user", () => {
  it("redirects to /banned when OAuth sign-in completes (currently at login screen)", () => {
    const destination = authGateDecision({
      isSignedIn: true,
      approvalStatus: "banned",
      segments: ["login"],
    });
    expect(destination).toBe("/banned");
  });

  it("redirects to /banned when landing on /(tabs) (OAuthButtons' replace ran first)", () => {
    const destination = authGateDecision({
      isSignedIn: true,
      approvalStatus: "banned",
      segments: ["(tabs)"],
    });
    expect(destination).toBe("/banned");
  });

  it("does NOT redirect when already on /banned (prevents loop)", () => {
    const destination = authGateDecision({
      isSignedIn: true,
      approvalStatus: "banned",
      segments: ["banned"],
    });
    expect(destination).toBeNull();
  });
});

describe("AuthGate routing decision — approved user", () => {
  it("sends approved users to /(tabs) when not already there", () => {
    const destination = authGateDecision({
      isSignedIn: true,
      approvalStatus: "approved",
      segments: ["login"],
    });
    expect(destination).toBe("/(tabs)");
  });

  it("does not redirect when already in /(tabs)", () => {
    const destination = authGateDecision({
      isSignedIn: true,
      approvalStatus: "approved",
      segments: ["(tabs)"],
    });
    expect(destination).toBeNull();
  });
});

describe("AuthGate routing decision — status still settling", () => {
  it("does not redirect while approvalStatus is 'loading'", () => {
    expect(
      authGateDecision({ isSignedIn: true, approvalStatus: "loading", segments: ["login"] })
    ).toBeNull();
  });

  it("does not redirect while approvalStatus is 'idle'", () => {
    expect(
      authGateDecision({ isSignedIn: true, approvalStatus: "idle", segments: [] })
    ).toBeNull();
  });
});

describe("AuthGate routing decision — signed out", () => {
  it("sends unauthenticated users to /login from any non-auth screen", () => {
    expect(
      authGateDecision({ isSignedIn: false, approvalStatus: "idle", segments: ["(tabs)"] })
    ).toBe("/login");
  });

  it("does not redirect when already on /login", () => {
    expect(
      authGateDecision({ isSignedIn: false, approvalStatus: "idle", segments: ["login"] })
    ).toBeNull();
  });

  it("does not redirect when already on /sign-up", () => {
    expect(
      authGateDecision({ isSignedIn: false, approvalStatus: "idle", segments: ["sign-up"] })
    ).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 3 — OAuthButtons runtime tests
//
// Confirms that after startOAuthFlow resolves with a session:
//  (a) setActive() is called with that session ID
//  (b) router.replace("/(tabs)") is called — this is the OAuthButtons
//      responsibility; AuthGate then overrides it for non-approved users.
// ─────────────────────────────────────────────────────────────────────────────

// Lazy-import the component so all mocks are installed first.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { OAuthButtons } = require("../components/OAuthButtons") as typeof import("../components/OAuthButtons");

describe("OAuthButtons — Google sign-in success path", () => {
  beforeEach(() => {
    mockReplace.mockClear();
    mockSetActive.mockClear();
    mockStartSSO.mockClear();
    mockStartSSO.mockResolvedValue({
      createdSessionId: "session-google",
      setActive: mockSetActive,
    });
  });

  it("calls setActive() with the new session ID after Google OAuth completes", async () => {
    let root: renderer.ReactTestRenderer;
    await act(async () => {
      root = renderer.create(React.createElement(OAuthButtons, { mode: "sign-in" }));
    });

    // Find the Google button (first Pressable) and simulate a press.
    const pressables = root!.root.findAllByType("rn-pressable" as unknown as React.ComponentType);
    const googleBtn = pressables[0];
    expect(googleBtn).toBeDefined();

    await act(async () => {
      googleBtn!.props.onPress();
    });

    expect(mockSetActive).toHaveBeenCalledWith({ session: "session-google" });
  });

  it("calls router.replace('/(tabs)') after Google OAuth setActive resolves", async () => {
    let root: renderer.ReactTestRenderer;
    await act(async () => {
      root = renderer.create(React.createElement(OAuthButtons, { mode: "sign-in" }));
    });

    const pressables = root!.root.findAllByType("rn-pressable" as unknown as React.ComponentType);
    await act(async () => {
      pressables[0]!.props.onPress();
    });

    expect(mockReplace).toHaveBeenCalledWith("/(tabs)");
  });

  it("does NOT call router.replace when OAuth returns no session (cancelled)", async () => {
    // @ts-ignore — deliberately passing a falsy sessionId to simulate a cancelled OAuth flow
    mockStartSSO.mockResolvedValueOnce({ createdSessionId: null, setActive: mockSetActive });

    let root: renderer.ReactTestRenderer;
    await act(async () => {
      root = renderer.create(React.createElement(OAuthButtons, { mode: "sign-in" }));
    });

    const pressables = root!.root.findAllByType("rn-pressable" as unknown as React.ComponentType);
    await act(async () => {
      pressables[0]!.props.onPress();
    });

    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockSetActive).not.toHaveBeenCalled();
  });
});

describe("OAuthButtons — Apple sign-in success path", () => {
  beforeEach(() => {
    mockReplace.mockClear();
    mockSetActive.mockClear();
    mockStartSSO.mockClear();
    mockStartSSO.mockResolvedValue({
      createdSessionId: "session-apple",
      setActive: mockSetActive,
    });
  });

  it("calls setActive() with the new session ID after Apple OAuth completes", async () => {
    let root: renderer.ReactTestRenderer;
    await act(async () => {
      root = renderer.create(React.createElement(OAuthButtons, { mode: "sign-in" }));
    });

    // On iOS (the mock default), Apple button is the second Pressable.
    const pressables = root!.root.findAllByType("rn-pressable" as unknown as React.ComponentType);
    const appleBtn = pressables[1];
    expect(appleBtn).toBeDefined();

    await act(async () => {
      appleBtn!.props.onPress();
    });

    expect(mockSetActive).toHaveBeenCalledWith({ session: "session-apple" });
  });

  it("calls router.replace('/(tabs)') after Apple OAuth setActive resolves", async () => {
    let root: renderer.ReactTestRenderer;
    await act(async () => {
      root = renderer.create(React.createElement(OAuthButtons, { mode: "sign-in" }));
    });

    const pressables = root!.root.findAllByType("rn-pressable" as unknown as React.ComponentType);
    await act(async () => {
      pressables[1]!.props.onPress();
    });

    expect(mockReplace).toHaveBeenCalledWith("/(tabs)");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 4 — OAuthButtons source inspection
// ─────────────────────────────────────────────────────────────────────────────

describe("OAuthButtons — source inspection", () => {
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(OAUTH_PATH, "utf8");
  });

  it("calls router.replace('/(tabs)') after a successful Google OAuth", () => {
    expect(source).toMatch(/router\.replace\(["']\/\(tabs\)["']\)/);
  });

  it("calls setActive before router.replace (session must be active before navigation)", () => {
    // Both Google and Apple presses funnel through the shared runOAuth helper.
    // On the native path it must await setActive before navigating. Confirm the
    // pattern: await setActive!(...) precedes router.replace inside runOAuth.
    const runOAuthMatch = source.match(/runOAuth[\s\S]*?}\s*,\s*\[/);
    expect(runOAuthMatch).not.toBeNull();

    const body = runOAuthMatch![0];

    const setActiveIdx = body.indexOf("setActive");
    const replaceIdx   = body.indexOf('router.replace("/(tabs)")');
    expect(setActiveIdx).toBeGreaterThan(-1);
    expect(replaceIdx).toBeGreaterThan(-1);
    expect(setActiveIdx).toBeLessThan(replaceIdx);
  });

  it("guards the success path with a createdSessionId check (no navigation on cancel)", () => {
    expect(source).toMatch(/if\s*\(createdSessionId\)/);
  });

  it("renders the approval note only in sign-up mode (source contains conditional)", () => {
    // The note is guarded by {mode === "sign-up" && ...} in JSX.
    expect(source).toMatch(/mode\s*===\s*["']sign-up["']/);
    expect(source).toContain("You'll still need admin approval after signing up");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 5 — OAuthButtons sign-up mode: OAuth flow still routes through AuthGate
//
// A first-time OAuth sign-up creates a brand-new account. OAuthButtons does
// not know whether the user is new or returning — it always calls
// router.replace("/(tabs)") after setActive(). AuthGate then intercepts and
// redirects a pending (new) user to /pending, exactly as it does for sign-in.
//
// These tests confirm:
//  (a) OAuthButtons in sign-up mode calls router.replace("/(tabs)") — the
//      same as sign-in mode, so AuthGate's guard is the only thing that matters.
//  (b) The AuthGate routing decision correctly sends a brand-new user
//      (approvalStatus "pending") who just signed up to /pending.
// ─────────────────────────────────────────────────────────────────────────────

describe("OAuthButtons — Google sign-up flow (new account)", () => {
  beforeEach(() => {
    mockReplace.mockClear();
    mockSetActive.mockClear();
    mockStartSSO.mockClear();
    mockStartSSO.mockResolvedValue({
      createdSessionId: "session-new-user",
      setActive: mockSetActive,
    });
  });

  it("calls setActive() with the new session ID when signing up via Google", async () => {
    let root: renderer.ReactTestRenderer;
    await act(async () => {
      root = renderer.create(React.createElement(OAuthButtons, { mode: "sign-up" }));
    });

    const pressables = root!.root.findAllByType("rn-pressable" as unknown as React.ComponentType);
    await act(async () => {
      pressables[0]!.props.onPress();
    });

    expect(mockSetActive).toHaveBeenCalledWith({ session: "session-new-user" });
  });

  it("calls router.replace('/(tabs)') after Google OAuth completes in sign-up mode", async () => {
    // OAuthButtons always navigates to /(tabs) — AuthGate overrides this for
    // users who are still pending.
    let root: renderer.ReactTestRenderer;
    await act(async () => {
      root = renderer.create(React.createElement(OAuthButtons, { mode: "sign-up" }));
    });

    const pressables = root!.root.findAllByType("rn-pressable" as unknown as React.ComponentType);
    await act(async () => {
      pressables[0]!.props.onPress();
    });

    expect(mockReplace).toHaveBeenCalledWith("/(tabs)");
  });

  it("does NOT call router.replace when OAuth returns no session in sign-up mode (cancelled)", async () => {
    // @ts-ignore — deliberately falsy sessionId to simulate a cancelled OAuth flow
    mockStartSSO.mockResolvedValueOnce({ createdSessionId: null, setActive: mockSetActive });

    let root: renderer.ReactTestRenderer;
    await act(async () => {
      root = renderer.create(React.createElement(OAuthButtons, { mode: "sign-up" }));
    });

    const pressables = root!.root.findAllByType("rn-pressable" as unknown as React.ComponentType);
    await act(async () => {
      pressables[0]!.props.onPress();
    });

    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockSetActive).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 6 — AuthGate routing decision: OAuth sign-up for a brand-new account
//
// A brand-new user who signs up via OAuth has approvalStatus "pending" from the
// moment their account is created. These tests confirm the routing decision
// function — which mirrors AuthGate's useEffect — sends them to /pending
// regardless of which screen OAuthButtons navigated to.
// ─────────────────────────────────────────────────────────────────────────────

describe("AuthGate routing decision — OAuth sign-up (brand-new account)", () => {
  it("redirects brand-new user to /pending when they land on /(tabs) after sign-up", () => {
    // Scenario: user completes OAuth sign-up → OAuthButtons calls
    // router.replace("/(tabs)") → AuthGate fires → user is pending → /pending.
    const destination = authGateDecision({
      isSignedIn: true,
      approvalStatus: "pending",
      segments: ["(tabs)"],
    });
    expect(destination).toBe("/pending");
  });

  it("redirects brand-new user to /pending when still on the sign-up screen after OAuth", () => {
    // Scenario: OAuth completes but the segment has not yet changed from sign-up.
    const destination = authGateDecision({
      isSignedIn: true,
      approvalStatus: "pending",
      segments: ["sign-up"],
    });
    expect(destination).toBe("/pending");
  });

  it("does NOT redirect a brand-new user once they are already on /pending", () => {
    // AuthGate must not create a redirect loop once the user reaches /pending.
    const destination = authGateDecision({
      isSignedIn: true,
      approvalStatus: "pending",
      segments: ["pending"],
    });
    expect(destination).toBeNull();
  });

  it("does not redirect while approvalStatus is still loading (sign-up just completed)", () => {
    // Between setActive() resolving and the API confirming the approval status,
    // the status is "loading". AuthGate must wait.
    const destination = authGateDecision({
      isSignedIn: true,
      approvalStatus: "loading",
      segments: ["(tabs)"],
    });
    expect(destination).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 7 — OAuthButtons approval note visibility
//
// The "You'll still need admin approval after signing up" note must appear only
// in sign-up mode so that users are informed before completing the OAuth flow.
// In sign-in mode the note must be absent (returning users already know their
// status).
// ─────────────────────────────────────────────────────────────────────────────

const APPROVAL_NOTE = "You'll still need admin approval after signing up";

describe("OAuthButtons — approval note visibility", () => {
  it("renders the approval note when mode is 'sign-up'", async () => {
    let root: renderer.ReactTestRenderer;
    await act(async () => {
      root = renderer.create(React.createElement(OAuthButtons, { mode: "sign-up" }));
    });

    const json = JSON.stringify(root!.toJSON());
    expect(json).toContain(APPROVAL_NOTE);
  });

  it("does NOT render the approval note when mode is 'sign-in'", async () => {
    let root: renderer.ReactTestRenderer;
    await act(async () => {
      root = renderer.create(React.createElement(OAuthButtons, { mode: "sign-in" }));
    });

    const json = JSON.stringify(root!.toJSON());
    expect(json).not.toContain(APPROVAL_NOTE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 5 — (tabs)/_layout.tsx race-window guard (source inspection)
//
// There is a narrow window between setActive() resolving (isSignedIn=true) and
// the /auth/status fetch completing where approvalStatus is still "loading".
// During that window OAuthButtons may have already called
// router.replace("/(tabs)"), so the tab layout must not render sensitive content
// until approvalStatus has settled to "approved" (isAuthenticated=true).
//
// These tests lock the isAuthenticated guard in (tabs)/_layout.tsx so it cannot
// be accidentally removed.
// ─────────────────────────────────────────────────────────────────────────────

describe("(tabs)/_layout.tsx — isAuthenticated race-window guard", () => {
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(TABS_LAYOUT_PATH, "utf8");
  });

  it("imports useApp from AppContext", () => {
    expect(source).toMatch(/useApp/);
    expect(source).toMatch(/AppContext/);
  });

  it("reads isAuthenticated from useApp()", () => {
    // Must destructure isAuthenticated out of the useApp() call.
    expect(source).toMatch(/isAuthenticated/);
    expect(source).toMatch(/useApp\(\)/);
  });

  it("returns null (renders nothing) when isAuthenticated is false", () => {
    // The guard must short-circuit before the Tabs tree is returned.
    // Accept both `if (!isAuthenticated) return null` and
    // `if (!isAuthenticated) { return null; }` forms.
    expect(source).toMatch(/if\s*\(!isAuthenticated\)\s*(return null|\{[^}]*return null)/s);
  });

  it("guard appears before the Tabs JSX (not after it)", () => {
    // The null-return must come before the <Tabs …> tree so tabs never render
    // for non-approved users.
    const guardIdx = source.indexOf("if (!isAuthenticated)");
    const tabsIdx  = source.indexOf("<Tabs");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(tabsIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(tabsIdx);
  });
});
