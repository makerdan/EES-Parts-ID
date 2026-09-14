/**
 * @jest-environment jsdom
 *
 * These tests deliberately use React Native Web and React DOM rather than the
 * react-test-renderer host mocks used by the other Admin suites.  Calling a
 * Pressable's onPress prop directly would miss the web layout boundary that
 * previously swallowed real browser clicks.
 */

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

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
    logoutAdmin: jest.fn(),
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
  return render(<UploadScreen />);
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

  it("keeps Admin controls gated on the web surface", () => {
    renderAdminHub(false);

    expect(screen.getByText("Admin Access Required")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open People and System section" })).toBeNull();
  });
});