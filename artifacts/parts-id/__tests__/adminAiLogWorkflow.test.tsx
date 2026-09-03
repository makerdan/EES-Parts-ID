/**
 * Rendered-screen regression coverage for the admin AI Answer Log.
 *
 * The suite mounts the real screen and drives the read-only workflow:
 * initial protected fetch → expand an answer → refresh with replacement data
 * → recover from an HTTP error with Retry.  It also proves that the screen
 * does not request or expose log rows without an administrator token.
 */

// Required for act() in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";

// ── expo-router ───────────────────────────────────────────────────────────────

const mockRouterReplace = jest.fn();
const mockRouterBack = jest.fn();
const mockRouter = {
  replace: mockRouterReplace,
  back: mockRouterBack,
};

jest.mock("expo-router", () => ({
  useRouter: () => mockRouter,
}));

// ── Screen dependencies ──────────────────────────────────────────────────────

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

jest.mock("@/utils/apiBase", () => ({
  API_BASE: "http://localhost:3001/api",
}));

jest.mock("@/utils/useTrackScreen", () => ({
  useTrackScreen: jest.fn(),
}));

// ── Stable context fixtures ───────────────────────────────────────────────────

const { useApp } = require("@/contexts/AppContext") as { useApp: jest.Mock };
const { useApiHealth } = require("@/contexts/ApiHealthContext") as { useApiHealth: jest.Mock };
const mockReportNetworkFailure = jest.fn();

const apiHealthContext = {
  reportNetworkFailure: mockReportNetworkFailure,
};

function setAppContext(overrides: Record<string, unknown> = {}) {
  useApp.mockReturnValue({
    isLoading: false,
    isAdmin: true,
    adminToken: "admin-token-123",
    ...overrides,
  });
  useApiHealth.mockReturnValue(apiHealthContext);
}

// ── Test helpers ──────────────────────────────────────────────────────────────

type Inst = TestInstance;
type LogRow = {
  id: number;
  question: string;
  answer: string;
  matchedItemCount: number;
  createdAt: string;
};

function jsonResponse(value: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue(value),
  } as unknown as Response;
}

function errorResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: jest.fn().mockResolvedValue({ error: "unavailable" }),
  } as unknown as Response;
}

function instText(node: Inst | string): string {
  if (typeof node === "string") return node;
  return (node.children ?? [])
    .map((child) => instText(child as Inst | string))
    .join("");
}

function hasText(root: Inst | null | undefined, text: string): boolean {
  return root ? instText(root).includes(text) : false;
}

function findPressable(
  root: Inst | null | undefined,
  predicate: (node: Inst) => boolean,
): Inst | null {
  if (!root) return null;
  return (
    root
      .queryAll(
        (node: TestInstance) => (node.type as string) === "rn-pressable",
        { includeSelf: true },
      )
      .find(predicate) ?? null
  );
}

function findPressableWithText(root: Inst, text: string): Inst | null {
  return findPressable(root, (node) => instText(node).includes(text));
}

function findPressableByLabel(root: Inst, label: string): Inst | null {
  return findPressable(root, (node) => node.props.accessibilityLabel === label);
}

