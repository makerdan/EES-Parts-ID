/**
 * End-to-end-style regression coverage for native map calibration.
 *
 * Unlike adminMapCalibration.test.tsx, this suite keeps the real
 * useMapAnchors hook mounted so the screen, authenticated request contract,
 * retry flow, and refreshed persisted state are tested together.
 */

// Required for act() in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { Alert } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
import type { RenderResult } from "@testing-library/react-native";
import { makeAppMock, flushPromises } from "./helpers/appMocks";
import type { MapAnchor } from "../hooks/useMapAnchors";

// ─── Stable native/router fixtures ────────────────────────────────────────────

const mockRouterBack = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ back: mockRouterBack }),
}));

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn<Promise<string | null>, [string]>().mockResolvedValue(null),
  setItem: jest.fn<Promise<void>, [string, string]>().mockResolvedValue(undefined),
  removeItem: jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined),
}));

jest.mock("@expo/vector-icons", () => require("./helpers/mapMocks").createVectorIconsMock());
jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());
jest.mock("react-native-reanimated", () => require("./helpers/mapMocks").createReanimatedMock());
jest.mock("react-native-svg", () => require("./helpers/mapMocks").createSvgMock());
jest.mock("expo-asset", () => require("./helpers/mapMocks").createExpoAssetMock());
jest.mock("@/utils/mapViewport", () => require("./helpers/mapMocks").createMapViewportMock());
jest.mock("@/utils/nearestZoneCorner", () => ({
  findNearestZoneCorner: jest.fn().mockReturnValue(null),
  DEFAULT_SNAP_DISTANCE: 200,
}));

// Keep the floor plan available so the real screen registers its tap gesture.
const mockPrefetchSvgAsset = jest.fn<Promise<void>, []>()
  .mockImplementation(() => new Promise<void>(() => {}));
jest.mock("@/components/WarehouseMapView", () => ({
  prefetchSvgAsset: mockPrefetchSvgAsset,
}));

jest.mock("@/utils/floorPlanCache", () => require("./helpers/mapMocks").createFloorPlanCacheMock());

// The real hook is intentionally not mocked in this suite.
jest.mock("@/utils/apiBase", () => ({ API_BASE: "http://api.test/api" }));

const { useWarehouseZones: mockUseWarehouseZones } = require("@/hooks/useWarehouseZones") as {
  useWarehouseZones: jest.Mock;
};
const mockRefetchZones = jest.fn<void, []>();
jest.mock("@/hooks/useWarehouseZones", () => ({
  useWarehouseZones: jest.fn(() => ({
    zones: [],
    alignment: { translateX: 0, translateY: 0, scale: 1 },
    alignmentStale: false,
    anchors: [],
    loading: false,
    error: false,
    refetch: mockRefetchZones,
  })),
  ZONES_CACHE_KEY: "parts_id_warehouse_zones_v1",
}));

const { useApp } = require("@/contexts/AppContext") as { useApp: jest.Mock };

import AdminMapCalibrationScreen from "../app/admin-map-calibration";

// ─── Stateful API fixture ─────────────────────────────────────────────────────

const SAVED_ANCHORS: MapAnchor[] = [
  { id: 1, name: "A1", svgX: 100, svgY: 200, worldX: 10, worldY: 20, updatedAt: "2026-09-02T00:00:00.000Z" },
  { id: 2, name: "A2", svgX: 300, svgY: 100, worldX: 30, worldY: 10, updatedAt: "2026-09-02T00:00:00.000Z" },
  { id: 3, name: "A3", svgX: 200, svgY: 400, worldX: 20, worldY: 40, updatedAt: "2026-09-02T00:00:00.000Z" },
];

const DEGENERATE_ANCHORS: MapAnchor[] = [
  { id: 1, name: "C1", svgX: 10, svgY: 10, worldX: 0, worldY: 0, updatedAt: "2026-09-02T00:00:00.000Z" },
  { id: 2, name: "C2", svgX: 20, svgY: 20, worldX: 10, worldY: 10, updatedAt: "2026-09-02T00:00:00.000Z" },
  { id: 3, name: "C3", svgX: 30, svgY: 30, worldX: 20, worldY: 20, updatedAt: "2026-09-02T00:00:00.000Z" },
];

