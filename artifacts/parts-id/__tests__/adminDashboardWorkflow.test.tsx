/**
 * End-to-end-style regression coverage for the real admin dashboard screen.
 *
 * The test deliberately drives the screen through its rendered controls:
 * initial dashboard load, pull-to-refresh, and native CSV sharing. It also
 * verifies that the route remains a plain not-found screen without admin auth.
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act, render } from "@testing-library/react-native";
import type { RenderResult } from "@testing-library/react-native";

// ─── expo-router ─────────────────────────────────────────────────────────────

jest.mock("expo-router", () => ({
  useRouter: () => ({ back: jest.fn(), push: jest.fn(), navigate: jest.fn() }),
  useFocusEffect: jest.fn(),
}));

// ─── expo-file-system ────────────────────────────────────────────────────────

jest.mock("expo-file-system", () => {
  const mockFileWrite = jest.fn().mockResolvedValue(undefined);

  class MockFile {
    uri: string;

    constructor(directory: string, name: string) {
      this.uri = `${directory}${name}`;
    }

    write(contents: string) {
      return mockFileWrite(contents);
    }
  }

  return {
    File: MockFile,
    Paths: { cache: "file:///mock-cache/" },
    __mockFileWrite: mockFileWrite,
  };
});

// ─── expo-sharing ────────────────────────────────────────────────────────────

jest.mock("expo-sharing", () => {
  const mockIsAvailableAsync = jest.fn().mockResolvedValue(true);
  const mockShareAsync = jest.fn().mockResolvedValue(undefined);

  return {
    isAvailableAsync: mockIsAvailableAsync,
    shareAsync: mockShareAsync,
    __mockIsAvailableAsync: mockIsAvailableAsync,
    __mockShareAsync: mockShareAsync,
  };
});

// ─── react-native-svg ────────────────────────────────────────────────────────

jest.mock("react-native-svg", () => {
  const React = require("react");
  const make = (tag: string) =>
    function SvgElement({ children, ...props }: Record<string, unknown>) {
      return React.createElement(tag, props, children);
    };

  return {
    __esModule: true,
    default: make("svg"),
    Svg: make("svg"),
    Rect: make("rect"),
    Text: make("Text"),
  };
});

// ─── @expo/vector-icons ──────────────────────────────────────────────────────

jest.mock("@expo/vector-icons", () => ({
  Feather: function FeatherIcon() {
    return null;
  },
}));

// ─── @/hooks/useColors ───────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#fff",
    foreground: "#000",
    card: "#f9f9f9",
    border: "#e0e0e0",
    primary: "#007aff",
    primaryForeground: "#fff",
    mutedForeground: "#888",
    muted: "#f0f0f0",
    destructive: "#ff3b30",
    warning: "#f59e0b",
  }),
}));

// ─── @/utils/apiBase ─────────────────────────────────────────────────────────

jest.mock("@/utils/apiBase", () => ({
  API_BASE: "http://localhost:3001/api",
}));

// ─── @/contexts/ApiHealthContext ─────────────────────────────────────────────

jest.mock("@/contexts/ApiHealthContext", () => {
  const stable = { reportNetworkFailure: jest.fn() };
  return {
    useApiHealth: () => stable,
    ApiHealthProvider: ({ children }: { children: unknown }) => children,
  };
});

// ─── AppContext ───────────────────────────────────────────────────────────────

const mockUseApp = jest.fn();

jest.mock("@/contexts/AppContext", () => ({
  useApp: (...args: unknown[]) => mockUseApp(...args),
}));

// ─── Subject under test ───────────────────────────────────────────────────────

import AdminScreen from "../app/admin";

type DashboardStats = {
  generatedAt: string;
  window: { start: string; end: string; days: number };
  timezone: string;
  privacy: {
    minimumCellCount: number;
    suppressedValue: string;
    uniqueVisitorsAvailable: boolean;
    aggregateOnly: boolean;
  };
  ai: {
    requestsInWindow: number;
    byFeature: Array<{ feature: string; total: number }>;
  };
  screenViews: {
    viewsInWindow: number;
    uniqueVisitorsInWindow: number;
    byScreen: Array<{ screenName: string; total: number }>;
    dailyInWindow: Array<{ date: string; total: number }>;
  };
  summary: {
    inventoryItems: number;
    catalogJobsDone: number;
    contactMessages: number;
  };
};

const FIRST_STATS: DashboardStats = {
  generatedAt: "2026-09-02T12:00:00.000Z",
  window: {
    start: "2026-08-03T00:00:00.000Z",
    end: "2026-09-02T00:00:00.000Z",
    days: 30,
  },
  timezone: "UTC",
  privacy: {
    minimumCellCount: 5,
    suppressedValue: "Suppressed",
    uniqueVisitorsAvailable: true,
    aggregateOnly: true,
  },
  ai: {
    requestsInWindow: 17,
    byFeature: [{ feature: "identify", total: 11 }],
  },
  screenViews: {
    viewsInWindow: 23,
    uniqueVisitorsInWindow: 9,
    byScreen: [{ screenName: "search", total: 12 }],
    dailyInWindow: [{ date: "2026-09-01", total: 6 }],
  },
  summary: {
    inventoryItems: 12,
    catalogJobsDone: 4,
    contactMessages: 3,
  },
};

const REFRESHED_STATS: DashboardStats = {
  ...FIRST_STATS,
  generatedAt: "2026-09-02T12:05:00.000Z",
  summary: {
    inventoryItems: 19,
    catalogJobsDone: 5,
    contactMessages: 8,
  },
  ai: {
    requestsInWindow: 21,
    byFeature: [{ feature: "reference", total: 13 }],
  },
};

const mockFetch = jest.fn();

let activeTree: RenderResult | null = null;

function makeAdminApp(overrides: Record<string, unknown> = {}) {
  return {
    isLoading: false,
    adminToken: "tok-admin-dashboard",
    isAdmin: true,
    ...overrides,
  };
}

function instText(node: RenderResult["root"] | string): string {
  if (typeof node === "string") return node;
  if (!node) return "";
  return ((node as { children?: unknown[] }).children ?? [])
    .map((child) => instText(child as RenderResult["root"] | string))
    .join("");
}

function hasText(root: RenderResult["root"], text: string): boolean {
  return instText(root).includes(text);
}

function flushPromises() {
  return act(async () => {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
    }
  });
}

function findPressables(root: RenderResult["root"]) {
  return root!.queryAll(
    (node) => (node.type as string) === "rn-pressable",
    { includeSelf: true },
  );
}

function findScrollView(root: RenderResult["root"]) {
  const [scrollView] = root!.queryAll(
    (node) => (node.type as string) === "rn-scroll",
    { includeSelf: true },
  );
  return scrollView;
}

beforeEach(() => {
  mockUseApp.mockReturnValue(makeAdminApp());
  mockFetch.mockReset();
  global.fetch = mockFetch as unknown as typeof fetch;

  const fileSystemMock = jest.requireMock("expo-file-system") as {
    __mockFileWrite: jest.Mock;
  };
  fileSystemMock.__mockFileWrite.mockReset();
  fileSystemMock.__mockFileWrite.mockResolvedValue(undefined);

  const sharingMock = jest.requireMock("expo-sharing") as {
    __mockIsAvailableAsync: jest.Mock;
    __mockShareAsync: jest.Mock;
  };
  sharingMock.__mockIsAvailableAsync.mockReset();
  sharingMock.__mockIsAvailableAsync.mockResolvedValue(true);
  sharingMock.__mockShareAsync.mockReset();
  sharingMock.__mockShareAsync.mockResolvedValue(undefined);
});

afterEach(async () => {
  if (activeTree) {
    await activeTree.unmount();
    activeTree = null;
  }
  jest.clearAllMocks();
});

describe("AdminDashboardScreen — authenticated workflow", () => {
  it("loads, refreshes, and exports the dashboard without losing data", async () => {
    let resolveInitial!: (response: Response) => void;
    const initialResponse = new Promise<Response>((resolve) => {
      resolveInitial = resolve;
    });
    let resolveRefresh!: (response: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });

    mockFetch
      .mockReturnValueOnce(initialResponse)
      .mockReturnValueOnce(refreshResponse);

    const tree = await render(<AdminScreen />);
    activeTree = tree;

    expect(hasText(tree.root, "Loading stats…")).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/admin/dashboard-stats",
      expect.objectContaining({
        headers: { Authorization: "Bearer tok-admin-dashboard" },
        signal: expect.any(AbortSignal),
      }),
    );
    const initialOptions = mockFetch.mock.calls[0]?.[1] as RequestInit;
    expect(initialOptions.method ?? "GET").toBe("GET");

    resolveInitial({
      ok: true,
      json: async () => FIRST_STATS,
    } as Response);
    await flushPromises();

    expect(hasText(tree.root, "Admin Dashboard")).toBe(true);
    expect(hasText(tree.root, "12")).toBe(true);
    expect(hasText(tree.root, "Catalog Jobs Done")).toBe(true);
    expect(hasText(tree.root, "17")).toBe(true);
    expect(hasText(tree.root, "Photo ID")).toBe(true);

    const scrollView = findScrollView(tree.root);
    const refreshControl = scrollView?.props.refreshControl as
      | React.ReactElement<{ refreshing: boolean; onRefresh: () => void }>
      | undefined;
    expect(refreshControl?.props.refreshing).toBe(false);

    await act(async () => {
      refreshControl?.props.onRefresh();
      await Promise.resolve();
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1]?.[0]).toBe(
      "http://localhost:3001/api/admin/dashboard-stats",
    );
    expect(mockFetch.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        headers: { Authorization: "Bearer tok-admin-dashboard" },
      }),
    );
    const refreshedScrollView = findScrollView(tree.root);
    const refreshingControl = refreshedScrollView?.props.refreshControl as
      | React.ReactElement<{ refreshing: boolean }>
      | undefined;
    expect(refreshingControl?.props.refreshing).toBe(true);
    expect(hasText(tree.root, "12")).toBe(true);

    resolveRefresh({
      ok: true,
      json: async () => REFRESHED_STATS,
    } as Response);
    await flushPromises();

    expect(hasText(tree.root, "19")).toBe(true);
    expect(hasText(tree.root, "21")).toBe(true);
    expect(hasText(tree.root, "Reference Assistant")).toBe(true);
    const completedScrollView = findScrollView(tree.root);
    const completedRefreshControl = completedScrollView?.props.refreshControl as
      | React.ReactElement<{ refreshing: boolean }>
      | undefined;
    expect(completedRefreshControl?.props.refreshing).toBe(false);

    const pressables = findPressables(tree.root);
    expect(pressables.length).toBeGreaterThanOrEqual(3);
    await act(async () => {
      pressables[1]?.props.onPress();
      await Promise.resolve();
    });

    const fileSystemMock = jest.requireMock("expo-file-system") as {
      __mockFileWrite: jest.Mock;
    };
    const sharingMock = jest.requireMock("expo-sharing") as {
      __mockIsAvailableAsync: jest.Mock;
      __mockShareAsync: jest.Mock;
    };
    const csv = fileSystemMock.__mockFileWrite.mock.calls[0]?.[0] as string;

    expect(csv).toContain("Inventory Items,19");
    expect(csv).toContain("Requests in Reporting Window,21");
    expect(csv).toContain('"Reference Assistant",13');
    expect(sharingMock.__mockIsAvailableAsync).toHaveBeenCalledTimes(1);
    expect(sharingMock.__mockShareAsync).toHaveBeenCalledWith(
      expect.stringMatching(/^file:\/\/\/mock-cache\/admin-dashboard-\d{4}-\d{2}-\d{2}\.csv$/),
      {
        mimeType: "text/csv",
        dialogTitle: "Export Dashboard CSV",
        UTI: "public.comma-separated-values-text",
      },
    );
  });
});

describe("AdminDashboardScreen — access boundary", () => {
  it("renders Not found and never requests protected dashboard data without admin auth", async () => {
    mockUseApp.mockReturnValue(makeAdminApp({ adminToken: null, isAdmin: false }));

    const tree = await render(<AdminScreen />);
    activeTree = tree;
    await flushPromises();

    expect(hasText(tree.root, "Not found")).toBe(true);
    expect(hasText(tree.root, "Summary")).toBe(false);
    expect(hasText(tree.root, "Inventory Items")).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});