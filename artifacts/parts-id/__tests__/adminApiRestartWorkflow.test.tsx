/**
 * Regression coverage for the admin API restart control in UploadScreen.
 *
 * The real long-press control is mounted. Only the native confirmation dialog,
 * network boundary, and recovery timers are controlled so this suite can prove
 * the request contract without exiting Jest or restarting a workflow.
 */

// Required for act() in the node test environment.
// @ts-ignore — global augmentation for the test environment
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import type { RenderResult } from "@testing-library/react-native";

// ── expo-router ───────────────────────────────────────────────────────────────

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), navigate: jest.fn() }),
  useFocusEffect: jest.fn(),
}));

// ── External modules used by UploadScreen ──────────────────────────────────────

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn().mockResolvedValue(null),
  setItem: jest.fn().mockResolvedValue(undefined),
  removeItem: jest.fn().mockResolvedValue(undefined),
  multiRemove: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@workspace/api-client-react", () => ({
  useListInventory: jest.fn(() => ({
    data: null,
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  })),
  setAuthTokenGetter: jest.fn(),
  setBaseUrl: jest.fn(),
}));

jest.mock("expo-document-picker", () => ({
  getDocumentAsync: jest.fn().mockResolvedValue({ canceled: true }),
}));

jest.mock("expo-file-system", () => ({
  readAsStringAsync: jest.fn().mockResolvedValue(""),
  File: class {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    async text() {
      return "";
    }
    async arrayBuffer() {
      return new ArrayBuffer(0);
    }
  },
  Paths: { cache: "/tmp/cache" },
}));

jest.mock("expo-sharing", () => ({
  isAvailableAsync: jest.fn().mockResolvedValue(false),
  shareAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
  MaterialCommunityIcons: () => null,
}));

jest.mock("read-excel-file/universal", () => ({
  readSheet: jest.fn().mockResolvedValue([]),
}));

// ── Real API status hook behind the production context boundary ────────────────
//
// The context itself is replaced only because Jest maps it to a passive mock by
// default. This adapter still runs the real useApiStatus implementation, with
// short test-only timeouts for the post-202 recovery path.

jest.mock("@/contexts/ApiHealthContext", () => {
  const { useApiStatus } = require("@/hooks/useApiStatus") as typeof import("@/hooks/useApiStatus");
  const { useApp } = require("@/contexts/AppContext") as {
    useApp: () => { isAdmin?: boolean; adminToken?: string | null };
  };

  return {
    useApiHealth: () => {
      const { isAdmin, adminToken } = useApp();
      return useApiStatus({
        apiBase: "http://localhost:3001/api",
        adminToken: isAdmin ? (adminToken ?? null) : null,
        intervalMs: 60_000,
        restartPostTimeoutMs: 100,
        resumePollTimeoutMs: 100,
      });
    },
    ApiHealthProvider: ({ children }: { children: React.ReactNode }) => children,
  };
});

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

jest.mock("@/utils/adminUserActions", () => ({
  deleteAdminUser: jest.fn().mockResolvedValue(undefined),
  fetchAdminUsers: jest.fn().mockResolvedValue(undefined),
  handleUserAction: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/utils/apiBase", () => ({
  API_BASE: "http://localhost:3001/api",
}));

jest.mock("@/utils/useTrackScreen", () => ({
  useTrackScreen: jest.fn(),
}));

jest.mock("@/utils/expandDescHandlers", () => ({
  applyDiscardAll: jest.fn(),
  runSaveAll: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/utils/binSkipLogic", () => ({
  activeReplacementCount: jest.fn().mockReturnValue(0),
  preservedBinCount: jest.fn().mockReturnValue(0),
  serializeToCsv: jest.fn().mockReturnValue(""),
  toggleSkipAll: jest.fn(() => []),
  toggleSkipRow: jest.fn(() => []),
}));

jest.mock("@/utils/exportCsv", () => ({
  serializeInventoryToCsv: jest.fn().mockReturnValue(""),
}));

jest.mock("@/styles/shared", () => ({
  secondaryBtnBase: {},
}));

// Keep unrelated child flows out of this admin control test.
jest.mock("@/components/AddPartForm", () => ({ AddPartForm: () => null }));
jest.mock("@/components/BarcodeAddPart", () => ({ BarcodeAddPart: () => null }));
jest.mock("@/components/BinEditor", () => ({ BinEditor: () => null }));
jest.mock("@/components/BulkShelfAssign", () => ({ BulkShelfAssign: () => null }));
jest.mock("@/components/CatalogPdfUpload", () => ({ CatalogPdfUpload: () => null }));
jest.mock("@/components/KeyboardDoneInput", () => ({
  KeyboardDoneInput: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));
jest.mock("@/components/MeasurePartScreen", () => ({ MeasurePartScreen: () => null }));
jest.mock("@/components/ReferenceModal", () => ({ ReferenceModal: () => null }));
jest.mock("@/components/ShelfCatalogEntry", () => ({ ShelfCatalogEntry: () => null }));
jest.mock("@/components/UserAdminButtonRow", () => ({ UserAdminButtonRow: () => null }));

// ── AppContext ─────────────────────────────────────────────────────────────────

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
    isAdmin: true,
    adminToken: "admin-token",
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

// ── Native boundary doubles ────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Alert } = require("react-native") as {
  Alert: { alert: jest.Mock };
};
const mockAlert = Alert.alert;
const mockFetch = jest.fn();

