/**
 * Rendered regression coverage for the admin SQL query workflow.
 *
 * This mounts the real UploadScreen, opens its Warehouse section, and drives:
 *   - query entry and execution with the protected-column metadata returned by
 *     the server,
 *   - native CSV/XLSX file creation and sharing, and
 *   - a rejected query after a successful query, proving stale rows disappear
 *     and no export request is attempted.
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";

// ── Clerk ─────────────────────────────────────────────────────────────────────

jest.mock("@clerk/expo", () => ({
  useAuth: () => ({ userId: "admin-user" }),
}));

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
    pendingLidarDims: null,
    setPendingLidarDims: jest.fn(),
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

beforeEach(() => {
  jest.clearAllMocks();
  mockWrittenFiles.length = 0;
  nextQueryResponse = undefined;
  installFetchMock();
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

  it("shows a rejected-query error without stale rows or an export attempt", async () => {
    const tree = await renderAdminWarehouse();
    const input = findQueryInput(tree.root!);

    await act(async () => { fireEvent.changeText(input, validSql); });
    await act(async () => {
      fireEvent.press(findPressable(tree.root!, "▶ Run")!);
    });
    await flushPromises();
    expect(instText(tree.root!)).toContain("CONTACTOR-42");

    const rejectedSql = "DELETE FROM inventory";
    nextQueryResponse = {
      ok: false,
      status: 400,
      body: { error: "Only read-only SELECT queries are allowed." },
    };
    await act(async () => { fireEvent.changeText(input, rejectedSql); });
    await act(async () => {
      fireEvent.press(findPressable(tree.root!, "▶ Run")!);
    });
    await flushPromises();

    expect(instText(tree.root!)).toContain("Only read-only SELECT queries are allowed.");
    expect(instText(tree.root!)).not.toContain("CONTACTOR-42");
    expect(findPressable(tree.root!, "Download CSV")).toBeNull();
    expect(findPressable(tree.root!, "Download Excel")).toBeNull();
    expect(mockFetch.mock.calls.filter(([url]) =>
      String(url).includes("/admin/query?format="),
    )).toHaveLength(0);
    expect(mockShareAsync).not.toHaveBeenCalled();
  });
});