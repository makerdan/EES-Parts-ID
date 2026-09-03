/**
 * End-to-end-style regression coverage for the real Admin Inbox screen.
 *
 * The suite mounts AdminInboxScreen rather than reproducing its handlers so it
 * covers the auth gate, initial contact fetch, row expansion, mark-as-read
 * mutation, and the visible unread-state transition.
 */

// Required for act() to work in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";

// ── expo-router ───────────────────────────────────────────────────────────────

const mockRouterReplace = jest.fn();
const mockRouter = {
  back: jest.fn(),
  navigate: jest.fn(),
  push: jest.fn(),
  replace: mockRouterReplace,
};

jest.mock("expo-router", () => ({
  useRouter: () => mockRouter,
}));

// ── Stable context and visual dependencies ────────────────────────────────────

// A stable reportNetworkFailure reference is important here: AdminInboxScreen
// includes it in fetchMessages' useCallback dependencies, and fetchMessages is
// itself an effect dependency.
jest.mock("@/contexts/ApiHealthContext", () => {
  const stable = { reportNetworkFailure: jest.fn() };
  return {
    ApiHealthProvider: ({ children }: { children: React.ReactNode }) => children,
    useApiHealth: () => stable,
  };
});

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

jest.mock("@/utils/apiBase", () => ({
  API_BASE: "http://localhost:3001/api",
}));

jest.mock("@/utils/useTrackScreen", () => ({
  useTrackScreen: jest.fn(),
}));

// ── AppContext ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useApp } = require("@/contexts/AppContext") as { useApp: jest.Mock };

function makeAppMock(overrides: Record<string, unknown> = {}) {
  return {
    settings: {
      textSize: "normal" as const,
      defaultConfidenceThreshold: 50,
      themeMode: "system" as const,
      shelfViewEnabled: true,
      scanSound: true,
      dimensionUnit: "mm" as const,
    },
    updateSetting: jest.fn(),
    logout: jest.fn(),
    logoutAdmin: jest.fn(),
    clearCache: jest.fn(),
    isLoading: false,
    isAdmin: false,
    adminToken: null as string | null,
    registerLogoutHandler: jest.fn(() => () => {}),
    setPendingMapFocus: jest.fn(),
    showToast: jest.fn(),
    setPinnedParts: jest.fn(),
    pendingMeasureSearch: null,
    setPendingMeasureSearch: jest.fn(),
    pendingInventorySearch: null,
    setPendingInventorySearch: jest.fn(),
    textFontScale: 1,
    pinnedParts: [],
    pendingLidarDims: null,
    setPendingLidarDims: jest.fn(),
    approvalStatus: "approved" as const,
    ...overrides,
  };
}

// ── Network fixtures ──────────────────────────────────────────────────────────

const ADMIN_TOKEN = "clerk-admin-test-token";
const UNREAD_ID = 42;

const CONTACT_ROWS = [
  {
    id: UNREAD_ID,
    senderToken: "anonymous",
    subject: "Need help identifying a part",
    body: "The label is worn off. Can you help?",
    createdAt: "2026-09-02T10:00:00.000Z",
    readAt: null,
  },
  {
    id: 41,
    senderToken: "user-7",
    subject: "Already answered",
    body: "This message has been read.",
    createdAt: "2026-09-02T09:00:00.000Z",
    readAt: "2026-09-02T09:30:00.000Z",
  },
];

type MockResponse = {
  ok: boolean;
  json: () => Promise<unknown>;
};

function jsonResponse(value: unknown, ok = true): MockResponse {
  return {
    ok,
    json: async () => value,
  };
}

const mockFetch = jest.fn();

// ── Test helpers ──────────────────────────────────────────────────────────────

type Inst = TestInstance;

function instText(node: Inst | string): string {
  if (typeof node === "string") return node;
  return (node.children ?? []).map((child) => instText(child as Inst | string)).join("");
}

function findPressable(root: Inst, text: string): Inst | null {
  return (
    root
      .queryAll(
        (node: TestInstance) => (node.type as string) === "rn-pressable",
        { includeSelf: true },
      )
      .find((node) => instText(node).includes(text)) ?? null
  );
}

function hasExactText(root: Inst, text: string): boolean {
  return root
    .queryAll(
      (node: TestInstance) =>
        (node.type as string) === "Text" && instText(node) === text,
      { includeSelf: true },
    )
    .length > 0;
}

