/**
 * Tests that the "Map Tools" section in AdminDashboardScreen renders correctly.
 *
 * `zoneEditorUrl` and `warehouseMapUrl` are derived at render time from
 * `process.env.EXPO_PUBLIC_DOMAIN`, so tests control visibility by setting or
 * clearing that variable before each render.
 *
 * Cases covered:
 *   A) adminToken set + EXPO_PUBLIC_DOMAIN configured → Zone Editor and
 *      Warehouse Map rows are present and call Linking.openURL
 *   B) adminToken set + EXPO_PUBLIC_DOMAIN unset → Map Tools section absent
 *   C) adminToken absent (non-admin) → shows "Not found", Map Tools rows absent
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { render, act } from "@testing-library/react-native";
import type { RenderResult } from "@testing-library/react-native";

// ─── expo-router ─────────────────────────────────────────────────────────────

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), navigate: jest.fn() }),
  useFocusEffect: jest.fn(),
}));

// ─── expo-sharing ────────────────────────────────────────────────────────────

jest.mock("expo-sharing", () => ({
  isAvailableAsync: jest.fn().mockResolvedValue(false),
  shareAsync:       jest.fn().mockResolvedValue(undefined),
}));

// ─── react-native-svg ────────────────────────────────────────────────────────

jest.mock("react-native-svg", () => {
  const React = require("react");
  const make = (tag: string) =>
    function SvgEl({ children, ...props }: Record<string, unknown>) {
      return React.createElement(tag, props, children);
    };
  return {
    __esModule: true,
    default:    make("svg"),
    Svg:        make("svg"),
    Rect:       make("rect"),
    Text:       make("svg-text"),
    Circle:     make("circle"),
    G:          make("g"),
    Path:       make("path"),
  };
});

// ─── @expo/vector-icons ──────────────────────────────────────────────────────

jest.mock("@expo/vector-icons", () => ({
  Feather: function FeatherIcon() { return null; },
}));

// ─── @/hooks/useColors ───────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background:        "#fff",
    foreground:        "#000",
    card:              "#f9f9f9",
    border:            "#e0e0e0",
    primary:           "#007aff",
    primaryForeground: "#fff",
    mutedForeground:   "#888",
    muted:             "#f0f0f0",
    destructive:       "#ff3b30",
    warning:           "#f59e0b",
  }),
}));

// ─── @/utils/apiBase ─────────────────────────────────────────────────────────

jest.mock("@/utils/apiBase", () => ({
  API_BASE: "http://localhost:3001/api",
}));

// ─── @/utils/exportCsv ───────────────────────────────────────────────────────

jest.mock("@/utils/exportCsv", () => ({
  serializeDashboardToCsv: jest.fn().mockReturnValue(""),
}));

// ─── @/contexts/ApiHealthContext ─────────────────────────────────────────────
// Override the moduleNameMapper-mapped mock with a stable object so that
// `reportNetworkFailure` keeps the same reference across re-renders.
// Without this, useApiHealth() returns a new object every call, which makes
// the fetchStats useCallback re-created every render, causing an infinite loop.

jest.mock("@/contexts/ApiHealthContext", () => {
  const stable = { reportNetworkFailure: jest.fn() };
  return {
    useApiHealth: () => stable,
    ApiHealthProvider: ({ children }: { children: unknown }) => children,
  };
});

// ─── AppContext — mapped by jest.config.js ────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useApp } = require("@/contexts/AppContext") as { useApp: jest.Mock };

// ─── global fetch ─────────────────────────────────────────────────────────────
// Admin screen fetches /admin/dashboard-stats on mount.
// Provide a minimal valid stats response so the ScrollView (and the Map Tools
// section within it) actually renders. The Map Tools rows live inside the
// `stats ? (<ScrollView>…</ScrollView>)` branch — they are never mounted when
// stats is null (error or loading state).

const MOCK_STATS = {
  ai:          { totalAllTime: 0, totalThisMonth: 0, byFeature: [] },
  screenViews: { totalAllTime: 0, uniqueVisitorsToday: 0, byScreen: [], dailyLast30Days: [] },
  summary:     { inventoryItems: 0, catalogJobsDone: 0, contactMessages: 0 },
};

beforeEach(() => {
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(MOCK_STATS),
    } as Response),
  ) as jest.Mock;
});

// ─── Subject under test ───────────────────────────────────────────────────────

import AdminScreen from "../app/admin";

// ─── Saved env state ──────────────────────────────────────────────────────────

const ORIGINAL_DOMAIN = process.env.EXPO_PUBLIC_DOMAIN;

// ─── Per-test teardown ────────────────────────────────────────────────────────

let activeTree: RenderResult | null = null;

afterEach(async () => {
  if (activeTree) {
    await activeTree.unmount();
    activeTree = null;
  }
  if (ORIGINAL_DOMAIN !== undefined) {
    process.env.EXPO_PUBLIC_DOMAIN = ORIGINAL_DOMAIN;
  } else {
    delete process.env.EXPO_PUBLIC_DOMAIN;
  }
  jest.clearAllMocks();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const flushPromises = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });

function makeAdminApp(overrides: Record<string, unknown> = {}) {
  return {
    isLoading:  false,
    adminToken: "tok-admin",
    isAdmin:    true,
    ...overrides,
  };
}

function instText(node: RenderResult["root"] | string): string {
  if (typeof node === "string") return node;
  if (!node) return "";
  return ((node as { children?: unknown[] }).children ?? [])
    .map((c) => instText(c as RenderResult["root"] | string))
    .join("");
}

function hasText(root: RenderResult["root"], text: string): boolean {
  return instText(root).includes(text);
}

function findPressablesByAccessibilityLabel(root: RenderResult["root"], label: string) {
  return root!.queryAll(
    (n) =>
      (n.type as string) === "rn-pressable" &&
      n.props.accessibilityLabel === label,
    { includeSelf: true },
  );
}

function findPressablesByText(root: RenderResult["root"], text: string) {
  return root!.queryAll(
    (n) => (n.type as string) === "rn-pressable" && instText(n).includes(text),
    { includeSelf: true },
  );
}

async function renderAdmin() {
  const tree = await render(<AdminScreen />);
  activeTree = tree;
  await flushPromises();
  return tree;
}

// =============================================================================
// A) adminToken set + EXPO_PUBLIC_DOMAIN set → Map Tools rows present
// =============================================================================

describe("AdminDashboardScreen — Map Tools section with domain configured", () => {
  beforeEach(() => {
    process.env.EXPO_PUBLIC_DOMAIN = "prod.example.com";
    useApp.mockReturnValue(makeAdminApp());
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Linking } = require("react-native") as typeof import("react-native");
    (Linking.openURL as jest.Mock).mockClear();
  });

  it("shows the 'Map Tools' section header", async () => {
    const tree = await renderAdmin();
    expect(hasText(tree.root, "Map Tools")).toBe(true);
  });

  it("renders a 'Zone Editor' pressable row", async () => {
    const tree = await renderAdmin();
    expect(findPressablesByText(tree.root, "Zone Editor")).toHaveLength(1);
  });

  it("renders a 'Warehouse Map' pressable row", async () => {
    const tree = await renderAdmin();
    expect(findPressablesByText(tree.root, "Warehouse Map")).toHaveLength(1);
  });

  it("pressing Zone Editor calls Linking.openURL with the correct URL", async () => {
    const tree = await renderAdmin();
    const [btn] = findPressablesByAccessibilityLabel(tree.root, "Open Zone Editor");
    await act(async () => { btn!.props.onPress(); });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Linking } = require("react-native") as typeof import("react-native");
    expect(Linking.openURL).toHaveBeenCalledWith(
      "https://prod.example.com/__mockup/zone-editor",
    );
  });

  it("pressing Warehouse Map calls Linking.openURL with the correct URL", async () => {
    const tree = await renderAdmin();
    const [btn] = findPressablesByAccessibilityLabel(tree.root, "Open Warehouse Map");
    await act(async () => { btn!.props.onPress(); });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Linking } = require("react-native") as typeof import("react-native");
    expect(Linking.openURL).toHaveBeenCalledWith(
      "https://prod.example.com/__mockup/warehouse-map",
    );
  });
});

// =============================================================================
// B) adminToken set + EXPO_PUBLIC_DOMAIN unset → Map Tools section absent
// =============================================================================

describe("AdminDashboardScreen — Map Tools section absent when domain unset", () => {
  beforeEach(() => {
    delete process.env.EXPO_PUBLIC_DOMAIN;
    useApp.mockReturnValue(makeAdminApp());
  });

  it("does NOT show 'Map Tools' section header", async () => {
    const tree = await renderAdmin();
    expect(hasText(tree.root, "Map Tools")).toBe(false);
  });

  it("does NOT render a 'Zone Editor' row", async () => {
    const tree = await renderAdmin();
    expect(findPressablesByText(tree.root, "Zone Editor")).toHaveLength(0);
  });

  it("does NOT render a 'Warehouse Map' row", async () => {
    const tree = await renderAdmin();
    expect(findPressablesByText(tree.root, "Warehouse Map")).toHaveLength(0);
  });
});

// =============================================================================
// C) adminToken absent → shows "Not found", no Map Tools rows
// =============================================================================

describe("AdminDashboardScreen — non-admin sees Not found, no Map Tools", () => {
  beforeEach(() => {
    process.env.EXPO_PUBLIC_DOMAIN = "prod.example.com";
    useApp.mockReturnValue(makeAdminApp({ adminToken: null }));
  });

  it("shows 'Not found' when adminToken is null", async () => {
    const tree = await renderAdmin();
    expect(hasText(tree.root, "Not found")).toBe(true);
  });

  it("does NOT render 'Zone Editor' row when adminToken is null", async () => {
    const tree = await renderAdmin();
    expect(findPressablesByText(tree.root, "Zone Editor")).toHaveLength(0);
  });

  it("does NOT render 'Warehouse Map' row when adminToken is null", async () => {
    const tree = await renderAdmin();
    expect(findPressablesByText(tree.root, "Warehouse Map")).toHaveLength(0);
  });
});