async function flushPromises() {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AiLogScreen = (require("../app/ai-log") as {
  default: React.ComponentType;
}).default;

const INITIAL_ROWS: LogRow[] = [
  {
    id: 101,
    question: "Which bins contain 10mm socket sets?",
    answer: "Found 3 matching inventory items in Aisle 4.",
    matchedItemCount: 3,
    createdAt: "2026-09-02T12:00:00.000Z",
  },
];

const REFRESHED_ROWS: LogRow[] = [
  {
    id: 102,
    question: "Where is the cordless drill battery?",
    answer: "The cordless drill battery is in Bay 7.",
    matchedItemCount: 1,
    createdAt: "2026-09-02T12:01:00.000Z",
  },
];

let activeTree: Awaited<ReturnType<typeof render>> | null = null;
let mockFetch: jest.SpyInstance;

beforeEach(() => {
  setAppContext();
  mockFetch = jest.spyOn(global, "fetch");
});

afterEach(async () => {
  if (activeTree) {
    await act(async () => {
      activeTree!.unmount();
    });
    activeTree = null;
  }
  mockFetch.mockRestore();
  mockRouterReplace.mockClear();
  mockRouterBack.mockClear();
  mockReportNetworkFailure.mockClear();
  useApp.mockReset();
  useApiHealth.mockReset();
});

describe("AiLogScreen — administrator read workflow", () => {
  it("fetches protected rows, expands an answer, and replaces them on refresh", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(INITIAL_ROWS))
      .mockResolvedValueOnce(jsonResponse(REFRESHED_ROWS));

    activeTree = await render(React.createElement(AiLogScreen));
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "http://localhost:3001/api/reference/ask-log",
      { headers: { Authorization: "Bearer admin-token-123" } },
    );
    expect(hasText(activeTree.root, INITIAL_ROWS[0]!.question)).toBe(true);
    expect(hasText(activeTree.root, INITIAL_ROWS[0]!.answer)).toBe(false);

    const initialRow = findPressableWithText(activeTree.root!, INITIAL_ROWS[0]!.question);
    expect(initialRow).not.toBeNull();

    await act(async () => {
      fireEvent.press(initialRow!);
    });
    expect(hasText(activeTree.root, INITIAL_ROWS[0]!.answer)).toBe(true);

    const refreshButton = findPressableByLabel(activeTree.root!, "Refresh");
    expect(refreshButton).not.toBeNull();

    await act(async () => {
      fireEvent.press(refreshButton!);
    });
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "http://localhost:3001/api/reference/ask-log",
      { headers: { Authorization: "Bearer admin-token-123" } },
    );
    expect(hasText(activeTree.root, INITIAL_ROWS[0]!.question)).toBe(false);
    expect(hasText(activeTree.root, INITIAL_ROWS[0]!.answer)).toBe(false);
    expect(hasText(activeTree.root, REFRESHED_ROWS[0]!.question)).toBe(true);
    expect(hasText(activeTree.root, REFRESHED_ROWS[0]!.answer)).toBe(false);
  });

  it("shows a recoverable HTTP error and loads fresh rows after Retry", async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(jsonResponse(REFRESHED_ROWS));

    activeTree = await render(React.createElement(AiLogScreen));
    await flushPromises();

    expect(hasText(activeTree.root, "Server error 503")).toBe(true);
    expect(hasText(activeTree.root, REFRESHED_ROWS[0]!.question)).toBe(false);

    const retryButton = findPressableWithText(activeTree.root!, "Retry");
    expect(retryButton).not.toBeNull();

    await act(async () => {
      fireEvent.press(retryButton!);
    });
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(hasText(activeTree.root, "Server error 503")).toBe(false);
    expect(hasText(activeTree.root, REFRESHED_ROWS[0]!.question)).toBe(true);
    expect(hasText(activeTree.root, REFRESHED_ROWS[0]!.answer)).toBe(false);
  });
});

describe("AiLogScreen — protected access gate", () => {
  it("redirects a non-admin without requesting or exposing log rows", async () => {
    setAppContext({ isAdmin: false, adminToken: null });

    activeTree = await render(React.createElement(AiLogScreen));
    await flushPromises();

    expect(mockRouterReplace).toHaveBeenCalledWith("/(tabs)");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(hasText(activeTree.root, INITIAL_ROWS[0]!.question)).toBe(false);
    expect(hasText(activeTree.root, INITIAL_ROWS[0]!.answer)).toBe(false);
  });

  it("does not request or expose rows when an admin token is missing", async () => {
    setAppContext({ isAdmin: true, adminToken: null });

    activeTree = await render(React.createElement(AiLogScreen));
    await flushPromises();

    expect(mockRouterReplace).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(hasText(activeTree.root, INITIAL_ROWS[0]!.question)).toBe(false);
    expect(hasText(activeTree.root, INITIAL_ROWS[0]!.answer)).toBe(false);
  });
});