import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

const authState = {
  isLoaded: true,
  isSignedIn: true,
};
const redirectToSignIn = vi.fn();
const signOut = vi.fn();

vi.mock("@clerk/react", () => ({
  ClerkProvider: ({ children }: { children: React.ReactNode }) => children,
  SignIn: () => null,
  SignUp: () => null,
  useAuth: () => authState,
  useClerk: () => ({ redirectToSignIn, signOut }),
}));

vi.mock("../auth/clerkConfig", () => ({
  clerkPubKey: "test-publishable-key",
  clerkProxyUrl: undefined,
  clerkAppearance: {},
  clerkLocalization: {},
  basePath: "",
  stripBase: (path: string) => path,
}));

import App from "../App";

const FLOOR_PLAN_XML =
  '<svg viewBox="0 0 1000 600"><path id="loaded-floor-plan" d="M0 0H1000V600Z"/></svg>';

const ZONE = {
  id: 7,
  aisleId: "7",
  label: "Aisle 7",
  sectionNum: 0,
  isInventory: true,
  svgX: 240,
  svgY: 160,
  svgWidth: 300,
  svgHeight: 180,
  sortOrder: 0,
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(""),
  } as Response;
}

function floorPlanResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(FLOOR_PLAN_XML),
  } as Response;
}

function setWarehouseMapRoute() {
  window.history.replaceState({}, "", "/warehouse-map");
}

beforeEach(() => {
  authState.isLoaded = true;
  authState.isSignedIn = true;
  redirectToSignIn.mockReset();
  signOut.mockReset();
  setWarehouseMapRoute();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("Warehouse Map routed workflow", () => {
  it("loads the protected route from permission checking into one SVG scene with zones", async () => {
    let resolveAdmin!: (value: Response) => void;
    const adminResponse = new Promise<Response>((resolve) => {
      resolveAdmin = resolve;
    });
    const fetchMock = vi.fn((...args: [RequestInfo | URL, RequestInit?]) => {
      const [input] = args;
      const url = String(input);
      if (url.endsWith("/admin/me")) return adminResponse;
      if (url.endsWith("/floor-plan/svg")) return Promise.resolve(floorPlanResponse());
      if (url.endsWith("/warehouse-zones")) {
        return Promise.resolve(jsonResponse({ zones: [ZONE] }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(screen.getByText("Checking permissions…")).toBeTruthy();

    await act(async () => {
      resolveAdmin(jsonResponse({ isAdmin: true }));
    });

    await waitFor(() => {
      expect(screen.getByText("Admin — Warehouse Map Viewer")).toBeTruthy();
      expect(screen.getByText("Aisle 7")).toBeTruthy();
    });

    const scene = document.querySelector("svg");
    expect(scene).toBeTruthy();
    expect(document.querySelectorAll("svg")).toHaveLength(1);
    expect(scene?.querySelector("#loaded-floor-plan")).toBeTruthy();
    expect(scene?.querySelector("rect")).toBeTruthy();
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/admin/me"),
        expect.stringContaining("/floor-plan/svg"),
        expect.stringContaining("/warehouse-zones"),
      ]),
    );
  });

  it("aborts and ignores a pending floor-plan response when the routed viewer unmounts", async () => {
    let resolveAdmin!: (value: Response) => void;
    const adminResponse = new Promise<Response>((resolve) => {
      resolveAdmin = resolve;
    });
    let resolveFloorPlan!: (value: Response) => void;
    const pendingFloorPlan = new Promise<Response>((resolve) => {
      resolveFloorPlan = resolve;
    });
    const fetchMock = vi.fn((...args: [RequestInfo | URL, RequestInit?]) => {
      const [input] = args;
      const url = String(input);
      if (url.endsWith("/admin/me")) return adminResponse;
      if (url.endsWith("/floor-plan/svg")) return pendingFloorPlan;
      if (url.endsWith("/warehouse-zones")) {
        return Promise.resolve(jsonResponse({ zones: [] }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<App />);
    await act(async () => {
      resolveAdmin(jsonResponse({ isAdmin: true }));
    });

    await waitFor(() => {
      expect(screen.getByText("Admin — Warehouse Map Viewer")).toBeTruthy();
    });

    const floorPlanCall = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith("/floor-plan/svg"),
    );
    const signal = floorPlanCall?.[1]?.signal;
    expect(signal).toBeDefined();

    view.unmount();
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      resolveFloorPlan(floorPlanResponse());
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.querySelector("#loaded-floor-plan")).toBeNull();
  });

  it("denies a signed-in non-admin before requesting protected map data", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/admin/me")) {
        return Promise.resolve(jsonResponse({ isAdmin: false }));
      }
      throw new Error(`Protected map request should not run: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Admins only")).toBeTruthy();
    });
    expect(screen.queryByText("Admin — Warehouse Map Viewer")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/admin/me");
  });
});