type RequestRecord = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
  status: number;
};

let persistedAnchors: MapAnchor[] = [];
let requestLog: RequestRecord[] = [];
let failSlotTwoOnce = false;
let mockFetch: jest.Mock;

function cloneAnchors(anchors: MapAnchor[]): MapAnchor[] {
  return anchors.map((anchor) => ({ ...anchor }));
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function slotFromUrl(url: string): number {
  const match = url.match(/\/admin\/map-anchors\/([123])$/);
  if (!match) throw new Error(`Unexpected map-anchor URL: ${url}`);
  return Number(match[1]);
}

function makeFetchFixture(): jest.Mock {
  return jest.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const record: RequestRecord = { method, url, headers, status: 200 };

    if (method === "GET") {
      requestLog.push(record);
      return jsonResponse(200, { anchors: cloneAnchors(persistedAnchors) });
    }

    const slot = slotFromUrl(url);
    if (method === "PUT") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      record.body = body;
      if (slot === 2 && failSlotTwoOnce) {
        failSlotTwoOnce = false;
        record.status = 503;
        requestLog.push(record);
        return jsonResponse(503, { error: "temporary save failure" });
      }

      const savedAnchor: MapAnchor = {
        id: slot,
        name: String(body.name),
        svgX: Number(body.svgX),
        svgY: Number(body.svgY),
        worldX: Number(body.worldX),
        worldY: Number(body.worldY),
        updatedAt: "2026-09-02T00:00:00.000Z",
      };
      persistedAnchors = [
        ...persistedAnchors.filter((anchor) => anchor.id !== slot),
        savedAnchor,
      ].sort((a, b) => a.id - b.id);
      requestLog.push(record);
      return jsonResponse(200, { anchor: { ...savedAnchor } });
    }

    if (method === "DELETE") {
      persistedAnchors = persistedAnchors.filter((anchor) => anchor.id !== slot);
      requestLog.push(record);
      return jsonResponse(200, { deleted: true });
    }

    throw new Error(`Unexpected request method: ${method}`);
  });
}

// ─── Screen helpers ──────────────────────────────────────────────────────────

let activeTree: RenderResult | null = null;

async function settle(): Promise<void> {
  await act(async () => {
    await flushPromises();
  });
}

async function renderScreen(initialAnchors: MapAnchor[]): Promise<RenderResult> {
  persistedAnchors = cloneAnchors(initialAnchors);
  requestLog = [];
  failSlotTwoOnce = false;
  mockFetch = makeFetchFixture();
  global.fetch = mockFetch as unknown as typeof fetch;

  useApp.mockReturnValue(
    makeAppMock({ isAdmin: true, adminToken: "admin-tok", isLoading: false }),
  );
  mockUseWarehouseZones.mockReturnValue({
    zones: [],
    alignment: { translateX: 0, translateY: 0, scale: 1 },
    alignmentStale: false,
    anchors: [],
    loading: false,
    error: false,
    refetch: mockRefetchZones,
  });

  const tree = await render(<AdminMapCalibrationScreen />);
  await settle();
  return tree;
}

async function fireMapLayout(tree: RenderResult): Promise<void> {
  const layoutNodes = tree.root!.queryAll(
    (node) => typeof node.props.onLayout === "function",
    { includeSelf: true },
  );
  if (layoutNodes.length === 0) throw new Error("Calibration map did not expose an onLayout handler");

  await act(async () => {
    layoutNodes[0]!.props.onLayout({
      nativeEvent: { layout: { width: 500, height: 300, x: 0, y: 0 } },
    });
    await flushPromises();
  });
}

async function pressText(tree: RenderResult, text: string | RegExp): Promise<void> {
  const button = tree.getByText(text);
  await act(async () => {
    fireEvent.press(button);
    await flushPromises();
  });
}

