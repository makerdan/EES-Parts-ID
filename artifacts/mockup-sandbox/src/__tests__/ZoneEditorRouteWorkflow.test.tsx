/**
 * Route-level regression coverage for the web Zone Editor.
 *
 * Unlike the focused ZoneEditor tests, these cases mount App so the real
 * wouter route, Clerk provider boundary, and AdminGate all participate.
 */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const clerkMock = vi.hoisted(() => ({
  authState: { isLoaded: true, isSignedIn: true },
  useClerk: () => ({ redirectToSignIn: vi.fn(), signOut: vi.fn() }),
}));

vi.mock("@clerk/react", () => ({
  ClerkProvider: ({ children }: { children: React.ReactNode }) => children,
  SignIn: () => null,
  SignUp: () => null,
  useAuth: () => clerkMock.authState,
  useClerk: clerkMock.useClerk,
}));

vi.mock("../auth/clerkConfig", () => ({
  clerkPubKey: "pk_test_zone_editor_workflow",
  clerkProxyUrl: undefined,
  clerkAppearance: {},
  clerkLocalization: {},
  basePath: "",
  stripBase: (path: string) => path,
}));

import App from "../App";

type Zone = {
  id: number;
  aisleId: string;
  sectionNum: number | null;
  isInventory: boolean;
  svgX: number;
  svgY: number;
  svgWidth: number;
  svgHeight: number;
  sortOrder: number;
};

type FetchCall = [input: RequestInfo | URL, init: RequestInit | undefined];

const INITIAL_ZONE: Zone = {
  id: 7,
  aisleId: "12",
  sectionNum: 1,
  isInventory: true,
  svgX: 100,
  svgY: 100,
  svgWidth: 200,
  svgHeight: 150,
  sortOrder: 3,
};

const FLOOR_PLAN_SVG = `
  <svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800" viewBox="0 0 1000 800">
    <rect width="1000" height="800" fill="#f8fafc"/>
    <path d="M 10 10 H 990 V 790 H 10 Z" fill="none" stroke="#111827"/>
  </svg>
`;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(""),
  } as Response;
}

function requestMethod(init?: RequestInit): string {
  return (init?.method ?? "GET").toUpperCase();
}

function requestPath(input: RequestInfo | URL): string {
  return String(input);
}

function makeApiFetch(options: { admin?: boolean; patchOk?: boolean } = {}) {
  let zones = [{ ...INITIAL_ZONE }];
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([input, init]);
    const path = requestPath(input);
    const method = requestMethod(init);

    if (path.includes("/admin/me")) {
      return jsonResponse(200, { isAdmin: options.admin ?? true });
    }

    if (path.includes("/floor-plan/svg")) {
      return new Response(FLOOR_PLAN_SVG, { status: 200, headers: { "Content-Type": "image/svg+xml" } });
    }

    if (method === "GET" && path.endsWith("/warehouse-zones/coverage")) {
      return jsonResponse(200, { unsortedCount: 0, uncoveredAisles: [] });
    }

    if (method === "GET" && path.endsWith("/warehouse-zones")) {
      return jsonResponse(200, { zones: zones.map((zone) => ({ ...zone })) });
    }

    if (method === "PATCH" && /\/warehouse-zones\/\d+$/.test(path)) {
      if (options.patchOk === false) {
        return jsonResponse(500, { error: "Zone update rejected by server" });
      }
      const id = Number(path.split("/").pop());
      const updates = JSON.parse(String(init?.body ?? "{}")) as Partial<Zone>;
      const zone = zones.find((candidate) => candidate.id === id);
      if (!zone) return jsonResponse(404, { error: "Zone not found" });
      Object.assign(zone, updates);
      return jsonResponse(200, { zone: { ...zone } });
    }

    throw new Error(`Unexpected ${method} request: ${path}`);
  });

  return {
    fetchMock,
    calls,
    get zones() {
      return zones;
    },
  };
}

function getZoneRects(container: HTMLElement): SVGRectElement[] {
  return [...container.querySelectorAll("rect")].filter(
    (rect) => rect.getAttribute("fill")?.startsWith("rgba(0, 112, 255"),
  ) as SVGRectElement[];
}

function setSvgBounds(container: HTMLElement) {
  const svg = container.querySelector("svg");
  expect(svg).not.toBeNull();
  vi.spyOn(svg!, "getBoundingClientRect").mockReturnValue({
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
  return svg as SVGSVGElement;
}

async function renderRoute() {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<App />);
  });
  await waitFor(() => {
    expect(screen.getByText("Admin — Zone Editor")).toBeTruthy();
    expect(getZoneRects(result.container)).toHaveLength(1);
  });
  const svg = setSvgBounds(result.container);
  return { ...result, svg };
}

async function selectZone(container: HTMLElement) {
  const [zoneRect] = getZoneRects(container);
  expect(zoneRect).toBeDefined();
  await act(async () => {
    fireEvent.mouseDown(zoneRect!, { clientX: 36, clientY: 31.5, button: 0 });
    document.dispatchEvent(new MouseEvent("mouseup", {
      clientX: 36,
      clientY: 31.5,
      button: 0,
      bubbles: true,
    }));
  });
  await waitFor(() => {
    expect(container.querySelector('input[placeholder="e.g. 09 or 22"]')).not.toBeNull();
  });
}

function getZoneInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[placeholder="e.g. 09 or 22"]') as HTMLInputElement;
}

function getSaveStatus(container: HTMLElement): string {
  return container.querySelector("[data-testid='save-status-row'] span")?.textContent ?? "";
}

function getMutationCalls(fetchMock: ReturnType<typeof makeApiFetch>["fetchMock"]) {
  return fetchMock.mock.calls.filter(([, init]) => {
    const method = requestMethod(init);
    return method === "POST" || method === "PATCH" || method === "DELETE";
  });
}

describe("web Zone Editor route workflow", () => {
  beforeEach(() => {
    clerkMock.authState.isLoaded = true;
    clerkMock.authState.isSignedIn = true;
    window.history.replaceState({}, "", "/zone-editor");
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
    localStorage.clear();
  });

  it("lets an admin move and relabel a zone, persists both changes, and renders them after reload", async () => {
    const api = makeApiFetch();
    global.fetch = api.fetchMock as unknown as typeof global.fetch;
    const firstRender = await renderRoute();
    const { container, svg } = firstRender;

    await selectZone(container);

    // Move the selected rectangle by (+50, +50) in SVG coordinates. The
    // default editor scale is 0.18, so these screen coordinates are exact.
    const [zoneRect] = getZoneRects(container);
    await act(async () => {
      fireEvent.mouseDown(zoneRect!, { clientX: 36, clientY: 31.5, button: 0 });
      fireEvent.mouseMove(document, { clientX: 45, clientY: 40.5 });
      fireEvent.mouseUp(document, { clientX: 45, clientY: 40.5 });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      const geometryPatch = api.fetchMock.mock.calls.find(([, init]) => {
        if (requestMethod(init) !== "PATCH") return false;
        const body = JSON.parse(String(init?.body ?? "{}")) as Partial<Zone>;
        return body.svgX === 150 && body.svgY === 150;
      });
      expect(geometryPatch).toBeDefined();
    });

    const aisleInput = getZoneInput(container);
    await act(async () => {
      fireEvent.change(aisleInput, { target: { value: "22" } });
    });
    expect(getSaveStatus(container)).toBe("Unsaved changes ●");

    const saveButton = container.querySelector("[data-testid='save-status-row'] button");
    expect(saveButton).not.toBeNull();
    await act(async () => {
      fireEvent.click(saveButton!);
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getSaveStatus(container)).toBe("All changes saved");
    });

    const metadataPatch = api.fetchMock.mock.calls.find(([, init]) => {
      if (requestMethod(init) !== "PATCH") return false;
      const body = JSON.parse(String(init?.body ?? "{}")) as Partial<Zone>;
      return body.aisleId === "22" && body.sectionNum === 1 && body.sortOrder === 3;
    });
    expect(metadataPatch).toBeDefined();
    expect(getMutationCalls(api.fetchMock)).toHaveLength(2);
    expect(api.zones[0]).toMatchObject({
      aisleId: "22",
      svgX: 150,
      svgY: 150,
      svgWidth: 200,
      svgHeight: 150,
      sectionNum: 1,
      sortOrder: 3,
    });

    cleanup();
    window.history.replaceState({}, "", "/zone-editor");
    const reloaded = await renderRoute();
    expect(reloaded.svg).not.toBe(svg);
    expect(getZoneRects(reloaded.container)[0]?.getAttribute("x")).toBe("150");
    expect(getZoneRects(reloaded.container)[0]?.getAttribute("y")).toBe("150");

    await selectZone(reloaded.container);
    expect(getZoneInput(reloaded.container).value).toBe("22");
  });

  it("keeps the editor protected for a signed-in non-admin and never requests zone data", async () => {
    const api = makeApiFetch({ admin: false });
    global.fetch = api.fetchMock as unknown as typeof global.fetch;

    await act(async () => {
      render(<App />);
    });

    await waitFor(() => {
      expect(screen.getByText("Admins only")).toBeTruthy();
    });
    expect(api.fetchMock.mock.calls.some(([input]) => requestPath(input).includes("/warehouse-zones"))).toBe(false);
    expect(getMutationCalls(api.fetchMock)).toHaveLength(0);
    expect(screen.queryByText("Admin — Zone Editor")).toBeNull();
  });

  it("shows an actionable save error and does not report success when the API rejects an edit", async () => {
    const api = makeApiFetch({ patchOk: false });
    global.fetch = api.fetchMock as unknown as typeof global.fetch;
    const { container } = await renderRoute();

    await selectZone(container);
    await act(async () => {
      fireEvent.change(getZoneInput(container), { target: { value: "22" } });
    });
    expect(getSaveStatus(container)).toBe("Unsaved changes ●");

    const saveButton = container.querySelector("[data-testid='save-status-row'] button");
    expect(saveButton).not.toBeNull();
    await act(async () => {
      fireEvent.click(saveButton!);
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getSaveStatus(container)).toBe("Save failed — retry");
    });
    expect(getSaveStatus(container)).not.toBe("All changes saved");
    expect(api.zones[0]!.aisleId).toBe("12");
    expect(container.querySelector("[data-testid='save-status-row'] button")?.textContent).toBe("Retry");
  });
});