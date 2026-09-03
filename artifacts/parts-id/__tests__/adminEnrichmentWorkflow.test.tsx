/**
 * Rendered regression coverage for the administrator bulk-enrichment flow.
 *
 * The suite mounts the real UploadScreen and drives the protected bulk
 * enrichment controls through start → running poll → completed poll. It also
 * guards the existing coverage summary when starting the job fails and proves
 * that an in-flight poll is aborted when the screen is unmounted.
 */

// Required for act() in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), navigate: jest.fn() }),
  useFocusEffect: jest.fn(),
}));

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn().mockResolvedValue(null),
  setItem: jest.fn().mockResolvedValue(undefined),
  removeItem: jest.fn().mockResolvedValue(undefined),
  multiRemove: jest.fn().mockResolvedValue(undefined),
}));

const mockRefetch = jest.fn().mockResolvedValue(undefined);
jest.mock("@workspace/api-client-react", () => ({
  useListInventory: jest.fn(() => ({
    data: null,
    isLoading: false,
    isError: false,
    refetch: mockRefetch,
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
    async write() {}
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

jest.mock("@/hooks/useApiStatus", () => ({
  useApiStatus: jest.fn(() => ({
    status: "ok",
    restarting: false,
    triggerRestart: jest.fn(),
    checkStatus: jest.fn().mockResolvedValue(undefined),
    bots: {},
    probeSingleBot: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

jest.mock("@/contexts/ApiHealthContext", () => {
  const stable = {
    status: "ok",
    restarting: false,
    triggerRestart: jest.fn(),
    checkStatus: jest.fn().mockResolvedValue(undefined),
    bots: {},
    probeSingleBot: jest.fn().mockResolvedValue(undefined),
    reportNetworkFailure: jest.fn(),
  };
  return {
    useApiHealth: () => stable,
    ApiHealthProvider: ({ children }: { children: React.ReactNode }) => children,
  };
});

jest.mock("@/utils/apiBase", () => ({ API_BASE: "http://localhost:3001/api" }));
jest.mock("@/utils/useTrackScreen", () => ({ useTrackScreen: jest.fn() }));
jest.mock("@/utils/expandDescHandlers", () => ({
  applyDiscardAll: jest.fn(),
  runSaveAll: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/utils/exportCsv", () => ({
  serializeInventoryToCsv: jest.fn().mockReturnValue(""),
}));

jest.mock("@/components/AddPartForm", () => ({ AddPartForm: () => null }));
jest.mock("@/components/BarcodeAddPart", () => ({ BarcodeAddPart: () => null }));
jest.mock("@/components/BinEditor", () => ({ BinEditor: () => null }));
jest.mock("@/components/BulkShelfAssign", () => ({ BulkShelfAssign: () => null }));
jest.mock("@/components/CatalogPdfUpload", () => ({ CatalogPdfUpload: () => null }));
jest.mock("@/components/ErrorBoundary", () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock("@/components/KeyboardDoneInput", () => ({
  KeyboardDoneInput: ({ children, ...props }: { children?: React.ReactNode }) =>
    React.createElement("rn-text-input", props, children),
}));
jest.mock("@/components/MeasurePartScreen", () => ({ MeasurePartScreen: () => null }));
jest.mock("@/components/ReferenceModal", () => ({ ReferenceModal: () => null }));
jest.mock("@/components/ShelfCatalogEntry", () => ({ ShelfCatalogEntry: () => null }));
jest.mock("@/components/UserAdminButtonRow", () => ({ UserAdminButtonRow: () => null }));
jest.mock("@/styles/shared", () => ({ secondaryBtnBase: {} }));

// AppContext is mapped to the shared Jest mock by jest.config.js.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useApp } = require("@/contexts/AppContext") as { useApp: jest.Mock };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const UploadScreen = (require("../app/(tabs)/upload") as {
  default: React.ComponentType;
}).default;

type Inst = TestInstance;
type JobStatus = {
  running: boolean;
  stopRequested: boolean;
  force: boolean;
  startedAt: string | null;
  processed: number;
  errors: number;
  total: number | null;
  finishedAt: string | null;
  lastError: string | null;
  model: string | null;
};

function makeAdminApp() {
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
    adminToken: "admin-test-token",
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
  };
}

function instText(node: Inst | string): string {
  if (typeof node === "string") return node;
  return (node.children ?? [])
    .map((child) => instText(child as Inst | string))
    .join("");
}

function findPressable(root: Inst, text: string): Inst | null {
  return (
    root.queryAll(
      (node: TestInstance) =>
        (node.type as string) === "rn-pressable" &&
        instText(node).includes(text),
      { includeSelf: true },
    )[0] ?? null
  );
}

function hasText(root: Inst, text: string): boolean {
  return instText(root).includes(text);
}

function screenRoot(): Inst {
  if (!activeTree?.root) throw new Error("UploadScreen is not mounted");
  return activeTree.root;
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function jobStatus(overrides: Partial<JobStatus> = {}): JobStatus {
  return {
    running: false,
    stopRequested: false,
    force: false,
    startedAt: null,
    processed: 0,
    errors: 0,
    total: null,
    finishedAt: null,
    lastError: null,
    model: null,
    ...overrides,
  };
}

const INITIAL_SUMMARY = { total: 2, enriched: 1, unenriched: 1 };
const COMPLETED_SUMMARY = { total: 2, enriched: 2, unenriched: 0 };

type TestMode = "complete" | "start-error" | "unmount";
type RecordedRequest = { url: string; init?: RequestInit };

let activeTree: Awaited<ReturnType<typeof render>> | null = null;
let mockFetch: jest.Mock;
let mode: TestMode;
let bulkStatusCalls: number;
let summaryCalls: number;
let deferredPollResolve: ((value: Response) => void) | null;
let deferredPollInit: RequestInit | undefined;
const apiRequests: RecordedRequest[] = [];

function configureNetwork(testMode: TestMode) {
  mode = testMode;
  bulkStatusCalls = 0;
  summaryCalls = 0;
  deferredPollResolve = null;
  deferredPollInit = undefined;
  apiRequests.length = 0;
  mockFetch.mockReset();
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url.endsWith("/admin/ai-status")) return Promise.resolve(response({ bots: {} }));

    if (url.endsWith("/inventory/enrich-summary")) {
      summaryCalls += 1;
      return Promise.resolve(
        response(summaryCalls === 1 ? INITIAL_SUMMARY : COMPLETED_SUMMARY),
      );
    }

    if (url.endsWith("/inventory/bulk-enrich/status")) {
      bulkStatusCalls += 1;
      if (mode === "unmount" && bulkStatusCalls >= 3) {
        deferredPollInit = init;
        return new Promise<Response>((resolve) => {
          deferredPollResolve = resolve;
        });
      }
      if (bulkStatusCalls === 1) return Promise.resolve(response(jobStatus()));
      if (bulkStatusCalls === 2) {
        return Promise.resolve(
          response(jobStatus({ running: true, total: 2, model: "test-model" })),
        );
      }
      return Promise.resolve(
        response(
          jobStatus({
            processed: 2,
            total: 2,
            finishedAt: "2026-09-02T12:00:00.000Z",
            model: "test-model",
          }),
        ),
      );
    }

    if (url.endsWith("/inventory/enrich-measurements/status")) {
      return Promise.resolve(response({
        running: false,
        startedAt: null,
        processed: 0,
        updated: 0,
        total: null,
        finishedAt: null,
        lastError: null,
      }));
    }

    if (url.endsWith("/inventory/bulk-enrich") && init?.method === "POST") {
      apiRequests.push({ url, init });
      if (mode === "start-error") {
        return Promise.resolve(response({ error: "AI provider unavailable" }, 503));
      }
      return Promise.resolve(
        response({
          job: jobStatus({
            running: true,
            startedAt: "2026-09-02T12:00:00.000Z",
            total: 2,
            model: "test-model",
          }),
        }),
      );
    }

    if (url.endsWith("/inventory/bulk-enrich") && init?.method === "DELETE") {
      apiRequests.push({ url, init });
      return Promise.resolve(
        response({
          job: jobStatus({
            running: true,
            stopRequested: true,
            startedAt: "2026-09-02T12:00:00.000Z",
            total: 2,
            model: "test-model",
          }),
        }),
      );
    }

    return Promise.resolve(response({}));
  });
  global.fetch = mockFetch as unknown as typeof fetch;
}

const flushPromises = () =>
  act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });

const rawFlushPromises = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
  useApp.mockReturnValue(makeAdminApp());
  mockRefetch.mockReset();
  mockRefetch.mockResolvedValue(undefined);
  mockFetch = jest.fn();
  configureNetwork("complete");
});

afterEach(async () => {
  if (activeTree) {
    await activeTree.unmount();
    activeTree = null;
  }
  jest.clearAllTimers();
  jest.useRealTimers();
  mockFetch.mockClear();
  apiRequests.length = 0;
  useApp.mockReset();
});

describe("UploadScreen — administrator enrichment workflow", () => {
  it("starts authenticated bulk enrichment, renders progress, and shows the completed inventory result", async () => {
    activeTree = await render(<UploadScreen />);
    await flushPromises();

    const enrichmentCard = findPressable(screenRoot(), "AI & Enrichment");
    expect(enrichmentCard).not.toBeNull();
    await act(async () => {
      fireEvent.press(enrichmentCard!);
    });

    const startButton = findPressable(screenRoot(), "Start Bulk Enrichment");
    expect(startButton).not.toBeNull();
    await act(async () => {
      fireEvent.press(startButton!);
      await rawFlushPromises();
    });

    expect(apiRequests).toHaveLength(1);
    expect(apiRequests[0]!.url).toBe(
      "http://localhost:3001/api/inventory/bulk-enrich",
    );
    expect(apiRequests[0]!.init?.headers).toMatchObject({
      Authorization: "Bearer admin-test-token",
    });
    expect(apiRequests[0]!.init?.body).toBe(JSON.stringify({ force: false }));
    expect(hasText(screenRoot(), "AI enrichment is running…")).toBe(true);
    expect(hasText(screenRoot(), "0 / 2 processed")).toBe(true);

    await act(async () => {
      jest.advanceTimersByTime(2_000);
      await rawFlushPromises();
    });

    expect(hasText(screenRoot(), "✓ Last run: 2 processed")).toBe(true);
    expect(hasText(screenRoot(), "2Enriched")).toBe(true);
    expect(hasText(screenRoot(), "0Pending")).toBe(true);
    expect(hasText(screenRoot(), "100%")).toBe(true);
    expect(summaryCalls).toBe(3);
  });

  it("shows a recoverable start error without replacing the existing inventory summary", async () => {
    configureNetwork("start-error");
    activeTree = await render(<UploadScreen />);
    await flushPromises();

    await act(async () => {
      fireEvent.press(findPressable(screenRoot(), "AI & Enrichment")!);
    });
    await act(async () => {
      fireEvent.press(findPressable(screenRoot(), "Start Bulk Enrichment")!);
      await rawFlushPromises();
    });

    expect(apiRequests[0]!.init?.headers).toMatchObject({
      Authorization: "Bearer admin-test-token",
    });
    expect(hasText(screenRoot(), "AI provider unavailable")).toBe(true);
    expect(hasText(screenRoot(), "1Enriched")).toBe(true);
    expect(hasText(screenRoot(), "1Pending")).toBe(true);
    expect(hasText(screenRoot(), "50%")).toBe(true);
    expect(hasText(screenRoot(), "Last run:")).toBe(false);
  });

  it("sends Stop and aborts a later poll so an unmounted screen cannot show stale success", async () => {
    configureNetwork("unmount");
    activeTree = await render(<UploadScreen />);
    await flushPromises();

    await act(async () => {
      fireEvent.press(findPressable(screenRoot(), "AI & Enrichment")!);
    });
    await act(async () => {
      fireEvent.press(findPressable(screenRoot(), "Start Bulk Enrichment")!);
      await rawFlushPromises();
    });

    await act(async () => {
      fireEvent.press(findPressable(screenRoot(), "Stop")!);
      await rawFlushPromises();
    });
    expect(apiRequests).toHaveLength(2);
    expect(apiRequests[1]!.url).toBe(
      "http://localhost:3001/api/inventory/bulk-enrich",
    );
    expect(apiRequests[1]!.init?.headers).toMatchObject({
      Authorization: "Bearer admin-test-token",
    });

    await act(async () => {
      jest.advanceTimersByTime(2_000);
      await rawFlushPromises();
    });
    expect(deferredPollResolve).not.toBeNull();
    expect(deferredPollInit?.signal).toBeDefined();

    await activeTree.unmount();
    expect(deferredPollInit?.signal?.aborted).toBe(true);

    await act(async () => {
      deferredPollResolve!(
        response(
          jobStatus({
            processed: 2,
            total: 2,
            finishedAt: "2026-09-02T12:00:00.000Z",
          }),
        ),
      );
      await rawFlushPromises();
    });
    activeTree = null;
  });
});