/**
 * Rendered regression coverage for the administrator spreadsheet import flow.
 *
 * The test mounts the real UploadScreen, lets the production XLSX parsing and
 * CSV serialization run, and mocks only the native picker and network boundary.
 * It covers the safety invariant that preview must succeed before an upload is
 * enabled, and that an invalid replacement selection cannot leave stale rows
 * eligible for upload.
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";
import * as DocumentPicker from "expo-document-picker";
import { readSheet } from "read-excel-file/universal";

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

const mockGetDocumentAsync = DocumentPicker.getDocumentAsync as jest.Mock;
jest.mock("expo-document-picker", () => ({
  getDocumentAsync: jest.fn().mockResolvedValue({ canceled: true }),
}));

jest.mock("expo-file-system", () => ({
  readAsStringAsync: jest.fn().mockResolvedValue(""),
  File: class {
    uri: string;
    constructor(uri: string) { this.uri = uri; }
    async text() { return ""; }
    async arrayBuffer() { return new ArrayBuffer(0); }
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

const mockReadSheet = readSheet as jest.Mock;
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

type Inst = TestInstance;

function instText(node: Inst | string): string {
  if (typeof node === "string") return node;
  return (node.children ?? []).map(child => instText(child as Inst | string)).join("");
}

function hasText(root: Inst, text: string): boolean {
  return instText(root).includes(text);
}

function findPressable(root: Inst, label: string): Inst | null {
  return root.queryAll(
    (node: TestInstance) =>
      (node.type as string) === "rn-pressable" &&
      instText(node).includes(label),
    { includeSelf: true },
  )[0] ?? null;
}

function response(body: unknown, status = 200, text = "") {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => text,
    arrayBuffer: async () => new ArrayBuffer(8),
  };
}

const validWorkbook = {
  canceled: false,
  assets: [{ name: "inventory.xlsx", uri: "file://valid-workbook.xlsx" }],
};
const invalidSelection = {
  canceled: false,
  assets: [{ name: "notes.csv", uri: "file://invalid-selection.csv" }],
};

type RecordedRequest = {
  url: string;
  init?: RequestInit | undefined;
};

const mockFetch = jest.fn();
const apiRequests: RecordedRequest[] = [];
const originalFetch = global.fetch;

function configureNetwork() {
  apiRequests.length = 0;
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "file://valid-workbook.xlsx") return response({});
    if (url === "file://invalid-selection.csv") return response({}, 200, "not a workbook");

    if (url.endsWith("/admin/ai-status")) return response({ bots: {} });
    if (url.endsWith("/inventory/enrich-summary")) {
      return response({ total: 0, enriched: 0, unenriched: 0 });
    }
    if (url.endsWith("/inventory/bulk-enrich/status")) {
      return response({
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
      });
    }
    if (url.endsWith("/inventory/enrich-measurements/status")) {
      return response({
        running: false,
        startedAt: null,
        processed: 0,
        updated: 0,
        total: null,
        finishedAt: null,
        lastError: null,
      });
    }
    if (url.endsWith("/admin/upload/preview")) {
      apiRequests.push({ url, init });
      return response({
        willReplaceBins: 1,
        willAddBins: 0,
        willPreserveBins: 0,
        noChange: 0,
        rows: [{
          vendor: "ACME",
          catalog: "XLSX-001",
          status: "replace",
          existingBins: ["OLD-A1"],
          incomingBins: ["NEW-B2"],
          barcodeStatus: "none",
          existingBarcodes: [],
        }],
        willReplaceBarcodes: 0,
        willAddBarcodes: 0,
        willPreserveBarcodes: 0,
        willBarcodeConflicts: 0,
      });
    }
    if (url.endsWith("/admin/upload")) {
      apiRequests.push({ url, init });
      return response({ inserted: 1, updated: 0, total: 1 });
    }
    return response({});
  });
  global.fetch = mockFetch as unknown as typeof fetch;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const UploadScreen = (require("../app/(tabs)/upload") as { default: React.ComponentType }).default;

let activeTree: Awaited<ReturnType<typeof render>> | null = null;

function screenRoot(): Inst {
  if (!activeTree?.root) throw new Error("UploadScreen is not mounted");
  return activeTree.root;
}

beforeEach(() => {
  useApp.mockReturnValue(makeAdminApp());
  mockGetDocumentAsync.mockReset();
  mockGetDocumentAsync.mockResolvedValue(validWorkbook);
  mockReadSheet.mockReset();
  mockReadSheet.mockResolvedValue([
    ["Vendor", "Catalog", "Description", "BinLocation"],
    ["ACME", "XLSX-001", "20A breaker", "NEW-B2"],
  ]);
  mockRefetch.mockReset();
  mockRefetch.mockResolvedValue(undefined);
  configureNetwork();
});

afterEach(async () => {
  if (activeTree) {
    await activeTree.unmount();
    activeTree = null;
  }
  global.fetch = originalFetch;
  mockGetDocumentAsync.mockClear();
  mockReadSheet.mockClear();
  mockFetch.mockClear();
  apiRequests.length = 0;
});

const flushPromises = () => act(async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
});

describe("UploadScreen — administrator spreadsheet import workflow", () => {
  it("previews before commit, requires confirmation, completes upload, and rejects stale invalid selections", async () => {
    activeTree = await render(<UploadScreen />);
    await flushPromises();

    const importCard = findPressable(screenRoot(), "Data Import");
    expect(importCard).not.toBeNull();
    await act(async () => { fireEvent.press(importCard!); });

    const chooseFile = () => findPressable(screenRoot(), "Choose CSV, Excel, or ODS File");
    expect(chooseFile()).not.toBeNull();
    await act(async () => { fireEvent.press(chooseFile()!); });

    await waitFor(() => {
      expect(hasText(screenRoot(), "Preview (1 rows)")).toBe(true);
    });
    await flushPromises();

    expect(apiRequests).toHaveLength(1);
    expect(apiRequests[0]!.url).toContain("/admin/upload/preview");
    expect(apiRequests[0]!.init?.headers).toMatchObject({
      Authorization: "Bearer admin-test-token",
    });
    const previewBody = JSON.parse(String(apiRequests[0]!.init?.body)) as { csv: string };
    expect(previewBody.csv).toContain('"ACME","XLSX-001","20A breaker","NEW-B2"');
    expect(hasText(screenRoot(), "will overwrite existing bin assignments")).toBe(true);
    expect(findPressable(screenRoot(), "I understand 1 existing bin assignment")).not.toBeNull();
    expect(findPressable(screenRoot(), "Confirm replacement to upload")?.props.disabled).toBe(true);

    // A malformed replacement selection clears the previous preview instead
    // of allowing the old workbook rows to be uploaded accidentally.
    mockGetDocumentAsync.mockResolvedValueOnce(invalidSelection);
    await act(async () => { fireEvent.press(chooseFile()!); });
    await waitFor(() => {
      expect(hasText(screenRoot(), "No data rows found")).toBe(true);
    });
    expect(apiRequests).toHaveLength(1);
    expect(hasText(screenRoot(), "Preview (1 rows)")).toBe(false);
    expect(findPressable(screenRoot(), "Upload 1 Items")).toBeNull();

    // Reselect the valid workbook to finish the normal preview → confirm →
    // upload flow after the invalid selection was safely discarded.
    mockGetDocumentAsync.mockResolvedValueOnce(validWorkbook);
    await act(async () => { fireEvent.press(chooseFile()!); });
    await waitFor(() => {
      expect(hasText(screenRoot(), "Preview (1 rows)")).toBe(true);
    });
    await flushPromises();
    expect(apiRequests).toHaveLength(2);
    expect(apiRequests[1]!.url).toContain("/admin/upload/preview");

    const confirmReplacement = findPressable(screenRoot(), "I understand 1 existing bin assignment");
    expect(confirmReplacement).not.toBeNull();
    await act(async () => { fireEvent.press(confirmReplacement!); });

    const upload = findPressable(screenRoot(), "Upload 1 Items");
    expect(upload).not.toBeNull();
    expect(upload!.props.disabled).toBe(false);
    await act(async () => { fireEvent.press(upload!); });
    await waitFor(() => {
      expect(hasText(screenRoot(), "Upload complete — inserted 1, updated 0 (1 total)")).toBe(true);
    });

    expect(apiRequests).toHaveLength(3);
    expect(apiRequests[2]!.url).toContain("/admin/upload");
    expect(apiRequests[2]!.url).not.toContain("/admin/upload/preview");
    expect(apiRequests[2]!.init?.headers).toMatchObject({
      Authorization: "Bearer admin-test-token",
    });
    const uploadBody = JSON.parse(String(apiRequests[2]!.init?.body)) as { csv: string };
    expect(uploadBody.csv).toContain('"ACME","XLSX-001","20A breaker","NEW-B2"');
    expect(apiRequests.findIndex(request => request.url.endsWith("/admin/upload/preview")))
      .toBeLessThan(apiRequests.findIndex(request => request.url.endsWith("/admin/upload")));
  });
});