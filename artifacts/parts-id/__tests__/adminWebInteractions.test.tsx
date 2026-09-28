/**
 * @jest-environment jsdom
 *
 * These tests deliberately use React Native Web and React DOM rather than the
 * react-test-renderer host mocks used by the other Admin suites.  Calling a
 * Pressable's onPress prop directly would miss the web layout boundary that
 * previously swallowed real browser clicks.
 */

import React from "react";
import { Alert } from "react-native";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("react-native", () =>
  require("./helpers/mapMocks").createReactNativeMock(require("react-native-web")),
);

const mockRouterPush = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockRouterPush, replace: jest.fn(), navigate: jest.fn() }),
  useFocusEffect: jest.fn(),
}));

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn().mockResolvedValue(null),
  setItem: jest.fn().mockResolvedValue(undefined),
  removeItem: jest.fn().mockResolvedValue(undefined),
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

jest.mock("@/utils/adminUserActions", () => ({
  fetchAdminUsers: jest.fn().mockResolvedValue(undefined),
  handleUserAction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/utils/apiBase", () => ({ API_BASE: "http://localhost:3001/api" }));
jest.mock("@/utils/useTrackScreen", () => ({ useTrackScreen: jest.fn() }));
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
jest.mock("@/styles/shared", () => ({ secondaryBtnBase: {} }));

jest.mock("@/components/AddPartForm", () => ({ AddPartForm: () => null }));
jest.mock("@/components/BarcodeAddPart", () => ({ BarcodeAddPart: () => null }));
jest.mock("@/components/BinEditor", () => ({ BinEditor: () => null }));
jest.mock("@/components/BulkShelfAssign", () => ({ BulkShelfAssign: () => null }));
jest.mock("@/components/CatalogPdfUpload", () => ({ CatalogPdfUpload: () => null }));
jest.mock("@/components/KeyboardDoneInput", () => ({
  KeyboardDoneInput: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("@/components/MeasurePartScreen", () => ({ MeasurePartScreen: () => null }));
jest.mock("@/components/ReferenceModal", () => ({ ReferenceModal: () => null }));
jest.mock("@/components/ShelfCatalogEntry", () => ({ ShelfCatalogEntry: () => null }));
jest.mock("@/components/UserAdminButtonRow", () => ({ UserAdminButtonRow: () => null }));

global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });

// These modules are mapped to stable Jest mocks by jest.config.js.
const { useApp } = require("@/contexts/AppContext") as {
  useApp: jest.Mock;
};

const UploadScreen = require("../app/(tabs)/upload").default as React.ComponentType;

function renderAdminHub(isAdmin = true) {
  const logoutAdmin = jest.fn();
  useApp.mockReturnValue({
    settings: {
      textSize: "normal",
      defaultConfidenceThreshold: 50,
      themeMode: "system",
      shelfViewEnabled: true,
      scanSound: true,
      dimensionUnit: "mm",
    },
    updateSetting: jest.fn(),
    logout: jest.fn(),
    logoutAdmin,
    clearCache: jest.fn(),
    isLoading: false,
    isAdmin,
    adminToken: isAdmin ? "tok-abc" : null,
    registerLogoutHandler: jest.fn(() => () => {}),
    setPendingMapFocus: jest.fn(),
    showToast: jest.fn(),
    setPinnedParts: jest.fn(),
    pendingMeasureSearch: null,
    setPendingMeasureSearch: jest.fn(),
    pendingInventoryEdit: null,
    setPendingInventoryEdit: jest.fn(),
  });
  return { ...render(<UploadScreen />), logoutAdmin };
}

function mockDescriptionExpansionStatus(
  status: Record<string, unknown>,
): jest.Mock {
  const fetchMock = jest.fn().mockImplementation((input: unknown) => {
    if (String(input).includes("/inventory/description-expansion/status")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => status,
      });
    }
    return Promise.resolve({ ok: false, status: 500 });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

afterEach(() => {
  mockRouterPush.mockClear();
  jest.clearAllMocks();
});

describe("UploadScreen — browser interactions", () => {
  beforeAll(() => {
    // UploadScreen starts background health polling on mount. Network is not
    // part of this DOM interaction test, so keep rejected mock requests from
    // obscuring the click assertions with expected console noise.
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ["Open Data Import section", /Import File/],
    ["Open AI and Enrichment section", /Enrichment Coverage/],
    ["Open Warehouse section", /Shelf Catalog Entry/],
    ["Open People and System section", /Navigation/],
  ])("opens a section from a real web click", (cardLabel, sectionText) => {
    renderAdminHub();

    fireEvent.click(screen.getByRole("button", { name: cardLabel }));

    expect(screen.getByText(sectionText)).toBeTruthy();
  });

  it("opens the People & System section from a real web click", () => {
    renderAdminHub();

    fireEvent.click(screen.getByRole("button", { name: "Open People and System section" }));

    expect(screen.getByText(/Navigation/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Admin Dashboard" })).toBeTruthy();
  });

  it("routes from People & System rows through real web clicks", () => {
    renderAdminHub();

    fireEvent.click(screen.getByRole("button", { name: "Open People and System section" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Admin Dashboard" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Admin Inbox" }));
    fireEvent.click(screen.getByRole("button", { name: "Open AI Log" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Admin Audit Log" }));

    expect(mockRouterPush).toHaveBeenNthCalledWith(1, "/admin");
    expect(mockRouterPush).toHaveBeenNthCalledWith(2, "/admin-inbox");
    expect(mockRouterPush).toHaveBeenNthCalledWith(3, "/ai-log");
    expect(mockRouterPush).toHaveBeenNthCalledWith(4, "/admin-audit-log");
  });

  it("refreshes People & System data from a real web click", () => {
    const { fetchAdminUsers } = require("@/utils/adminUserActions") as {
      fetchAdminUsers: jest.Mock;
    };
    renderAdminHub();

    fireEvent.click(screen.getByRole("button", { name: "Open People and System section" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh users" }));

    expect(fetchAdminUsers).toHaveBeenCalled();
  });

  it("shows the persisted database expansion counts in People & System", async () => {
    const fetchMock = mockDescriptionExpansionStatus({
      status: "completed",
      running: false,
      stopRequested: false,
      cursor: 100,
      model: "Gemini-3.1-Pro",
      startedAt: "2026-09-23T00:00:00.000Z",
      finishedAt: "2026-09-23T00:10:00.000Z",
      total: 42,
      processed: 42,
      saved: 30,
      discarded: 10,
      errors: 2,
      remaining: 12,
      lastError: null,
    });
    renderAdminHub();

    fireEvent.click(screen.getByRole("button", { name: "Open People and System section" }));

    expect(await screen.findByText(/Database Description Expansion/)).toBeTruthy();
    expect(screen.getAllByText("42").length).toBeGreaterThan(0);
    expect(screen.getByText("30")).toBeTruthy();
    expect(screen.getByText("10")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/inventory/description-expansion/status"),
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it("keeps the database expansion start behind confirmation", () => {
    const alertMock = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
    renderAdminHub();

    fireEvent.click(screen.getByRole("button", { name: "Open People and System section" }));
    fireEvent.click(screen.getByRole("button", { name: "Start database description expansion" }));

    expect(alertMock).toHaveBeenCalledWith(
      "Start database description expansion?",
      expect.stringContaining("at least 70% confidence"),
      expect.arrayContaining([
        expect.objectContaining({ text: "Cancel" }),
        expect.objectContaining({ text: "Start expansion" }),
      ]),
    );
    alertMock.mockRestore();
  });

  it("logs out and reports an expired admin session from the job status request", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    global.fetch = fetchMock as unknown as typeof fetch;
    const { logoutAdmin } = renderAdminHub();

    fireEvent.click(screen.getByRole("button", { name: "Open People and System section" }));

    await waitFor(() => expect(logoutAdmin).toHaveBeenCalled());
    expect(screen.getByText(/Admin session expired\. Please unlock again\./)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/inventory/description-expansion/status"),
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it("keeps Admin controls gated on the web surface", () => {
    renderAdminHub(false);

    expect(screen.getByText("Admin Access Required")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open People and System section" })).toBeNull();
  });
});