/**
 * Rendered regression coverage for the admin SQL query workflow.
 *
 * This mounts the real UploadScreen, opens its Warehouse section, and drives:
 *   - query entry and execution with the protected-column metadata returned by
 *     the server,
 *   - native CSV/XLSX file creation and sharing, and
 *   - empty, malformed, high-volume, and write-keyword responses, proving the
 *     read-only boundary and recovery states remain visible.
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";

// ── Clerk ─────────────────────────────────────────────────────────────────────

const mockGetToken = jest.fn().mockResolvedValue("admin-query-token");
const mockOpenUserProfile = jest.fn();
const mockSignOut = jest.fn().mockResolvedValue(undefined);
const mockAdminAuth = {
  isLoaded: true,
  isSignedIn: true,
  userId: "admin-user",
  getToken: mockGetToken,
  signOut: mockSignOut,
};
const mockAdminClerk = {
  openUserProfile: mockOpenUserProfile,
  signOut: mockSignOut,
};

jest.mock("@clerk/expo", () => {
  const { createClerkExpoMock } = jest.requireActual("../__mocks__/clerk-expo");
  return createClerkExpoMock({
    useAuth: () => mockAdminAuth,
    useClerk: () => mockAdminClerk,
  });
});

const { assertUploadScreenClerkMock } = jest.requireActual("../__mocks__/clerk-expo");
assertUploadScreenClerkMock(jest.requireMock("@clerk/expo"), "adminQueryWorkflow");

// ── Navigation and platform boundary mocks ────────────────────────────────────

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

jest.mock("expo-document-picker", () => ({
  getDocumentAsync: jest.fn().mockResolvedValue({ canceled: true }),
}));
const mockDocumentPicker = jest.requireMock("expo-document-picker") as {
  getDocumentAsync: jest.Mock;
};

type WrittenFile = { uri: string; bytes: number[] };
const mockWrittenFiles: WrittenFile[] = [];

jest.mock("expo-file-system", () => ({
  readAsStringAsync: jest.fn().mockResolvedValue(""),
  File: class MockFile {
    uri: string;

    constructor(directory: string, name: string) {
      this.uri = `${directory}/${name}`;
    }

    async write(bytes: Uint8Array): Promise<void> {
      mockWrittenFiles.push({ uri: this.uri, bytes: Array.from(bytes) });
    }
  },
  Paths: { cache: "/tmp/cache" },
}));

const mockSharingAvailable = jest.fn<Promise<boolean>, []>();
const mockShareAsync = jest.fn<Promise<void>, [string, Record<string, string>?]>();

jest.mock("expo-sharing", () => ({
  isAvailableAsync: () => mockSharingAvailable(),
  shareAsync: (...args: unknown[]) =>
    mockShareAsync(...(args as [string, Record<string, string>?])),
}));

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
  MaterialCommunityIcons: () => null,
}));

jest.mock("read-excel-file/universal", () => ({
  readSheet: jest.fn().mockResolvedValue([]),
}));

// ── Screen dependencies ───────────────────────────────────────────────────────

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

type MockInventoryResponse = {
  data: {
    items: Array<{
      id: number;
      vendor: string;
      catalog: string;
      description: string;
      binLocations: string[];
    }> | undefined;
    total: number;
    page: number;
    limit: number;
  } | undefined;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
};

const mockUseListInventory = jest.requireMock("@workspace/api-client-react")
  .useListInventory as jest.Mock;
let mockInventoryResponses: Record<number, MockInventoryResponse>;
let mockInventoryRefetchPages: number[];

function makeInventoryItem(id: number, catalog: string) {
  return {
    id,
    vendor: "ACME",
    catalog,
    description: `${catalog} description`,
    binLocations: [],
  };
}

mockUseListInventory.mockImplementation(({ page = 1 }: { page?: number } = {}) => {
  const [, forceUpdate] = React.useState(0);
  const response = mockInventoryResponses[page] ?? {
    data: undefined,
    isLoading: false,
    isFetching: false,
    isError: false,
  };
  const refetch = jest.fn(async () => {
    mockInventoryRefetchPages.push(page);
    if (page === 2) {
      mockInventoryResponses[page] = {
        data: {
          items: [makeInventoryItem(2, "SECOND-PART")],
          total: 51,
          page: 2,
          limit: 1,
        },
        isLoading: false,
        isFetching: false,
        isError: false,
      };
    }
    forceUpdate((value) => value + 1);
    return { data: mockInventoryResponses[page]?.data };
  });
  return { ...response, refetch };
});

jest.mock("@/hooks/useColors", () =>
  require("./helpers/mapMocks").createUseColorsMock(),
);

jest.mock("@/contexts/ApiHealthContext", () => {
  const stableApiHealth = {
    status: "ok",
    restarting: false,
    triggerRestart: jest.fn().mockResolvedValue(undefined),
    checkStatus: jest.fn().mockResolvedValue(undefined),
    bots: {},
    probeSingleBot: jest.fn().mockResolvedValue(undefined),
    reportNetworkFailure: jest.fn(),
  };
  return {
    useApiHealth: () => stableApiHealth,
    ApiHealthProvider: ({ children }: { children: React.ReactNode }) => children,
  };
});

jest.mock("@/utils/adminUserActions", () => ({
  fetchAdminUsers: jest.fn().mockResolvedValue(undefined),
  handleUserAction: jest.fn().mockResolvedValue(undefined),
  deleteAdminUser: jest.fn().mockResolvedValue(undefined),
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
  toggleSkipAll: jest.fn().mockReturnValue([]),
  toggleSkipRow: jest.fn().mockReturnValue([]),
}));

jest.mock("@/utils/exportCsv", () => ({
  serializeInventoryToCsv: jest.fn().mockReturnValue(""),
}));

jest.mock("@/styles/shared", () => ({
  secondaryBtnBase: {},
}));

// Keep the screen focused on the query tool. The real UploadScreen still owns
// the section navigation, query input, query request, result table, and export
// handlers.
jest.mock("@/components/AddPartForm", () => ({ AddPartForm: () => null }));
jest.mock("@/components/BarcodeAddPart", () => ({ BarcodeAddPart: () => null }));
jest.mock("@/components/BinEditor", () => ({ BinEditor: () => null }));
jest.mock("@/components/BulkShelfAssign", () => ({ BulkShelfAssign: () => null }));
jest.mock("@/components/CatalogPdfUpload", () => ({ CatalogPdfUpload: () => null }));
jest.mock("@/components/MeasurePartScreen", () => ({ MeasurePartScreen: () => null }));
jest.mock("@/components/ReferenceModal", () => ({ ReferenceModal: () => null }));
jest.mock("@/components/ShelfCatalogEntry", () => ({ ShelfCatalogEntry: () => null }));
jest.mock("@/components/UserAdminButtonRow", () => ({ UserAdminButtonRow: () => null }));

// Forward the production query input props to the RN mock so fireEvent drives
// the actual controlled state in UploadScreen.
jest.mock("@/components/KeyboardDoneInput", () => {
  const React = require("react") as typeof import("react");
  const { TextInput } = require("react-native") as typeof import("react-native");
  return {
    KeyboardDoneInput: (props: Record<string, unknown>) =>
      React.createElement(TextInput, props),
  };
});

// ── App context ────────────────────────────────────────────────────────────────

// jest.config.js maps this module to the shared mock.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useApp } = require("@/contexts/AppContext") as { useApp: jest.Mock };

function makeAppMock() {
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
    adminToken: "admin-query-token",
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
    approvalStatus: "approved" as const,
  };
}

// ── Deterministic query/export responses ──────────────────────────────────────

const validSql =
  "SELECT id, catalog, email FROM inventory WHERE id = 101 LIMIT 1";

const sanitizedQueryResponse = {
  columns: ["id", "catalog"],
  rows: [{ id: 101, catalog: "CONTACTOR-42" }],
  rowCount: 1,
  strippedColumns: ["email"],
};

const csvBytes = new TextEncoder().encode(
  "id,catalog\n101,CONTACTOR-42\n",
);
const xlsxBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x58, 0x4c, 0x53, 0x58]);

const mockFetch = jest.fn();
let mockFloorPlanContent = "<svg viewBox=\"0 0 10 10\"></svg>";
let nextQueryResponse:
  | { ok: boolean; status: number; body: Record<string, unknown> }
  | undefined;

function responseForJson(body: Record<string, unknown>, ok = true, status = 200) {
  return {
    ok,
    status,
    json: jest.fn().mockResolvedValue(body),
    blob: jest.fn(),
  };
}

function responseForBlob(bytes: Uint8Array) {
  return {
    ok: true,
    status: 200,
    json: jest.fn(),
    blob: jest.fn().mockResolvedValue(
      new Blob([bytes.buffer as ArrayBuffer], { type: "application/octet-stream" }),
    ),
  };
}

function installFetchMock(): void {
  mockFetch.mockImplementation(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.startsWith("file://")) {
      return {
        ok: true,
        status: 200,
        text: jest.fn().mockResolvedValue(mockFloorPlanContent),
        json: jest.fn(),
        blob: jest.fn(),
      };
    }

    if (url.includes("/admin/query")) {
      const format = new URL(url).searchParams.get("format");
      if (format === "csv") return responseForBlob(csvBytes);
      if (format === "xlsx") return responseForBlob(xlsxBytes);

      const result = nextQueryResponse ?? {
        ok: true,
        status: 200,
        body: sanitizedQueryResponse,
      };
      return responseForJson(result.body, result.ok, result.status);
    }

    if (url.includes("/inventory/enrich-summary")) {
      return responseForJson({ total: 0, enriched: 0, unenriched: 0 });
    }

    if (url.includes("/inventory/bulk-enrich/status")) {
      return responseForJson({
        running: false,
        stopRequested: false,
        force: false,
        startedAt: null,
        processed: 0,
        errors: 0,
        total: 0,
        finishedAt: null,
        lastError: null,
        model: null,
      });
    }

    if (url.includes("/inventory/enrich-measurements/status")) {
      return responseForJson({
        running: false,
        startedAt: null,
        processed: 0,
        updated: 0,
        total: 0,
        finishedAt: null,
        lastError: null,
      });
    }

    // No other request is part of this workflow.
    return responseForJson({});
  });

  global.fetch = mockFetch as unknown as typeof fetch;
}

// ── Render and tree helpers ───────────────────────────────────────────────────

type Inst = TestInstance;

function instText(node: Inst | string): string {
  if (typeof node === "string") return node;
  return (node.children ?? [])
    .map((child) => instText(child as Inst | string))
    .join("");
}

function findPressable(root: Inst, label: string): Inst | null {
  return (
    root
      .queryAll(
        (node: Inst) => (node.type as string) === "rn-pressable",
        { includeSelf: true },
      )
      .find((node: Inst) => instText(node).includes(label)) ?? null
  );
}

function findQueryInput(root: Inst): Inst {
  const input = root
    .queryAll(
      (node: Inst) =>
        (node.type as string) === "rn-text-input" &&
        node.props.placeholder === "SELECT * FROM inventory LIMIT 20",
      { includeSelf: true },
    )
    .at(0);
  if (!input) throw new Error("The admin query input did not render");
  return input;
}

const flushPromises = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });

let activeTree: Awaited<ReturnType<typeof render>> | null = null;

async function renderAdminWarehouse() {
  useApp.mockReturnValue(makeAppMock());
  activeTree = await render(React.createElement(
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("../app/(tabs)/upload").default as React.ComponentType,
  ));
  await flushPromises();

  const warehouseCard = findPressable(activeTree.root!, "Warehouse");
  if (!warehouseCard) throw new Error("The admin Warehouse section card did not render");
  await act(async () => { fireEvent.press(warehouseCard); });
  await flushPromises();

  return activeTree;
}

async function renderAdminImport() {
  useApp.mockReturnValue(makeAppMock());
  activeTree = await render(React.createElement(
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("../app/(tabs)/upload").default as React.ComponentType,
  ));
  await flushPromises();

  const importCard = findPressable(activeTree.root!, "Data Import");
  if (!importCard) throw new Error("The admin Data Import section card did not render");
  await act(async () => { fireEvent.press(importCard); });
  await flushPromises();

  return activeTree;
}

beforeEach(() => {
  jest.clearAllMocks();
  expect(mockAdminAuth).toMatchObject({
    isLoaded: true,
    isSignedIn: true,
    userId: "admin-user",
  });
  expect(mockAdminAuth.getToken).toEqual(expect.any(Function));
  expect(mockAdminClerk.openUserProfile).toEqual(expect.any(Function));
  expect(mockAdminClerk.signOut).toEqual(expect.any(Function));
  mockWrittenFiles.length = 0;
  mockInventoryRefetchPages = [];
  mockInventoryResponses = {
    1: {
      data: {
        items: [makeInventoryItem(1, "FIRST-PART")],
        total: 51,
        page: 1,
        limit: 1,
      },
      isLoading: false,
      isFetching: false,
      isError: false,
    },
    2: {
      data: undefined,
      isLoading: false,
      isFetching: false,
      isError: true,
    },
  };
  nextQueryResponse = undefined;
  mockFloorPlanContent = "<svg viewBox=\"0 0 10 10\"></svg>";
  installFetchMock();
  mockDocumentPicker.getDocumentAsync.mockResolvedValue({ canceled: true });
  mockSharingAvailable.mockResolvedValue(true);
  mockShareAsync.mockResolvedValue(undefined);
  useApp.mockReturnValue(makeAppMock());
});

afterEach(async () => {
  if (activeTree) {
    await activeTree.unmount();
    activeTree = null;
  }
});

// ── Rendered workflow ──────────────────────────────────────────────────────────

describe("UploadScreen — rendered admin query workflow", () => {
  it("executes a query and renders only sanitized columns and rows", async () => {
    const tree = await renderAdminWarehouse();
    const input = findQueryInput(tree.root!);

    await act(async () => { fireEvent.changeText(input, validSql); });
    const runButton = findPressable(tree.root!, "▶ Run");
    expect(runButton).not.toBeNull();

    await act(async () => { fireEvent.press(runButton!); });
    await flushPromises();

    const queryCall = mockFetch.mock.calls.find(
      ([url]) => String(url) === "http://localhost:3001/api/admin/query",
    );
    expect(queryCall).toBeDefined();
    expect(queryCall![1]).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer admin-query-token",
      },
      body: JSON.stringify({ sql: validSql }),
    });

    expect(instText(tree.root!)).toContain("CONTACTOR-42");
    expect(instText(tree.root!)).toContain("101");
    expect(instText(tree.root!)).not.toContain("email");
    expect(instText(tree.root!)).not.toContain("hidden@example.com");
    expect(sanitizedQueryResponse.columns).toEqual(["id", "catalog"]);
    expect(sanitizedQueryResponse.strippedColumns).toEqual(["email"]);
  });

  it("posts both export formats and shares the generated CSV/XLSX payloads", async () => {
    const tree = await renderAdminWarehouse();
    const input = findQueryInput(tree.root!);

    await act(async () => { fireEvent.changeText(input, validSql); });
    await act(async () => {
      fireEvent.press(findPressable(tree.root!, "▶ Run")!);
    });
    await flushPromises();

    await act(async () => {
      fireEvent.press(findPressable(tree.root!, "Download CSV")!);
    });
    await flushPromises();

    await act(async () => {
      fireEvent.press(findPressable(tree.root!, "Download Excel")!);
    });
    await flushPromises();

    const exportCalls = mockFetch.mock.calls.filter(([url]) =>
      String(url).includes("/admin/query?format="),
    );
    expect(exportCalls).toHaveLength(2);
    expect(exportCalls[0]![0]).toBe("http://localhost:3001/api/admin/query?format=csv");
    expect(exportCalls[1]![0]).toBe("http://localhost:3001/api/admin/query?format=xlsx");
    for (const [, init] of exportCalls) {
      expect(init).toMatchObject({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer admin-query-token",
        },
        body: JSON.stringify({ sql: validSql }),
      });
    }

    expect(mockWrittenFiles).toEqual([
      { uri: "/tmp/cache/query-results.csv", bytes: Array.from(csvBytes) },
      { uri: "/tmp/cache/query-results.xlsx", bytes: Array.from(xlsxBytes) },
    ]);
    expect(mockShareAsync).toHaveBeenNthCalledWith(
      1,
      "/tmp/cache/query-results.csv",
      {
        mimeType: "text/csv",
        dialogTitle: "Export CSV",
      },
    );
    expect(mockShareAsync).toHaveBeenNthCalledWith(
      2,
      "/tmp/cache/query-results.xlsx",
      {
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        dialogTitle: "Export XLSX",
      },
    );
  });

  it("blocks write-keyword queries without sending a mutation request", async () => {
    const tree = await renderAdminWarehouse();
    const input = findQueryInput(tree.root!);

    await act(async () => { fireEvent.changeText(input, validSql); });
    await act(async () => {
      fireEvent.press(findPressable(tree.root!, "▶ Run")!);
    });
    await flushPromises();
    expect(instText(tree.root!)).toContain("CONTACTOR-42");

    const rejectedSql = "DELETE FROM inventory";
    const rejectedInput = findQueryInput(tree.root!);
    await act(async () => { fireEvent.changeText(rejectedInput, rejectedSql); });
    await flushPromises();
    await act(async () => {
      fireEvent.press(findPressable(tree.root!, "▶ Run")!);
    });
    await flushPromises();

    expect(instText(tree.root!)).toContain("Write operations are blocked.");
    expect(instText(tree.root!)).not.toContain("CONTACTOR-42");
    expect(mockFetch.mock.calls.filter(([url]) =>
      String(url) === "http://localhost:3001/api/admin/query",
    )).toHaveLength(1);
    expect(findPressable(tree.root!, "Download CSV")).toBeNull();
    expect(findPressable(tree.root!, "Download Excel")).toBeNull();
    expect(mockFetch.mock.calls.filter(([url]) =>
      String(url).includes("/admin/query?format="),
    )).toHaveLength(0);
    expect(mockShareAsync).not.toHaveBeenCalled();
  });

  it("distinguishes a valid empty result from an error", async () => {
    nextQueryResponse = {
      ok: true,
      status: 200,
      body: { columns: ["id", "catalog"], rows: [], rowCount: 0 },
    };
    const tree = await renderAdminWarehouse();
    const input = findQueryInput(tree.root!);

    await act(async () => { fireEvent.changeText(input, validSql); });
    await act(async () => { fireEvent.press(findPressable(tree.root!, "▶ Run")!); });
    await flushPromises();

    expect(instText(tree.root!)).toContain("No rows returned");
    expect(instText(tree.root!)).not.toContain("Results could not be displayed");
  });

  it("shows a retryable display error for malformed result rows", async () => {
    nextQueryResponse = {
      ok: true,
      status: 200,
      body: { columns: ["id"], rows: [null], rowCount: 1 },
    };
    const tree = await renderAdminWarehouse();
    const input = findQueryInput(tree.root!);

    await act(async () => { fireEvent.changeText(input, validSql); });
    await act(async () => { fireEvent.press(findPressable(tree.root!, "▶ Run")!); });
    await flushPromises();

    expect(instText(tree.root!)).toContain("Results could not be displayed. Retry the query.");
    expect(findPressable(tree.root!, "Download CSV")).toBeNull();
  });

  it("keeps loaded inventory visible and retries only the failed page", async () => {
    const tree = await renderAdminWarehouse();
    expect(instText(tree.root!)).toContain("FIRST-PART");

    const loadMore = findPressable(tree.root!, "Load More");
    expect(loadMore).not.toBeNull();
    await act(async () => { fireEvent.press(loadMore!); });
    await flushPromises();

    expect(instText(tree.root!)).toContain("FIRST-PART");
    expect(instText(tree.root!)).toContain("Inventory page 2 unavailable");
    expect(instText(tree.root!)).toContain("Retry page 2");
    expect(instText(tree.root!)).not.toContain("No Inventory");

    const retry = findPressable(tree.root!, "Retry page 2");
    expect(retry).not.toBeNull();
    expect(retry?.props.accessibilityLabel).toBe("Retry inventory page 2");
    await act(async () => { fireEvent.press(retry!); });
    await flushPromises();

    expect(mockInventoryRefetchPages).toEqual([2]);
    expect(instText(tree.root!)).toContain("FIRST-PART");
    expect(instText(tree.root!)).toContain("SECOND-PART");
    expect(instText(tree.root!)).not.toContain("Inventory page 2 unavailable");
    expect(instText(tree.root!)).toContain("All inventory items loaded.");
    expect(
      tree.root!.queryAll(
        (node: Inst) =>
          (node.type as string) === "rn-pressable" &&
          instText(node).includes("SECOND-PART"),
        { includeSelf: true },
      ),
    ).toHaveLength(1);
    expect(mockFetch.mock.calls.some(([url]) => String(url).includes("/inventory/upsert"))).toBe(false);
  });

  it("bounds high-volume result rendering while keeping export available", async () => {
    nextQueryResponse = {
      ok: true,
      status: 200,
      body: {
        columns: ["id", "catalog"],
        rows: Array.from({ length: 150 }, (_, index) => ({
          id: index + 1,
          catalog: `CAT-${String(index + 1).padStart(4, "0")}`,
        })),
        rowCount: 150,
      },
    };
    const tree = await renderAdminWarehouse();
    const input = findQueryInput(tree.root!);

    await act(async () => { fireEvent.changeText(input, validSql); });
    await act(async () => { fireEvent.press(findPressable(tree.root!, "▶ Run")!); });
    await flushPromises();

    expect(instText(tree.root!)).toContain("Showing the first 100 rows for responsiveness.");
    expect(instText(tree.root!)).toContain("CAT-0100");
    expect(instText(tree.root!)).not.toContain("CAT-0101");
    expect(findPressable(tree.root!, "Download CSV")).not.toBeNull();
  });

  it("rejects a non-SVG floor-plan selection before any upload request", async () => {
    mockDocumentPicker.getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ name: "warehouse.png", uri: "file://warehouse.png", mimeType: "image/png", size: 100 }],
    });
    const tree = await renderAdminImport();

    await act(async () => {
      fireEvent.press(findPressable(tree.root!, "Choose SVG File")!);
    });
    await flushPromises();

    expect(instText(tree.root!)).toContain("Choose an SVG file with an .svg extension");
    expect(findPressable(tree.root!, "Upload Floor Plan")).toBeNull();
    expect(mockFetch.mock.calls.some(([url]) => String(url).includes("/admin/floor-plan"))).toBe(false);
  });

  it("keeps a selected SVG for retry when its content is malformed", async () => {
    mockDocumentPicker.getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ name: "warehouse.svg", uri: "file://warehouse.svg", mimeType: "image/svg+xml", size: 100 }],
    });
    mockFloorPlanContent = "not an svg";
    const tree = await renderAdminImport();

    await act(async () => {
      fireEvent.press(findPressable(tree.root!, "Choose SVG File")!);
    });
    await flushPromises();
    expect(findPressable(tree.root!, "Upload Floor Plan")).not.toBeNull();

    await act(async () => {
      fireEvent.press(findPressable(tree.root!, "Upload Floor Plan")!);
    });
    await flushPromises();

    expect(instText(tree.root!)).toContain("does not contain a complete SVG document");
    expect(findPressable(tree.root!, "Upload Floor Plan")).not.toBeNull();
    expect(mockFetch.mock.calls.some(([url]) => String(url).includes("/admin/floor-plan"))).toBe(false);
  });
});