function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>(
      (result, value) => ({ ...result, ...flattenStyle(value) }),
      {},
    );
  }
  return style && typeof style === "object" ? (style as Record<string, unknown>) : {};
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

let activeTree: Awaited<ReturnType<typeof render>> | null = null;

function getRoot(): Inst {
  if (!activeTree?.root) throw new Error("Inbox screen did not render a root");
  return activeTree.root;
}

beforeEach(() => {
  global.fetch = mockFetch as unknown as typeof fetch;
  useApp.mockReturnValue(makeAppMock({ isAdmin: true, adminToken: ADMIN_TOKEN }));
  mockFetch.mockResolvedValue(jsonResponse(CONTACT_ROWS));
});

afterEach(async () => {
  if (activeTree) {
    await activeTree.unmount();
    activeTree = null;
  }
  mockFetch.mockReset();
  mockRouterReplace.mockClear();
  jest.clearAllMocks();
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AdminInboxScreen = (require("../app/admin-inbox") as {
  default: React.ComponentType;
}).default;

describe("AdminInboxScreen — protected inbox workflow", () => {
  it("loads messages, expands an unread row, marks it read, and updates the visible state", async () => {
    let resolvePatch!: (response: MockResponse) => void;
    const patchResponse = new Promise<MockResponse>((resolve) => {
      resolvePatch = resolve;
    });

    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return patchResponse;
      return Promise.resolve(jsonResponse(CONTACT_ROWS));
    });

    activeTree = await render(React.createElement(AdminInboxScreen));
    await act(async () => {
      await flushPromises();
    });

    expect(mockFetch).toHaveBeenCalledWith("http://localhost:3001/api/contact", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(instText(getRoot())).toContain("Need help identifying a part");
    expect(instText(getRoot())).toContain("2 messages");
    expect(hasExactText(getRoot(), "1")).toBe(true);

    const unreadRow = findPressable(getRoot(), "Need help identifying a part");
    expect(unreadRow).not.toBeNull();

    await act(async () => {
      void fireEvent.press(unreadRow!);
      await Promise.resolve();
    });

    // Expansion is immediate, while the read state waits for the API result.
    expect(instText(getRoot())).toContain("The label is worn off. Can you help?");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1]).toEqual([
      "http://localhost:3001/api/contact/42/read",
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      },
    ]);
    expect(hasExactText(getRoot(), "1")).toBe(true);

    resolvePatch(jsonResponse({ id: UNREAD_ID }));
    await act(async () => {
      await flushPromises();
    });

    // The badge disappears and the same row loses its unread styling without
    // another GET or a manual reload.
    expect(hasExactText(getRoot(), "1")).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const updatedRow = findPressable(getRoot(), "Need help identifying a part");
    expect(updatedRow).not.toBeNull();
    expect(flattenStyle(updatedRow!.props.style).borderLeftWidth).toBe(1);
  });

  it("keeps an unread message unread when the mark-as-read request fails", async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return Promise.reject(new Error("network down"));
      return Promise.resolve(jsonResponse([CONTACT_ROWS[0]]));
    });

    activeTree = await render(React.createElement(AdminInboxScreen));
    await act(async () => {
      await flushPromises();
    });

    const unreadRow = findPressable(getRoot(), "Need help identifying a part");
    expect(unreadRow).not.toBeNull();

    await act(async () => {
      void fireEvent.press(unreadRow!);
      await flushPromises();
    });

    expect(instText(getRoot())).toContain("The label is worn off. Can you help?");
    expect(hasExactText(getRoot(), "1")).toBe(true);
    const failedRow = findPressable(getRoot(), "Need help identifying a part");
    expect(flattenStyle(failedRow!.props.style).borderLeftWidth).toBe(3);
  });
});

describe("AdminInboxScreen — non-admin boundary", () => {
  it("redirects non-admin users without fetching protected contact messages", async () => {
    useApp.mockReturnValue(makeAppMock({ isAdmin: false, adminToken: null }));

    activeTree = await render(React.createElement(AdminInboxScreen));
    await act(async () => {
      await flushPromises();
    });

    expect(mockRouterReplace).toHaveBeenCalledWith("/(tabs)");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(instText(getRoot())).not.toContain("Need help identifying a part");
  });
});