global.fetch = mockFetch as typeof fetch;

type AlertButton = {
  text: string;
  onPress?: () => void;
};

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function defaultFetchResponse(url: string): Response {
  if (url.includes("/admin/ai-status")) {
    return response({ bots: {} });
  }
  if (url.includes("/inventory/enrich-summary")) {
    return response({ total: 0, enriched: 0, unenriched: 0 });
  }
  if (url.includes("/inventory/bulk-enrich/status")) {
    return response({ status: "idle" });
  }
  if (url.includes("/inventory/enrich-measurements/status")) {
    return response({ status: "idle" });
  }
  return response({ status: "ok", bots: {} });
}

// ── Render and query helpers ───────────────────────────────────────────────────

let activeTree: RenderResult | null = null;

async function flushPromises() {
  await act(async () => {
    for (let i = 0; i < 6; i++) {
      await Promise.resolve();
    }
  });
}

function instText(node: RenderResult["root"] | string): string {
  if (typeof node === "string") return node;
  return ((node as { children?: unknown[] }).children ?? [])
    .map((child) => instText(child as RenderResult["root"] | string))
    .join("");
}

function findApiPill(root: RenderResult["root"]) {
  return root!.queryAll(
    (node) =>
      (node.type as string) === "rn-pressable" &&
      instText(node).includes("API:"),
    { includeSelf: true },
  )[0] ?? null;
}

function latestRestartAlert(): AlertButton[] {
  const call = [...mockAlert.mock.calls]
    .reverse()
    .find(([title]) => title === "Restart API server?");
  expect(call).toBeDefined();
  return (call?.[2] ?? []) as AlertButton[];
}

async function renderUpload(overrides: Record<string, unknown> = {}) {
  useApp.mockReturnValue(makeAppMock(overrides));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const UploadScreen = (require("../app/(tabs)/upload") as {
    default: React.ComponentType;
  }).default;
  activeTree = await render(React.createElement(UploadScreen));
  await flushPromises();
  return activeTree;
}

afterEach(async () => {
  if (activeTree) {
    await activeTree.unmount();
    activeTree = null;
  }
  jest.useRealTimers();
  mockAlert.mockReset();
  mockFetch.mockReset();
  mockFetch.mockImplementation((input: RequestInfo | URL) =>
    Promise.resolve(defaultFetchResponse(String(input))),
  );
  jest.clearAllMocks();
});

beforeEach(() => {
  mockAlert.mockReset();
  mockFetch.mockReset();
  mockFetch.mockImplementation((input: RequestInfo | URL) =>
    Promise.resolve(defaultFetchResponse(String(input))),
  );
});

// ── Workflow coverage ──────────────────────────────────────────────────────────

describe("UploadScreen — admin API restart workflow", () => {
  it("cancelling the confirmation does not request an API restart", async () => {
    const tree = await renderUpload();
    const apiPill = findApiPill(tree!.root);
    expect(apiPill).not.toBeNull();

    await act(async () => {
      apiPill!.props.onLongPress();
    });

    const buttons = latestRestartAlert();
    expect(buttons.map((button) => button.text)).toEqual(["Cancel", "Restart"]);

    // The native cancel action dismisses the dialog without invoking the
    // destructive button. Calling its optional callback models that boundary.
    await act(async () => {
      buttons.find((button) => button.text === "Cancel")?.onPress?.();
    });
    await flushPromises();

    expect(mockFetch.mock.calls.filter(([url]) => String(url).includes("/admin/restart"))).toHaveLength(0);
  });

  it("confirms exactly one authenticated restart and shows recovery after 202 acceptance", async () => {
    jest.useFakeTimers();
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/admin/restart")) {
        return Promise.resolve(response({ restarting: true }, 202));
      }
      return Promise.resolve(defaultFetchResponse(url));
    });

    const tree = await renderUpload();
    const apiPill = findApiPill(tree!.root);
    expect(apiPill).not.toBeNull();

    await act(async () => {
      apiPill!.props.onLongPress();
    });
    const buttons = latestRestartAlert();

    await act(async () => {
      buttons.find((button) => button.text === "Restart")?.onPress?.();
    });
    await flushPromises();

    const restartCalls = mockFetch.mock.calls.filter(([url]) =>
      String(url).endsWith("/admin/restart"),
    );
    expect(restartCalls).toHaveLength(1);
    expect(restartCalls[0][0]).toBe("http://localhost:3001/api/admin/restart");
    expect(restartCalls[0][1]).toEqual(expect.objectContaining({
      method: "POST",
      headers: { Authorization: "Bearer admin-token" },
      signal: expect.any(AbortSignal),
    }));
    expect(instText(tree!.root)).toContain("⟳ Restarting…");

    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });
    await flushPromises();

    expect(instText(tree!.root)).toContain("● API: ok");
    expect(mockAlert).toHaveBeenCalledWith(
      "API server recovered",
      "The API server is back online.",
    );
  });

  it("does not render the restart control or request restart for a non-admin", async () => {
    const tree = await renderUpload({ isAdmin: false, adminToken: null });

    expect(instText(tree!.root)).toContain("Admin Access Required");
    expect(findApiPill(tree!.root)).toBeNull();
    expect(mockFetch.mock.calls.filter(([url]) => String(url).includes("/admin/restart"))).toHaveLength(0);
  });
});