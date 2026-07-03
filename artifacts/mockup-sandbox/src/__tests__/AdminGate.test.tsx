/**
 * AdminGate.test.tsx
 *
 * Unit tests for the Clerk-backed <AdminGate> that guards the admin tools.
 *
 * Coverage:
 *   - Signed out              → shows the sign-in prompt.
 *   - Signed in, admin        → renders children (after /api/admin/me).
 *   - Signed in, not admin    → shows the "admins only" message.
 *   - Signed in, server 403   → treated as denied.
 *   - Signed in, network fail → shows the error/retry state.
 *   - requireAdmin=false      → renders children for any signed-in user without
 *                               calling /api/admin/me.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup, waitFor, screen } from "@testing-library/react";

// ─── Clerk mock ─────────────────────────────────────────────────────────────
// useAuth drives the gate's signed-in / loaded state; useClerk provides the
// action handlers. Both must return stable refs so effects don't re-fire.
const authState: { isLoaded: boolean; isSignedIn: boolean } = {
  isLoaded: true,
  isSignedIn: true,
};
const redirectToSignIn = vi.fn();
const signOut = vi.fn();

vi.mock("@clerk/react", () => ({
  useAuth: () => authState,
  useClerk: () => ({ redirectToSignIn, signOut }),
}));

// AdminGate imports basePath from clerkConfig, which touches Clerk internals and
// import.meta.env — stub it so the test doesn't need a real publishable key.
vi.mock("../auth/clerkConfig", () => ({ basePath: "" }));

import { AdminGate } from "../components/AdminGate";

function Child() {
  return <div>SECRET ADMIN CONTENT</div>;
}

function mockFetch(impl: () => Promise<unknown>) {
  global.fetch = vi.fn(impl) as unknown as typeof global.fetch;
}

function jsonResponse(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(""),
  });
}

async function renderGate(requireAdmin = true) {
  await act(async () => {
    render(
      <AdminGate requireAdmin={requireAdmin}>
        <Child />
      </AdminGate>,
    );
  });
}

beforeEach(() => {
  authState.isLoaded = true;
  authState.isSignedIn = true;
  redirectToSignIn.mockReset();
  signOut.mockReset();
  mockFetch(() => jsonResponse(200, { isAdmin: true }));
});

afterEach(() => {
  cleanup();
});

describe("AdminGate", () => {
  it("shows the sign-in prompt when signed out", async () => {
    authState.isSignedIn = false;
    await renderGate();

    expect(screen.getByText(/sign in required/i)).toBeTruthy();
    expect(screen.queryByText("SECRET ADMIN CONTENT")).toBeNull();
  });

  it("renders children for a signed-in admin", async () => {
    mockFetch(() => jsonResponse(200, { isAdmin: true }));
    await renderGate();

    await waitFor(() => {
      expect(screen.getByText("SECRET ADMIN CONTENT")).toBeTruthy();
    });
  });

  it("shows the admins-only message for a signed-in non-admin", async () => {
    mockFetch(() => jsonResponse(200, { isAdmin: false }));
    await renderGate();

    await waitFor(() => {
      expect(screen.getByText(/admins only/i)).toBeTruthy();
    });
    expect(screen.queryByText("SECRET ADMIN CONTENT")).toBeNull();
  });

  it("treats a 403 from the server as denied", async () => {
    mockFetch(() => jsonResponse(403, {}));
    await renderGate();

    await waitFor(() => {
      expect(screen.getByText(/admins only/i)).toBeTruthy();
    });
  });

  it("shows the error/retry state when the permission check fails", async () => {
    mockFetch(() => Promise.reject(new Error("network down")));
    await renderGate();

    await waitFor(() => {
      expect(screen.getByText(/couldn.t verify access/i)).toBeTruthy();
    });
  });

  it("renders children for any signed-in user when requireAdmin is false", async () => {
    const fetchSpy = vi.fn(() => jsonResponse(200, { isAdmin: false }));
    global.fetch = fetchSpy as unknown as typeof global.fetch;

    await renderGate(false);

    await waitFor(() => {
      expect(screen.getByText("SECRET ADMIN CONTENT")).toBeTruthy();
    });
    // Read-only gate must not hit the admin endpoint.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
