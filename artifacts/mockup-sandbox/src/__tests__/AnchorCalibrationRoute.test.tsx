/**
 * Routed regression coverage for the web Anchor Calibration admin tool.
 *
 * This intentionally mounts App rather than AnchorCalibration directly so the
 * test covers the Clerk-backed AdminGate and the real /anchor-calibration route.
 */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const authState = {
  isLoaded: true,
  isSignedIn: true,
};

const redirectToSignIn = vi.fn();
const signOut = vi.fn();

vi.mock("@clerk/react", () => ({
  ClerkProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SignIn: () => null,
  SignUp: () => null,
  useAuth: () => authState,
  useClerk: () => ({ redirectToSignIn, signOut }),
}));

vi.mock("../auth/clerkConfig", () => ({
  basePath: "",
  clerkAppearance: {},
  clerkLocalization: {},
  clerkProxyUrl: undefined,
  clerkPubKey: "pk_test_anchor_calibration",
  stripBase: (path: string) => path,
}));

import App from "../App";

type Anchor = {
  id: number;
  name: string;
  svgX: number;
  svgY: number;
  worldX: number;
  worldY: number;
  updatedAt: string;
};

type FixtureOptions = {
  admin?: boolean;
  rejectSaves?: boolean;
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(""),
  } as unknown as Response;
}

function textResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.reject(new Error("not JSON")),
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

function makeApiFixture(options: FixtureOptions = {}) {
  const persisted = new Map<number, Anchor>();
  const calls: Array<[string, RequestInit | undefined]> = [];
  const admin = options.admin ?? true;
  const rejectSaves = options.rejectSaves ?? false;

  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    calls.push([url, init]);
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";

    if (path === "/api/admin/me") {
      return Promise.resolve(jsonResponse(200, { isAdmin: admin }));
    }

    if (path === "/api/floor-plan/svg") {
      return Promise.resolve(
        textResponse(
          200,
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 800"><rect width="1000" height="800" /></svg>',
        ),
      );
    }

    if (path === "/api/warehouse-zones" && method === "GET") {
      return Promise.resolve(
        jsonResponse(200, {
          zones: [
            { id: 7, svgX: 100, svgY: 120, svgWidth: 180, svgHeight: 90 },
            { id: 8, svgX: 400, svgY: 320, svgWidth: 220, svgHeight: 100 },
          ],
        }),
      );
    }

    if (path === "/api/warehouse-zones/alignment" && method === "GET") {
      return Promise.resolve(
        jsonResponse(200, {
          translateX: 18,
          translateY: -7,
          scale: 1.25,
        }),
      );
    }

    if (path === "/api/admin/map-anchors" && method === "GET") {
      return Promise.resolve(
        jsonResponse(200, {
          anchors: [...persisted.values()].sort((a, b) => a.id - b.id),
        }),
      );
    }

    const slotMatch = path.match(/^\/api\/admin\/map-anchors\/([1-3])$/);
    if (slotMatch && method === "PUT") {
      if (rejectSaves) {
        return Promise.resolve(
          jsonResponse(422, { error: "Calibration rejected by server" }),
        );
      }

      const slot = Number(slotMatch[1]);
      const body = JSON.parse(String(init?.body)) as Omit<Anchor, "id" | "updatedAt">;
      const anchor: Anchor = {
        id: slot,
        ...body,
        updatedAt: "2026-09-02T00:00:00.000Z",
      };
      persisted.set(slot, anchor);
      return Promise.resolve(jsonResponse(200, { anchor }));
    }

    if (slotMatch && method === "DELETE") {
      persisted.delete(Number(slotMatch[1]));
      return Promise.resolve(jsonResponse(200, { deleted: true }));
    }

    return Promise.resolve(jsonResponse(404, { error: "Unhandled test request" }));
  });

  return { persisted, calls, fetchMock };
}

function setCalibrationRoute() {
  window.history.replaceState({}, "", "/anchor-calibration");
}

function mockMapRect(svg: SVGSVGElement) {
  vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: 800,
    bottom: 600,
    width: 800,
    height: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

async function renderRoute() {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<App />);
  });
  await waitFor(() => {
    expect(screen.getByText("Admin — Anchor Calibration")).toBeTruthy();
  });
  return result;
}

async function placePoint(
  svg: SVGSVGElement,
  placeButton: HTMLElement,
  screenX: number,
  screenY: number,
) {
  await act(async () => {
    fireEvent.click(placeButton);
  });
  await act(async () => {
    fireEvent.mouseDown(svg, { button: 0, clientX: screenX, clientY: screenY });
    fireEvent.mouseUp(svg, { clientX: screenX, clientY: screenY });
  });
}

async function fillSlot(
  slot: number,
  name: string,
  worldX: string,
  worldY: string,
) {
  const inputs = screen.getAllByRole("textbox");
  await act(async () => {
    fireEvent.change(inputs[slot * 3]!, { target: { value: name } });
    fireEvent.change(inputs[slot * 3 + 1]!, { target: { value: worldX } });
    fireEvent.change(inputs[slot * 3 + 2]!, { target: { value: worldY } });
  });
}