function inputWithValue(tree: RenderResult, value: string): any {
  const input = tree.root!.queryAll(
    (node) => node.props.value === value,
    { includeSelf: true },
  )[0];
  if (!input) throw new Error(`Text input with value "${value}" not found`);
  return input;
}

function renderedText(value: unknown): string {
  if (Array.isArray(value)) return value.map(renderedText).join("");
  if (value && typeof value === "object" && "props" in value) {
    return renderedText((value as { props?: { children?: unknown } }).props?.children);
  }
  return value == null ? "" : String(value);
}

async function replaceAnchor(
  tree: RenderResult,
  index: number,
  point: { x: number; y: number },
): Promise<void> {
  const replaceButtons = tree.getAllByText("Re-place");
  await act(async () => {
    fireEvent.press(replaceButtons[index]!);
    await flushPromises();
  });
  await act(async () => {
    require("react-native-gesture-handler").__simulateTap(point);
    await flushPromises();
  });
}

function findDeleteButton(tree: RenderResult, slot: number): { props: { onPress: () => void } } {
  const title = tree.root!.queryAll(
    (node) =>
      node.type === "Text" &&
      renderedText(node.props.children).trim().startsWith(`Anchor ${slot}`),
    { includeSelf: true },
  )[0];
  if (!title) throw new Error(`Anchor ${slot} title not found`);
  const card = title.parent?.parent as any;
  if (!card) throw new Error(`Anchor ${slot} card not found`);

  const pressables = card.queryAll(
    (node: any) => typeof node.props.onPress === "function",
    { includeSelf: true },
  );
  const deleteButton = pressables[0];
  if (!deleteButton) throw new Error(`Clear button for anchor ${slot} not found`);
  return deleteButton as unknown as { props: { onPress: () => void } };
}

function requestMethods(): string[] {
  return requestLog.map((request) => request.method);
}

beforeEach(() => {
  const floorPlanCache = require("@/utils/floorPlanCache") as {
    getCachedData: jest.Mock;
    hasCachedData: jest.Mock;
  };
  floorPlanCache.getCachedData.mockReturnValue({
    xml: "<svg/>",
    contentViewBox: null,
    hash: "calibration-workflow",
  });
  floorPlanCache.hasCachedData.mockReturnValue(true);
  mockPrefetchSvgAsset.mockImplementation(() => new Promise<void>(() => {}));
  require("react-native-gesture-handler").__resetTap();
  failSlotTwoOnce = false;
});

afterEach(async () => {
  if (activeTree) {
    await activeTree.unmount();
    activeTree = null;
  }
  jest.clearAllMocks();

  const floorPlanCache = require("@/utils/floorPlanCache") as {
    getCachedData: jest.Mock;
    hasCachedData: jest.Mock;
  };
  floorPlanCache.getCachedData.mockReturnValue(null);
  floorPlanCache.hasCachedData.mockReturnValue(false);
  mockPrefetchSvgAsset.mockImplementation(() => new Promise<void>(() => {}));
  require("react-native-gesture-handler").__resetTap();
  (Alert.alert as jest.Mock).mockReset();
});

