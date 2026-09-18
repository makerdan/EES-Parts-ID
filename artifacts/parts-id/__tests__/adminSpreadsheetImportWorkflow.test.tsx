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
import * as SecureStore from "expo-secure-store";
import { readSheet } from "read-excel-file/universal";

let mockCurrentUserId: string | undefined = "admin-user";
jest.mock("@clerk/expo", () => ({
  useAuth: () => ({ userId: mockCurrentUserId }),
}));

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
const mockSecureGet = SecureStore.getItemAsync as jest.Mock;
const mockSecureSet = SecureStore.setItemAsync as jest.Mock;
const mockSecureDelete = SecureStore.deleteItemAsync as jest.Mock;
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

const oldWorkbookBuffer = new ArrayBuffer(8);
const newWorkbookBuffer = new ArrayBuffer(8);

const validWorkbook = {
  canceled: false,
  assets: [{ name: "inventory.xlsx", uri: "file://valid-workbook.xlsx" }],
};
const oldWorkbook = {
  canceled: false,
  assets: [{ name: "old-workbook.xlsx", uri: "file://old-workbook.xlsx" }],
};
const newWorkbook = {
  canceled: false,
  assets: [{ name: "new-workbook.xlsx", uri: "file://new-workbook.xlsx" }],
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
    if (url === "file://old-workbook.xlsx") return {
      ...response({}),
      arrayBuffer: async () => oldWorkbookBuffer,
    };
    if (url === "file://new-workbook.xlsx") return {
      ...response({}),
      arrayBuffer: async () => newWorkbookBuffer,
    };
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
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { saveImportDraft } = require("../utils/importDraftStorage") as typeof import("../utils/importDraftStorage");

let activeTree: Awaited<ReturnType<typeof render>> | null = null;

function screenRoot(): Inst {
  if (!activeTree?.root) throw new Error("UploadScreen is not mounted");
  return activeTree.root;
}

beforeEach(() => {
  mockCurrentUserId = "admin-user";
  const secureValues = new Map<string, string>();
  mockSecureGet.mockImplementation(async (key: string) => secureValues.get(key) ?? null);
  mockSecureSet.mockImplementation(async (key: string, value: string) => {
    secureValues.set(key, value);
  });
  mockSecureDelete.mockImplementation(async (key: string) => {
    secureValues.delete(key);
  });
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
  it("waits for Clerk identity hydration and never copies a prior user's draft during account switching", async () => {
    await saveImportDraft("admin-user", {
      parsedRows: [{ vendor: "ACME", catalog: "XLSX-001", description: "20A breaker", binLocations: ["NEW-B2"], barcodes: [] }],
      rawCsv: "Vendor,Catalog,Description,BinLocation\nACME,XLSX-001,20A breaker,NEW-B2",
      fileName: "admin-a.xlsx",
      fileType: "xlsx",
      importMode: "full",
      skipBinRows: [],
      selectedUnknownRows: [],
    });
    mockCurrentUserId = undefined;
    activeTree = await render(<UploadScreen />);
    await flushPromises();
    expect(hasText(screenRoot(), "admin-a.xlsx")).toBe(false);

    mockCurrentUserId = "admin-user";
    await activeTree.rerender(<UploadScreen />);
    await waitFor(() => expect(hasText(screenRoot(), "admin-a.xlsx")).toBe(true));

    mockCurrentUserId = "other-user";
    await activeTree.rerender(<UploadScreen />);
    await waitFor(() => expect(hasText(screenRoot(), "admin-a.xlsx")).toBe(false));
    await flushPromises();

    await activeTree.unmount();
    activeTree = null;
    mockCurrentUserId = "admin-user";
    activeTree = await render(<UploadScreen />);
    await waitFor(() => expect(hasText(screenRoot(), "admin-a.xlsx")).toBe(true));
  });

  it("restores a prepared import after remount and reruns preview before enabling commit", async () => {
    let previewCount = 0;
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "file://valid-workbook.xlsx") return response({});
      if (url.endsWith("/admin/ai-status")) return response({ bots: {} });
      if (url.endsWith("/inventory/enrich-summary")) return response({ total: 0, enriched: 0, unenriched: 0 });
      if (url.endsWith("/inventory/bulk-enrich/status")) return response({ running: false, stopRequested: false, force: false, startedAt: null, processed: 0, errors: 0, total: null, finishedAt: null, lastError: null, model: null });
      if (url.endsWith("/inventory/enrich-measurements/status")) return response({ running: false, startedAt: null, processed: 0, updated: 0, total: null, finishedAt: null, lastError: null });
      if (url.endsWith("/admin/upload/preview")) {
        apiRequests.push({ url, init });
        previewCount += 1;
        return response({ willReplaceBins: 1, willAddBins: 0, willPreserveBins: 0, noChange: 0, rows: [{ vendor: "ACME", catalog: "XLSX-001", status: "replace", existingBins: ["OLD-A1"], incomingBins: ["NEW-B2"], barcodeStatus: "none", existingBarcodes: [] }], willReplaceBarcodes: 0, willAddBarcodes: 0, willPreserveBarcodes: 0, willBarcodeConflicts: 0 });
      }
      if (url.endsWith("/admin/upload")) {
        apiRequests.push({ url, init });
        return response({ inserted: 1, updated: 0, total: 1 });
      }
      return response({});
    });

    activeTree = await render(<UploadScreen />);
    await flushPromises();
    await act(async () => { fireEvent.press(findPressable(screenRoot(), "Data Import")!); });
    await act(async () => { fireEvent.press(findPressable(screenRoot(), "Choose CSV, Excel, or ODS File")!); });
    await waitFor(() => expect(previewCount).toBe(1));
    await act(async () => { fireEvent.press(findPressable(screenRoot(), "⚠")!); });
    await waitFor(() => expect(mockSecureSet).toHaveBeenCalled());
    await activeTree.unmount();
    activeTree = null;

    apiRequests.length = 0;
    activeTree = await render(<UploadScreen />);
    await waitFor(() => expect(hasText(screenRoot(), "inventory.xlsx")).toBe(true));
    await waitFor(() => expect(previewCount).toBe(2));
    expect(hasText(screenRoot(), "(kept)")).toBe(true);
    expect(findPressable(screenRoot(), "Review restored import before upload")?.props.disabled).toBe(true);
    expect(apiRequests.filter(request => request.url.endsWith("/admin/upload"))).toHaveLength(0);
    await act(async () => { fireEvent.press(findPressable(screenRoot(), "I reviewed the restored import")!); });
    expect(findPressable(screenRoot(), "Upload 1 Items")?.props.disabled).toBe(false);
  });

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

  it("keeps the newest workbook when picker parses resolve out of order", async () => {
    activeTree = await render(<UploadScreen />);
    await flushPromises();

    const importCard = findPressable(screenRoot(), "Data Import");
    expect(importCard).not.toBeNull();
    await act(async () => { fireEvent.press(importCard!); });

    const chooseFile = () => findPressable(screenRoot(), "Choose CSV, Excel, or ODS File");
    expect(chooseFile()).not.toBeNull();
    let resolveOldPicker!: (result: typeof oldWorkbook) => void;
    let resolveNewPicker!: (result: typeof newWorkbook) => void;
    const oldPicker = new Promise<typeof oldWorkbook>(resolve => { resolveOldPicker = resolve; });
    const newPicker = new Promise<typeof newWorkbook>(resolve => { resolveNewPicker = resolve; });
    mockGetDocumentAsync
      .mockImplementationOnce(() => oldPicker);

    const oldRows = [
      ["Vendor", "Catalog", "Description", "BinLocation"],
      ["OLDCO", "OLD-001", "old row", "OLD-BIN"],
    ];
    const newRows = [
      ["Vendor", "Catalog", "Description", "BinLocation"],
      ["NEWCO", "NEW-001", "new row", "NEW-BIN"],
    ];
    const pendingSheetReads = new Map<ArrayBuffer, (rows: unknown[][]) => void>();
    mockReadSheet.mockImplementation((arrayBuffer: ArrayBuffer) =>
      new Promise<unknown[][]>(resolve => {
        pendingSheetReads.set(arrayBuffer, resolve);
      }),
    );

    await act(async () => { fireEvent.press(chooseFile()!); });

    await act(async () => {
      resolveOldPicker(oldWorkbook);
    });
    await waitFor(() => expect(mockReadSheet).toHaveBeenCalledTimes(1));

    mockGetDocumentAsync.mockImplementationOnce(() => newPicker);
    await act(async () => { fireEvent.press(chooseFile()!); });
    expect(mockGetDocumentAsync).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveNewPicker(newWorkbook);
    });
    await waitFor(() => expect(mockReadSheet).toHaveBeenCalledTimes(2));
    expect(pendingSheetReads.has(oldWorkbookBuffer)).toBe(true);
    expect(pendingSheetReads.has(newWorkbookBuffer)).toBe(true);

    await act(async () => {
      pendingSheetReads.get(newWorkbookBuffer)!(newRows);
    });
    await waitFor(() => {
      expect(hasText(screenRoot(), "new-workbook.xlsx")).toBe(true);
      expect(hasText(screenRoot(), "Preview (1 rows)")).toBe(true);
    });

    // The slower first parser result must not replace the newer workbook or
    // trigger a second preview request.
    await act(async () => {
      pendingSheetReads.get(oldWorkbookBuffer)!(oldRows);
    });
    await flushPromises();
    expect(hasText(screenRoot(), "new-workbook.xlsx")).toBe(true);
    expect(hasText(screenRoot(), "old-workbook.xlsx")).toBe(false);
    expect(apiRequests).toHaveLength(1);
    const previewBody = JSON.parse(String(apiRequests[0]!.init?.body)) as { csv: string };
    expect(previewBody.csv).toContain('"NEWCO","NEW-001","new row","NEW-BIN"');
    expect(previewBody.csv).not.toContain('"OLDCO","OLD-001","old row","OLD-BIN"');

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

    expect(apiRequests).toHaveLength(2);
    expect(apiRequests[1]!.url).toContain("/admin/upload");
    const uploadBody = JSON.parse(String(apiRequests[1]!.init?.body)) as { csv: string };
    expect(uploadBody.csv).toContain('"NEWCO","NEW-001","new row","NEW-BIN"');
    expect(uploadBody.csv).not.toContain('"OLDCO","OLD-001","old row","OLD-BIN"');
  });

  it("keeps pasted rows when a file parser resolves after the paste debounce", async () => {
    activeTree = await render(<UploadScreen />);
    await flushPromises();

    const importCard = findPressable(screenRoot(), "Data Import");
    expect(importCard).not.toBeNull();
    await act(async () => { fireEvent.press(importCard!); });

    const chooseFile = () => findPressable(screenRoot(), "Choose CSV, Excel, or ODS File");
    expect(chooseFile()).not.toBeNull();

    const oldRows = [
      ["Vendor", "Catalog", "Description", "BinLocation"],
      ["OLDCO", "OLD-001", "old row", "OLD-BIN"],
    ];
    let resolveOldPicker!: (result: typeof oldWorkbook) => void;
    const oldPicker = new Promise<typeof oldWorkbook>(resolve => { resolveOldPicker = resolve; });
    let resolveOldSheetRead!: (rows: unknown[][]) => void;
    const pendingOldSheetRead = new Promise<unknown[][]>(resolve => { resolveOldSheetRead = resolve; });
    mockGetDocumentAsync.mockImplementationOnce(() => oldPicker);
    mockReadSheet.mockImplementationOnce(() => pendingOldSheetRead);

    await act(async () => { fireEvent.press(chooseFile()!); });
    await act(async () => { resolveOldPicker(oldWorkbook); });
    await waitFor(() => expect(mockReadSheet).toHaveBeenCalledTimes(1));

    const pasteInput = screenRoot().queryAll(
      (node: TestInstance) =>
        (node.type as string) === "rn-text-input" &&
        node.props.placeholder === "Vendor,Catalog,Description,BinLocation\nEATON,BR120,1 Pole Breaker,A1",
      { includeSelf: true },
    )[0];
    expect(pasteInput).not.toBeUndefined();

    const pastedRows = [
      ["Vendor", "Catalog", "Description", "BinLocation"],
      ["PASTECO", "PASTE-001", "pasted row", "PASTE-BIN"],
    ];
    const pastedText = pastedRows.map(row => row.join(",")).join("\n");
    await act(async () => {
      fireEvent.changeText(pasteInput!, pastedText);
      await new Promise(resolve => setTimeout(resolve, 450));
    });
    await waitFor(() => {
      expect(hasText(screenRoot(), "Preview (1 rows)")).toBe(true);
    });

    // The delayed file parser must not replace the newer pasted input or
    // trigger another preview request.
    await act(async () => {
      resolveOldSheetRead(oldRows);
    });
    await flushPromises();
    expect(hasText(screenRoot(), "old-workbook.xlsx")).toBe(false);
    expect(apiRequests).toHaveLength(1);
    const previewBody = JSON.parse(String(apiRequests[0]!.init?.body)) as { csv: string };
    expect(previewBody.csv).toContain('"PASTECO","PASTE-001","pasted row","PASTE-BIN"');
    expect(previewBody.csv).not.toContain('"OLDCO","OLD-001","old row","OLD-BIN"');

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

    expect(apiRequests).toHaveLength(2);
    const uploadBody = JSON.parse(String(apiRequests[1]!.init?.body)) as { csv: string };
    expect(uploadBody.csv).toContain('"PASTECO","PASTE-001","pasted row","PASTE-BIN"');
    expect(uploadBody.csv).not.toContain('"OLDCO","OLD-001","old row","OLD-BIN"');
  });

  it("parses OP/OQ files sequentially and lets the last selected file win", async () => {
    const firstBuffer = new ArrayBuffer(16);
    const multiSelection = {
      canceled: false,
      assets: [
        { name: "first.xlsx", uri: "file://first.xlsx" },
        { name: "second.csv", uri: "file://second.csv" },
      ],
    };
    let resolveFirstSheet!: (rows: unknown[][]) => void;
    const firstSheet = new Promise<unknown[][]>(resolve => { resolveFirstSheet = resolve; });
    mockGetDocumentAsync.mockResolvedValueOnce(multiSelection);
    mockReadSheet.mockImplementationOnce(() => firstSheet);
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "file://first.xlsx") {
        return { ...response({}), arrayBuffer: async () => firstBuffer };
      }
      if (url === "file://second.csv") {
        return response(
          {},
          200,
          [
            "Vendor,Catalog,Description,BinLocation,OP,OQ",
            " acme , dup-1 ,new value,B2,9,10",
            "BETA,CSV-2,csv row,C3,4,5",
          ].join("\n"),
        );
      }
      if (url.endsWith("/admin/upload/orders/preview")) {
        apiRequests.push({ url, init });
        return response({
          known: 3,
          unknownWithBins: 0,
          unknownWithoutBins: 0,
          rows: [
            { vendor: "acme", catalog: "dup-1", known: true, hasBins: true, orderPurchase: 9, orderQuantity: 10 },
            { vendor: "FIRST", catalog: "ONLY-1", known: true, hasBins: true, orderPurchase: 2, orderQuantity: 3 },
            { vendor: "BETA", catalog: "CSV-2", known: true, hasBins: true, orderPurchase: 4, orderQuantity: 5 },
          ],
        });
      }
      if (url.endsWith("/admin/upload/orders")) {
        apiRequests.push({ url, init });
        return response({ updated: 3 });
      }
      if (url.endsWith("/admin/ai-status")) return response({ bots: {} });
      if (url.endsWith("/inventory/enrich-summary")) return response({ total: 0, enriched: 0, unenriched: 0 });
      if (url.endsWith("/inventory/bulk-enrich/status")) return response({ running: false, stopRequested: false, force: false, startedAt: null, processed: 0, errors: 0, total: null, finishedAt: null, lastError: null, model: null });
      if (url.endsWith("/inventory/enrich-measurements/status")) return response({ running: false, startedAt: null, processed: 0, updated: 0, total: null, finishedAt: null, lastError: null });
      return response({});
    });

    activeTree = await render(<UploadScreen />);
    await flushPromises();
    await act(async () => { fireEvent.press(findPressable(screenRoot(), "Data Import")!); });
    await act(async () => { fireEvent.press(findPressable(screenRoot(), "Update OP/OQ Only")!); });
    await act(async () => { fireEvent.press(findPressable(screenRoot(), "Choose CSV, Excel, or ODS Files")!); });

    await waitFor(() => expect(mockReadSheet).toHaveBeenCalledTimes(1));
    expect(mockGetDocumentAsync).toHaveBeenCalledWith(expect.objectContaining({ multiple: true }));
    expect(mockFetch.mock.calls.some(([url]) => url === "file://second.csv")).toBe(false);

    await act(async () => {
      resolveFirstSheet([
        ["Vendor", "Catalog", "Description", "BinLocation", "OP", "OQ"],
        ["ACME", "DUP-1", "old value", "A1", 1, 2],
        ["FIRST", "ONLY-1", "xlsx row", "A2", 2, 3],
      ]);
    });

    await waitFor(() => expect(hasText(screenRoot(), "Combined rows: 3")).toBe(true));
    expect(hasText(screenRoot(), "first.xlsx")).toBe(true);
    expect(hasText(screenRoot(), "second.csv")).toBe(true);
    expect(apiRequests).toHaveLength(1);
    const previewBody = JSON.parse(String(apiRequests[0]!.init?.body)) as { csv: string };
    expect(previewBody.csv).toContain('"acme","dup-1","new value","B2"');
    expect(previewBody.csv).not.toContain('"ACME","DUP-1","old value","A1"');
    expect(previewBody.csv).toContain('"FIRST","ONLY-1","xlsx row","A2"');

    const update = findPressable(screenRoot(), "Update OP/OQ (3)");
    expect(update?.props.disabled).toBe(false);
    await act(async () => { fireEvent.press(update!); });
    await waitFor(() => expect(apiRequests).toHaveLength(2));
    const updateBody = JSON.parse(String(apiRequests[1]!.init?.body)) as { csv: string };
    expect(updateBody.csv).toBe(previewBody.csv);
  });

  it("identifies the invalid OP/OQ file and blocks the combined update", async () => {
    mockGetDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [
        { name: "valid.csv", uri: "file://valid.csv" },
        { name: "empty.xlsx", uri: "file://empty.xlsx" },
      ],
    });
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "file://valid.csv") {
        return response({}, 200, "Vendor,Catalog,OP,OQ\nACME,VALID-1,1,2");
      }
      if (url === "file://empty.xlsx") return response({});
      if (url.endsWith("/admin/ai-status")) return response({ bots: {} });
      if (url.endsWith("/inventory/enrich-summary")) return response({ total: 0, enriched: 0, unenriched: 0 });
      if (url.endsWith("/inventory/bulk-enrich/status")) return response({ running: false, stopRequested: false, force: false, startedAt: null, processed: 0, errors: 0, total: null, finishedAt: null, lastError: null, model: null });
      if (url.endsWith("/inventory/enrich-measurements/status")) return response({ running: false, startedAt: null, processed: 0, updated: 0, total: null, finishedAt: null, lastError: null });
      return response({});
    });
    mockReadSheet.mockResolvedValueOnce([]);

    activeTree = await render(<UploadScreen />);
    await flushPromises();
    await act(async () => { fireEvent.press(findPressable(screenRoot(), "Data Import")!); });
    await act(async () => { fireEvent.press(findPressable(screenRoot(), "Update OP/OQ Only")!); });
    await act(async () => { fireEvent.press(findPressable(screenRoot(), "Choose CSV, Excel, or ODS Files")!); });

    await waitFor(() => expect(hasText(screenRoot(), 'No data rows found in "empty.xlsx"')).toBe(true));
    expect(hasText(screenRoot(), "empty.xlsx (failed)")).toBe(true);
    expect(hasText(screenRoot(), "Preview (")).toBe(false);
    expect(findPressable(screenRoot(), "Update OP/OQ (")).toBeNull();
    expect(apiRequests).toHaveLength(0);
  });

  it("does not let a stale multi-file parse replace a newer OP/OQ selection", async () => {
    let resolveOldRows!: (rows: unknown[][]) => void;
    const oldRows = new Promise<unknown[][]>(resolve => { resolveOldRows = resolve; });
    mockGetDocumentAsync
      .mockResolvedValueOnce({
        canceled: false,
        assets: [
          { name: "slow.xlsx", uri: "file://slow.xlsx" },
          { name: "never.csv", uri: "file://never.csv" },
        ],
      })
      .mockResolvedValueOnce({
        canceled: false,
        assets: [{ name: "current.csv", uri: "file://current.csv" }],
      });
    mockReadSheet.mockImplementationOnce(() => oldRows);
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "file://slow.xlsx") return response({});
      if (url === "file://never.csv") return response({}, 200, "Vendor,Catalog,OP,OQ\nOLD,NEVER,1,1");
      if (url === "file://current.csv") return response({}, 200, "Vendor,Catalog,OP,OQ\nNEW,CURRENT,7,8");
      if (url.endsWith("/admin/upload/orders/preview")) {
        apiRequests.push({ url, init });
        return response({
          known: 1,
          unknownWithBins: 0,
          unknownWithoutBins: 0,
          rows: [{ vendor: "NEW", catalog: "CURRENT", known: true, hasBins: false, orderPurchase: 7, orderQuantity: 8 }],
        });
      }
      if (url.endsWith("/admin/ai-status")) return response({ bots: {} });
      if (url.endsWith("/inventory/enrich-summary")) return response({ total: 0, enriched: 0, unenriched: 0 });
      if (url.endsWith("/inventory/bulk-enrich/status")) return response({ running: false, stopRequested: false, force: false, startedAt: null, processed: 0, errors: 0, total: null, finishedAt: null, lastError: null, model: null });
      if (url.endsWith("/inventory/enrich-measurements/status")) return response({ running: false, startedAt: null, processed: 0, updated: 0, total: null, finishedAt: null, lastError: null });
      return response({});
    });

    activeTree = await render(<UploadScreen />);
    await flushPromises();
    await act(async () => { fireEvent.press(findPressable(screenRoot(), "Data Import")!); });
    await act(async () => { fireEvent.press(findPressable(screenRoot(), "Update OP/OQ Only")!); });
    const chooseFiles = () => findPressable(screenRoot(), "Choose CSV, Excel, or ODS Files");
    await act(async () => { fireEvent.press(chooseFiles()!); });
    await waitFor(() => expect(mockReadSheet).toHaveBeenCalledTimes(1));
    await act(async () => { fireEvent.press(chooseFiles()!); });

    await waitFor(() => expect(hasText(screenRoot(), "current.csv")).toBe(true));
    expect(hasText(screenRoot(), "Combined rows: 1")).toBe(true);
    await act(async () => {
      resolveOldRows([
        ["Vendor", "Catalog", "OP", "OQ"],
        ["OLD", "SLOW", 1, 2],
      ]);
    });
    await flushPromises();

    expect(hasText(screenRoot(), "current.csv")).toBe(true);
    expect(hasText(screenRoot(), "slow.xlsx")).toBe(false);
    expect(mockFetch.mock.calls.some(([url]) => url === "file://never.csv")).toBe(false);
    expect(apiRequests).toHaveLength(1);
    const previewBody = JSON.parse(String(apiRequests[0]!.init?.body)) as { csv: string };
    expect(previewBody.csv).toContain('"NEW","CURRENT"');
    expect(previewBody.csv).not.toContain('"OLD","SLOW"');
  });

  it("invalidates an unfinished OP/OQ parse when the import mode changes", async () => {
    let resolveRows!: (rows: unknown[][]) => void;
    const delayedRows = new Promise<unknown[][]>(resolve => { resolveRows = resolve; });
    mockGetDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [
        { name: "delayed.xlsx", uri: "file://delayed.xlsx" },
        { name: "second.csv", uri: "file://second-after-mode-change.csv" },
      ],
    });
    mockReadSheet.mockImplementationOnce(() => delayedRows);
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "file://delayed.xlsx") return response({});
      if (url === "file://second-after-mode-change.csv") {
        return response({}, 200, "Vendor,Catalog,OP,OQ\nOLD,SECOND,3,4");
      }
      if (url.endsWith("/admin/upload/preview") || url.endsWith("/admin/upload/orders/preview")) {
        apiRequests.push({ url, init });
      }
      if (url.endsWith("/admin/ai-status")) return response({ bots: {} });
      if (url.endsWith("/inventory/enrich-summary")) return response({ total: 0, enriched: 0, unenriched: 0 });
      if (url.endsWith("/inventory/bulk-enrich/status")) return response({ running: false, stopRequested: false, force: false, startedAt: null, processed: 0, errors: 0, total: null, finishedAt: null, lastError: null, model: null });
      if (url.endsWith("/inventory/enrich-measurements/status")) return response({ running: false, startedAt: null, processed: 0, updated: 0, total: null, finishedAt: null, lastError: null });
      return response({});
    });

    activeTree = await render(<UploadScreen />);
    await flushPromises();
    await act(async () => { fireEvent.press(findPressable(screenRoot(), "Data Import")!); });
    await act(async () => { fireEvent.press(findPressable(screenRoot(), "Update OP/OQ Only")!); });
    await act(async () => { fireEvent.press(findPressable(screenRoot(), "Choose CSV, Excel, or ODS Files")!); });
    await waitFor(() => expect(mockReadSheet).toHaveBeenCalledTimes(1));

    await act(async () => { fireEvent.press(findPressable(screenRoot(), "Full Catalog Import")!); });
    await act(async () => {
      resolveRows([
        ["Vendor", "Catalog", "OP", "OQ"],
        ["OLD", "DELAYED", 1, 2],
      ]);
    });
    await flushPromises();

    expect(hasText(screenRoot(), "delayed.xlsx")).toBe(false);
    expect(hasText(screenRoot(), "Preview (")).toBe(false);
    expect(mockFetch.mock.calls.some(([url]) => url === "file://second-after-mode-change.csv")).toBe(false);
    expect(apiRequests).toHaveLength(0);
  });

  it("keeps omitted OQ values out of an OP-only multi-file update", async () => {
    mockGetDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [
        { name: "first-op.csv", uri: "file://first-op.csv" },
        { name: "second-op.csv", uri: "file://second-op.csv" },
      ],
    });
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "file://first-op.csv") return response({}, 200, "Vendor,Catalog,OP\nACME,OP-1,4");
      if (url === "file://second-op.csv") return response({}, 200, "Vendor,Catalog,OP\nBETA,OP-2,7");
      if (url.endsWith("/admin/upload/orders/preview")) {
        apiRequests.push({ url, init });
        return response({
          known: 2,
          unknownWithBins: 0,
          unknownWithoutBins: 0,
          rows: [
            { vendor: "ACME", catalog: "OP-1", known: true, hasBins: false, orderPurchase: 4, orderQuantity: 0 },
            { vendor: "BETA", catalog: "OP-2", known: true, hasBins: false, orderPurchase: 7, orderQuantity: 0 },
          ],
        });
      }
      if (url.endsWith("/admin/upload/orders")) {
        apiRequests.push({ url, init });
        return response({ updated: 2 });
      }
      if (url.endsWith("/admin/ai-status")) return response({ bots: {} });
      if (url.endsWith("/inventory/enrich-summary")) return response({ total: 0, enriched: 0, unenriched: 0 });
      if (url.endsWith("/inventory/bulk-enrich/status")) return response({ running: false, stopRequested: false, force: false, startedAt: null, processed: 0, errors: 0, total: null, finishedAt: null, lastError: null, model: null });
      if (url.endsWith("/inventory/enrich-measurements/status")) return response({ running: false, startedAt: null, processed: 0, updated: 0, total: null, finishedAt: null, lastError: null });
      return response({});
    });

    activeTree = await render(<UploadScreen />);
    await flushPromises();
    await act(async () => { fireEvent.press(findPressable(screenRoot(), "Data Import")!); });
    await act(async () => { fireEvent.press(findPressable(screenRoot(), "Update OP/OQ Only")!); });
    await act(async () => { fireEvent.press(findPressable(screenRoot(), "Choose CSV, Excel, or ODS Files")!); });

    await waitFor(() => expect(findPressable(screenRoot(), "Update OP/OQ (2)")?.props.disabled).toBe(false));
    const previewBody = JSON.parse(String(apiRequests[0]!.init?.body)) as { csv: string };
    expect(previewBody.csv.split("\n")[0]).toContain(",OP");
    expect(previewBody.csv.split("\n")[0]).not.toContain(",OQ");

    await act(async () => { fireEvent.press(findPressable(screenRoot(), "Update OP/OQ (2)")!); });
    await waitFor(() => expect(apiRequests).toHaveLength(2));
    const updateBody = JSON.parse(String(apiRequests[1]!.init?.body)) as { csv: string };
    expect(updateBody.csv).toBe(previewBody.csv);
  });

  it("identifies the file that changes an OP-only batch to OQ-only", async () => {
    mockGetDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [
        { name: "op-values.csv", uri: "file://op-values.csv" },
        { name: "oq-values.csv", uri: "file://oq-values.csv" },
      ],
    });
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "file://op-values.csv") return response({}, 200, "Vendor,Catalog,OP\nACME,ONE,4");
      if (url === "file://oq-values.csv") return response({}, 200, "Vendor,Catalog,OQ\nBETA,TWO,7");
      if (url.endsWith("/admin/ai-status")) return response({ bots: {} });
      if (url.endsWith("/inventory/enrich-summary")) return response({ total: 0, enriched: 0, unenriched: 0 });
      if (url.endsWith("/inventory/bulk-enrich/status")) return response({ running: false, stopRequested: false, force: false, startedAt: null, processed: 0, errors: 0, total: null, finishedAt: null, lastError: null, model: null });
      if (url.endsWith("/inventory/enrich-measurements/status")) return response({ running: false, startedAt: null, processed: 0, updated: 0, total: null, finishedAt: null, lastError: null });
      return response({});
    });

    activeTree = await render(<UploadScreen />);
    await flushPromises();
    await act(async () => { fireEvent.press(findPressable(screenRoot(), "Data Import")!); });
    await act(async () => { fireEvent.press(findPressable(screenRoot(), "Update OP/OQ Only")!); });
    await act(async () => { fireEvent.press(findPressable(screenRoot(), "Choose CSV, Excel, or ODS Files")!); });

    await waitFor(() => expect(hasText(screenRoot(), '"oq-values.csv" uses different OP/OQ columns')).toBe(true));
    expect(hasText(screenRoot(), "oq-values.csv (failed)")).toBe(true);
    expect(findPressable(screenRoot(), "Update OP/OQ (")).toBeNull();
    expect(apiRequests).toHaveLength(0);
  });

  it("identifies an OP/OQ file that has no order columns", async () => {
    mockGetDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ name: "no-orders.csv", uri: "file://no-orders.csv" }],
    });
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "file://no-orders.csv") return response({}, 200, "Vendor,Catalog\nACME,NONE");
      if (url.endsWith("/admin/ai-status")) return response({ bots: {} });
      if (url.endsWith("/inventory/enrich-summary")) return response({ total: 0, enriched: 0, unenriched: 0 });
      if (url.endsWith("/inventory/bulk-enrich/status")) return response({ running: false, stopRequested: false, force: false, startedAt: null, processed: 0, errors: 0, total: null, finishedAt: null, lastError: null, model: null });
      if (url.endsWith("/inventory/enrich-measurements/status")) return response({ running: false, startedAt: null, processed: 0, updated: 0, total: null, finishedAt: null, lastError: null });
      return response({});
    });

    activeTree = await render(<UploadScreen />);
    await flushPromises();
    await act(async () => { fireEvent.press(findPressable(screenRoot(), "Data Import")!); });
    await act(async () => { fireEvent.press(findPressable(screenRoot(), "Update OP/OQ Only")!); });
    await act(async () => { fireEvent.press(findPressable(screenRoot(), "Choose CSV, Excel, or ODS Files")!); });

    await waitFor(() => expect(hasText(screenRoot(), 'No OP or OQ column found in "no-orders.csv"')).toBe(true));
    expect(hasText(screenRoot(), "no-orders.csv (failed)")).toBe(true);
    expect(findPressable(screenRoot(), "Update OP/OQ (")).toBeNull();
    expect(apiRequests).toHaveLength(0);
  });

  it("keeps pasted OP/OQ input on the existing preview and update contract", async () => {
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/admin/upload/orders/preview")) {
        apiRequests.push({ url, init });
        return response({
          known: 1,
          unknownWithBins: 0,
          unknownWithoutBins: 0,
          rows: [{ vendor: "PASTE", catalog: "OQ-1", known: true, hasBins: false, orderPurchase: 0, orderQuantity: 12 }],
        });
      }
      if (url.endsWith("/admin/upload/orders")) {
        apiRequests.push({ url, init });
        return response({ updated: 1 });
      }
      if (url.endsWith("/admin/ai-status")) return response({ bots: {} });
      if (url.endsWith("/inventory/enrich-summary")) return response({ total: 0, enriched: 0, unenriched: 0 });
      if (url.endsWith("/inventory/bulk-enrich/status")) return response({ running: false, stopRequested: false, force: false, startedAt: null, processed: 0, errors: 0, total: null, finishedAt: null, lastError: null, model: null });
      if (url.endsWith("/inventory/enrich-measurements/status")) return response({ running: false, startedAt: null, processed: 0, updated: 0, total: null, finishedAt: null, lastError: null });
      return response({});
    });

    activeTree = await render(<UploadScreen />);
    await flushPromises();
    await act(async () => { fireEvent.press(findPressable(screenRoot(), "Data Import")!); });
    await act(async () => { fireEvent.press(findPressable(screenRoot(), "Update OP/OQ Only")!); });
    const pasteInput = screenRoot().queryAll(
      (node: TestInstance) =>
        (node.type as string) === "rn-text-input" &&
        node.props.placeholder === "Vendor,Catalog,Description,BinLocation\nEATON,BR120,1 Pole Breaker,A1",
      { includeSelf: true },
    )[0];

    await act(async () => {
      fireEvent.changeText(pasteInput!, "Vendor,Catalog,OQ\nPASTE,OQ-1,12");
      await new Promise(resolve => setTimeout(resolve, 450));
    });
    await waitFor(() => expect(findPressable(screenRoot(), "Update OP/OQ (1)")?.props.disabled).toBe(false));
    const previewBody = JSON.parse(String(apiRequests[0]!.init?.body)) as { csv: string };
    expect(previewBody.csv).toContain('"PASTE","OQ-1"');
    expect(previewBody.csv.split("\n")[0]).not.toContain(",OP");
    expect(previewBody.csv.split("\n")[0]).toContain(",OQ");

    await act(async () => { fireEvent.press(findPressable(screenRoot(), "Update OP/OQ (1)")!); });
    await waitFor(() => expect(apiRequests).toHaveLength(2));
    const updateBody = JSON.parse(String(apiRequests[1]!.init?.body)) as { csv: string };
    expect(updateBody.csv).toBe(previewBody.csv);
  });

  it("blocks invalid pasted OP/OQ values without throwing or requesting preview", async () => {
    activeTree = await render(<UploadScreen />);
    await flushPromises();
    await act(async () => { fireEvent.press(findPressable(screenRoot(), "Data Import")!); });
    await act(async () => { fireEvent.press(findPressable(screenRoot(), "Update OP/OQ Only")!); });
    const pasteInput = screenRoot().queryAll(
      (node: TestInstance) =>
        (node.type as string) === "rn-text-input" &&
        node.props.placeholder === "Vendor,Catalog,Description,BinLocation\nEATON,BR120,1 Pole Breaker,A1",
      { includeSelf: true },
    )[0];

    await act(async () => {
      fireEvent.changeText(pasteInput!, "Vendor,Catalog,OP,OQ\nPASTE,BAD-1,-1,not-a-number");
      await new Promise(resolve => setTimeout(resolve, 450));
    });

    expect(hasText(screenRoot(), "OP must be a non-negative whole number (row 2)")).toBe(true);
    expect(hasText(screenRoot(), "Preview (")).toBe(false);
    expect(findPressable(screenRoot(), "Update OP/OQ (")).toBeNull();
    expect(apiRequests).toHaveLength(0);
  });
});