describe("web Anchor Calibration routed workflow", () => {
  beforeEach(() => {
    authState.isLoaded = true;
    authState.isSignedIn = true;
    redirectToSignIn.mockReset();
    signOut.mockReset();
    setCalibrationRoute();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    setCalibrationRoute();
  });

  it("loads, places, saves, reloads, and clears persisted calibration anchors", async () => {
    const fixture = makeApiFixture();
    global.fetch = fixture.fetchMock as unknown as typeof global.fetch;
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const { container } = await renderRoute();
    const svg = container.querySelector("svg")!;
    mockMapRect(svg);

    const points = [
      { x: 180, y: 120, name: "North Door", worldX: "12.5", worldY: "7.3" },
      { x: 260, y: 180, name: "Rack B", worldX: "50", worldY: "25" },
      { x: 340, y: 240, name: "Packing Bench", worldX: "-4", worldY: "31.25" },
    ];

    for (const [slot, point] of points.entries()) {
      const placeButtons = screen.getAllByRole("button", { name: /^Place$/ });
      await placePoint(svg, placeButtons[0]!, point.x, point.y);
      await fillSlot(slot, point.name, point.worldX, point.worldY);

      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: `Save Anchor ${slot + 1}` }),
        );
      });
      await waitFor(() => {
        expect(screen.getByText(new RegExp(`Anchor ${slot + 1} saved\\.`))).toBeTruthy();
      });
    }

    expect(fixture.persisted.size).toBe(3);
    for (const [slot, point] of points.entries()) {
      const anchor = fixture.persisted.get(slot + 1)!;
      expect(anchor.name).toBe(point.name);
      expect(anchor.worldX).toBe(Number(point.worldX));
      expect(anchor.worldY).toBe(Number(point.worldY));
      expect(anchor.svgX).toBeCloseTo((point.x - 40) / 0.18, 2);
      expect(anchor.svgY).toBeCloseTo((point.y - 40) / 0.18, 2);
    }

    const protectedCalls = fixture.calls.filter(([url]) => {
      const path = new URL(url).pathname;
      return (
        path.includes("/admin/map-anchors") ||
        path === "/api/warehouse-zones/alignment"
      );
    });
    expect(protectedCalls.length).toBeGreaterThan(0);
    expect(
      protectedCalls.every(([, init]) => init?.credentials === "include"),
    ).toBe(true);

    const firstPut = fixture.calls.find(
      ([url, init]) =>
        new URL(url).pathname === "/api/admin/map-anchors/1" &&
        init?.method === "PUT",
    );
    expect(firstPut).toBeTruthy();
    expect(JSON.parse(String(firstPut![1]?.body))).toMatchObject({
      name: "North Door",
      worldX: 12.5,
      worldY: 7.3,
      svgX: expect.closeTo((180 - 40) / 0.18, 2),
      svgY: expect.closeTo((120 - 40) / 0.18, 2),
    });

    cleanup();
    const { container: reloadedContainer } = await renderRoute();

    await waitFor(() => {
      const inputs = screen.getAllByRole("textbox");
      expect((inputs[0] as HTMLInputElement).value).toBe("North Door");
      expect((inputs[1] as HTMLInputElement).value).toBe("12.5");
      expect((inputs[2] as HTMLInputElement).value).toBe("7.3");
      expect((inputs[3] as HTMLInputElement).value).toBe("Rack B");
      expect((inputs[6] as HTMLInputElement).value).toBe("Packing Bench");
    });
    expect(screen.getByText("3/3 saved · scroll to zoom · drag to pan · 18%")).toBeTruthy();
    expect(
      reloadedContainer.querySelector('g[transform="translate(18,-7) scale(1.25)"]'),
    ).toBeTruthy();

    const clearButtons = screen.getAllByRole("button", { name: "Clear" });
    await act(async () => {
      fireEvent.click(clearButtons[2]!);
    });
    await waitFor(() => {
      expect(fixture.persisted.size).toBe(2);
      expect(screen.getAllByText("Not placed").length).toBe(1);
    });
    expect(
      fixture.calls.some(
        ([url, init]) =>
          new URL(url).pathname === "/api/admin/map-anchors/3" &&
          init?.method === "DELETE" &&
          init.credentials === "include",
      ),
    ).toBe(true);
  });

  it("shows rejected saves without mutating data and blocks non-admins before protected loads", async () => {
    const rejectedFixture = makeApiFixture({ rejectSaves: true });
    global.fetch = rejectedFixture.fetchMock as unknown as typeof global.fetch;

    const { container } = await renderRoute();
    const svg = container.querySelector("svg")!;
    mockMapRect(svg);
    await placePoint(
      svg,
      screen.getAllByRole("button", { name: /^Place$/ })[0]!,
      220,
      160,
    );
    await fillSlot(0, "Rejected Anchor", "9", "11");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save Anchor 1" }));
    });
    await waitFor(() => {
      expect(screen.getByText(/Calibration rejected by server/)).toBeTruthy();
    });
    expect(rejectedFixture.persisted.size).toBe(0);
    expect(
      rejectedFixture.calls.some(
        ([url, init]) =>
          new URL(url).pathname === "/api/admin/map-anchors/1" &&
          init?.method === "PUT" &&
          init.credentials === "include",
      ),
    ).toBe(true);

    cleanup();
    authState.isSignedIn = true;
    const deniedFixture = makeApiFixture({ admin: false });
    global.fetch = deniedFixture.fetchMock as unknown as typeof global.fetch;
    setCalibrationRoute();
    await act(async () => {
      render(<App />);
    });

    await waitFor(() => {
      expect(screen.getByText("Admins only")).toBeTruthy();
    });
    expect(
      deniedFixture.calls.every(
        ([url]) => new URL(url).pathname === "/api/admin/me",
      ),
    ).toBe(true);
    expect(
      deniedFixture.calls.some(([url]) =>
        new URL(url).pathname.includes("/api/admin/map-anchors"),
      ),
    ).toBe(false);
    expect(
      deniedFixture.calls.some(([url]) =>
        new URL(url).pathname.includes("/api/warehouse-zones"),
      ),
    ).toBe(false);
  });
});