describe("native map calibration workflow", () => {
  it("loads anchors, drafts/reviews, retries a failed save, confirms, then clears one slot", async () => {
    activeTree = await renderScreen(SAVED_ANCHORS);
    expect(inputWithValue(activeTree, "A1")).not.toBeNull();
    expect(inputWithValue(activeTree, "A2")).not.toBeNull();
    expect(inputWithValue(activeTree, "A3")).not.toBeNull();
    expect(requestMethods()).toEqual(["GET"]);

    await fireMapLayout(activeTree);

    const renamedAnchors = ["North entrance", "South loading", "West aisle"];
    for (let index = 0; index < renamedAnchors.length; index++) {
      const oldName = `A${index + 1}`;
      const input = inputWithValue(activeTree, oldName);
      await act(async () => {
        fireEvent.changeText(input, renamedAnchors[index]!);
        await flushPromises();
      });
    }

    await replaceAnchor(activeTree, 0, { x: 50, y: 50 });
    await replaceAnchor(activeTree, 1, { x: 250, y: 100 });
    await replaceAnchor(activeTree, 2, { x: 400, y: 250 });

    expect(activeTree.getByText("Review Alignment →")).not.toBeNull();
    await pressText(activeTree, "Review Alignment →");
    expect(activeTree.getByText("Review Alignment")).not.toBeNull();
    expect(activeTree.getByText("Confirm & Apply")).not.toBeNull();
    expect(requestMethods()).toEqual(["GET"]);

    failSlotTwoOnce = true;
    await pressText(activeTree, /Confirm & Apply/i);

    expect(activeTree.getByText(/Could not save all anchors/i)).not.toBeNull();
    expect(requestMethods()).toEqual(["GET", "PUT", "GET", "PUT"]);

    await pressText(activeTree, /Confirm & Apply/i);
    expect(activeTree.getByText("Anchors active")).not.toBeNull();

    const putRequests = requestLog.filter((request) => request.method === "PUT");
    expect(putRequests.map((request) => slotFromUrl(request.url))).toEqual([1, 2, 1, 2, 3]);
    expect(putRequests.map((request) => request.status)).toEqual([200, 503, 200, 200, 200]);

    expect(putRequests[0]!.body).toEqual(expect.objectContaining({
      name: "North entrance",
      svgX: expect.any(Number),
      svgY: expect.any(Number),
      worldX: 10,
      worldY: 20,
    }));
    expect(putRequests[1]!.body).toEqual(expect.objectContaining({
      name: "South loading",
      svgX: expect.any(Number),
      svgY: expect.any(Number),
      worldX: 30,
      worldY: 10,
    }));
    expect(putRequests[4]!.body).toEqual(expect.objectContaining({
      name: "West aisle",
      svgX: expect.any(Number),
      svgY: expect.any(Number),
      worldX: 20,
      worldY: 40,
    }));
    expect(putRequests[2]!.body).toEqual(putRequests[0]!.body);
    expect(putRequests[3]!.body).toEqual(putRequests[1]!.body);

    const clearButton = findDeleteButton(activeTree, 1);
    (Alert.alert as jest.Mock).mockImplementation(
      (
        _title: string,
        _message: string,
        buttons?: Array<{ style?: string; onPress?: () => void }>,
      ) => {
        buttons?.find((button) => button.style === "destructive")?.onPress?.();
      },
    );
    await act(async () => {
      clearButton.props.onPress();
      await flushPromises();
    });

    expect(requestMethods()).toEqual([
      "GET", "PUT", "GET", "PUT",
      "PUT", "GET", "PUT", "GET", "PUT", "GET",
      "DELETE", "GET",
    ]);
    expect(requestLog.every((request) =>
      request.headers.Authorization === "Bearer admin-tok",
    )).toBe(true);
    expect(requestLog.filter((request) => request.method === "PUT").every((request) =>
      request.headers["Content-Type"] === "application/json",
    )).toBe(true);

    expect(persistedAnchors.map((anchor) => anchor.id)).toEqual([2, 3]);
    expect(activeTree.queryAllByText("Not placed")).toHaveLength(1);
    expect(inputWithValue(activeTree, "South loading")).not.toBeNull();
    expect(inputWithValue(activeTree, "West aisle")).not.toBeNull();
    expect(activeTree.root!.queryAll(
      (node) => node.props.value === "North entrance",
      { includeSelf: true },
    )).toHaveLength(0);
  });

  it("does not send mutations for incomplete or degenerate calibration input", async () => {
    activeTree = await renderScreen([]);
    expect(activeTree.queryByText("Review Alignment →")).toBeNull();
    expect(requestMethods()).toEqual(["GET"]);
    expect(requestLog.some((request) => request.method !== "GET")).toBe(false);

    await activeTree.unmount();
    activeTree = null;

    activeTree = await renderScreen(DEGENERATE_ANCHORS);
    expect(activeTree.getByText(/collinear or overlap/i)).not.toBeNull();
    expect(activeTree.queryByText("Review Alignment →")).toBeNull();
    expect(requestMethods()).toEqual(["GET"]);
    expect(requestLog.some((request) => request.method !== "GET")).toBe(false);
  });
});