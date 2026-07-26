/**
 * Tests that the three admin nav rows in the "People & System" section
 * of UploadScreen render correctly and navigate to the right routes.
 *
 * ## What & Why
 *
 * The Dashboard, AI Log, and Inbox rows in upload.tsx (lines ~3251-3271)
 * are the sole entry points for those admin screens. This suite confirms:
 *
 *   1. All three rows appear when isAdmin=true and the People section is active.
 *   2. Each row calls router.push with the correct route when tapped.
 *   3. Non-admin users see the lock screen ("Admin Access Required"), not the rows.
 *
 * ## Approach
 *
 * § 1 — Source inspection: locks the route constants against the raw source
 *        so a route rename is caught before any component mount.
 *
 * § 2 — Component mount: renders the real UploadScreen, taps the "People &
 *        System" hub card to transition to activeSection="people", then
 *        asserts each nav row is visible and tappable.
 *
 * § 3 — Navigation: asserts router.push is called with the expected path
 *        for each nav row.
 *
 * § 4 — Non-admin gate: renders with isAdmin=false and asserts the lock
 *        screen appears instead of the nav rows.
 */

// Required for act() to work in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import * as fs from "fs";
import * as path from "path";
import React from "react";
import { render, act, fireEvent } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";

// ── Source path ───────────────────────────────────────────────────────────────

const UPLOAD_PATH = path.resolve(__dirname, "../app/(tabs)/upload.tsx");

// ── expo-router ───────────────────────────────────────────────────────────────

const mockRouterPush = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockRouterPush, replace: jest.fn(), navigate: jest.fn() }),
  useFocusEffect: jest.fn(),
}));

// ── @react-native-async-storage/async-storage ─────────────────────────────────

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem:     jest.fn().mockResolvedValue(null),
  setItem:     jest.fn().mockResolvedValue(undefined),
  removeItem:  jest.fn().mockResolvedValue(undefined),
  multiRemove: jest.fn().mockResolvedValue(undefined),
}));

// ── @workspace/api-client-react ───────────────────────────────────────────────

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

// ── expo-document-picker ──────────────────────────────────────────────────────

jest.mock("expo-document-picker", () => ({
  getDocumentAsync: jest.fn().mockResolvedValue({ canceled: true }),
}));

// ── expo-file-system ──────────────────────────────────────────────────────────

jest.mock("expo-file-system", () => ({
  readAsStringAsync: jest.fn().mockResolvedValue(""),
  File: class {
    uri: string;
    constructor(u: string) { this.uri = u; }
    async text() { return ""; }
    async arrayBuffer() { return new ArrayBuffer(0); }
  },
  Paths: { cache: "/tmp/cache" },
}));

// ── expo-sharing ──────────────────────────────────────────────────────────────

jest.mock("expo-sharing", () => ({
  isAvailableAsync: jest.fn().mockResolvedValue(false),
  shareAsync: jest.fn().mockResolvedValue(undefined),
}));

// ── @expo/vector-icons ────────────────────────────────────────────────────────

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
  MaterialCommunityIcons: () => null,
}));

// ── read-excel-file/universal ─────────────────────────────────────────────────

jest.mock("read-excel-file/universal", () => ({
  readSheet: jest.fn().mockResolvedValue([]),
}));

// ── @/hooks/useApiStatus ──────────────────────────────────────────────────────

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

// ── @/hooks/useColors ─────────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

// ── @/utils/adminUserActions ──────────────────────────────────────────────────

jest.mock("@/utils/adminUserActions", () => ({
  fetchAdminUsers: jest.fn().mockResolvedValue(undefined),
  handleUserAction: jest.fn().mockResolvedValue(undefined),
}));

// ── @/utils/apiBase ───────────────────────────────────────────────────────────

jest.mock("@/utils/apiBase", () => ({ API_BASE: "http://localhost:3001/api" }));

// ── @/utils/useTrackScreen ────────────────────────────────────────────────────

jest.mock("@/utils/useTrackScreen", () => ({ useTrackScreen: jest.fn() }));

// ── @/utils/expandDescHandlers ────────────────────────────────────────────────

jest.mock("@/utils/expandDescHandlers", () => ({
  applyDiscardAll: jest.fn(),
  runSaveAll: jest.fn().mockResolvedValue(undefined),
}));

// ── @/utils/binSkipLogic ──────────────────────────────────────────────────────

jest.mock("@/utils/binSkipLogic", () => ({
  activeReplacementCount: jest.fn().mockReturnValue(0),
  preservedBinCount: jest.fn().mockReturnValue(0),
  serializeToCsv: jest.fn().mockReturnValue(""),
  toggleSkipAll: jest.fn((_rows: unknown, _v: unknown) => []),
  toggleSkipRow: jest.fn((_rows: unknown, _i: unknown) => []),
}));

// ── @/utils/exportCsv ─────────────────────────────────────────────────────────

jest.mock("@/utils/exportCsv", () => ({
  serializeInventoryToCsv: jest.fn().mockReturnValue(""),
}));

// ── @/styles/shared ───────────────────────────────────────────────────────────

jest.mock("@/styles/shared", () => ({ secondaryBtnBase: {} }));

// ── Child components ──────────────────────────────────────────────────────────

jest.mock("@/components/AddPartForm",       () => ({ AddPartForm:       () => null }));
jest.mock("@/components/BarcodeAddPart",    () => ({ BarcodeAddPart:    () => null }));
jest.mock("@/components/BinEditor",         () => ({ BinEditor:         () => null }));
jest.mock("@/components/BulkShelfAssign",   () => ({ BulkShelfAssign:   () => null }));
jest.mock("@/components/CatalogPdfUpload",  () => ({ CatalogPdfUpload:  () => null }));
jest.mock("@/components/KeyboardDoneInput", () => ({ KeyboardDoneInput: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children) }));
jest.mock("@/components/MeasurePartScreen", () => ({ MeasurePartScreen: () => null }));
jest.mock("@/components/ReferenceModal",    () => ({ ReferenceModal:    () => null }));
jest.mock("@/components/ShelfCatalogEntry", () => ({ ShelfCatalogEntry: () => null }));
jest.mock("@/components/UserAdminButtonRow",() => ({ UserAdminButtonRow: () => null }));

// ── AppContext — mapped by jest.config.js to __mocks__/contexts/AppContext.js ──

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
    textFontScale: 1.0,
    pinnedParts: [],
    pendingLidarDims: null,
    setPendingLidarDims: jest.fn(),
    approvalStatus: "approved" as const,
    ...overrides,
  };
}

// ── Render helpers ────────────────────────────────────────────────────────────

async function renderComponent(ui: React.ReactElement) {
  const result = await render(ui);
  await act(async () => { await Promise.resolve(); });
  return result;
}

const flushPromises = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
});

// ── Instance-tree helpers ─────────────────────────────────────────────────────

type Inst = TestInstance;

function instText(node: Inst | string): string {
  if (typeof node === "string") return node;
  return (node.children ?? []).map((c: Inst | string) => instText(c as Inst | string)).join("");
}

function hasText(root: Inst, text: string): boolean {
  return instText(root).includes(text);
}

function findPressable(root: Inst, label: string): Inst | null {
  return (
    root.queryAll((n: TestInstance) => (n.type as string) === "rn-pressable", { includeSelf: true })
        .find((n: Inst) => instText(n).includes(label)) ?? null
  );
}

// ── Per-test teardown ─────────────────────────────────────────────────────────

let activeTree: Awaited<ReturnType<typeof render>> | null = null;

afterEach(async () => {
  if (activeTree) {
    await act(async () => { activeTree!.unmount(); });
    activeTree = null;
  }
  mockRouterPush.mockClear();
  jest.clearAllMocks();
});

// ── Component under test ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const UploadScreen = (require("../app/(tabs)/upload") as { default: React.ComponentType }).default;

// ── Helper: render as admin and tap "People & System" to open the section ─────

async function renderAdminPeopleSection() {
  useApp.mockReturnValue(makeAppMock({ isAdmin: true, adminToken: "tok-abc" }));
  activeTree = await renderComponent(React.createElement(UploadScreen));
  const peopleCard = findPressable(activeTree!.root!!, "People & System");
  await act(async () => { fireEvent.press(peopleCard!); });
  await flushPromises();
  return activeTree;
}

// =============================================================================
// § 1 — Source inspection: nav row routes are correct in upload.tsx
// =============================================================================

describe("UploadScreen source — admin nav row routes", () => {
  let source: string;
  beforeAll(() => { source = fs.readFileSync(UPLOAD_PATH, "utf8"); });

  it("has a pressable that pushes /admin", () => {
    expect(source).toMatch(/router\.push\(["']\/admin["']\)/);
  });

  it("has a pressable that pushes /admin-inbox", () => {
    expect(source).toMatch(/router\.push\(["']\/admin-inbox["']\)/);
  });

  it("has a pressable that pushes /ai-log", () => {
    expect(source).toMatch(/router\.push\(["']\/ai-log["']\)/);
  });

  it("all three nav rows are inside the people section branch", () => {
    const peopleIdx = source.indexOf("People & System section");
    expect(peopleIdx).toBeGreaterThan(-1);
    const afterPeople = source.slice(peopleIdx);
    expect(afterPeople).toMatch(/router\.push\(["']\/admin["']\)/);
    expect(afterPeople).toMatch(/router\.push\(["']\/admin-inbox["']\)/);
    expect(afterPeople).toMatch(/router\.push\(["']\/ai-log["']\)/);
  });
});

// =============================================================================
// § 2 — Component mount: nav rows appear in the People section for admins
// =============================================================================

describe("UploadScreen — admin nav rows visible when isAdmin=true", () => {
  it("shows 'Admin Dashboard' row in the People section", async () => {
    const result = await renderAdminPeopleSection();
    expect(hasText(result.root!, "Admin Dashboard")).toBe(true);
  });

  it("shows 'Inbox' row in the People section", async () => {
    const result = await renderAdminPeopleSection();
    expect(hasText(result.root!, "Inbox")).toBe(true);
  });

  it("shows 'AI Log' row in the People section", async () => {
    const result = await renderAdminPeopleSection();
    expect(hasText(result.root!, "AI Log")).toBe(true);
  });

  it("all three rows are pressable (findPressable returns non-null)", async () => {
    const result = await renderAdminPeopleSection();
    expect(findPressable(result.root!, "Admin Dashboard")).not.toBeNull();
    expect(findPressable(result.root!, "Inbox")).not.toBeNull();
    expect(findPressable(result.root!, "AI Log")).not.toBeNull();
  });
});

// =============================================================================
// § 3 — Navigation: each row pushes the correct route
// =============================================================================

describe("UploadScreen — admin nav rows navigate to correct routes", () => {
  it("tapping 'Admin Dashboard' calls router.push('/admin')", async () => {
    const result = await renderAdminPeopleSection();
    const row = findPressable(result.root!, "Admin Dashboard");
    await act(async () => { fireEvent.press(row!); });
    expect(mockRouterPush).toHaveBeenCalledWith("/admin");
  });

  it("tapping 'Inbox' calls router.push('/admin-inbox')", async () => {
    const result = await renderAdminPeopleSection();
    const row = findPressable(result.root!, "Inbox");
    await act(async () => { fireEvent.press(row!); });
    expect(mockRouterPush).toHaveBeenCalledWith("/admin-inbox");
  });

  it("tapping 'AI Log' calls router.push('/ai-log')", async () => {
    const result = await renderAdminPeopleSection();
    const row = findPressable(result.root!, "AI Log");
    await act(async () => { fireEvent.press(row!); });
    expect(mockRouterPush).toHaveBeenCalledWith("/ai-log");
  });
});

// =============================================================================
// § 4 — Non-admin gate: lock screen is shown instead of nav rows
// =============================================================================

describe("UploadScreen — non-admin sees lock screen, not nav rows", () => {
  it("shows 'Admin Access Required' when isAdmin=false", async () => {
    useApp.mockReturnValue(makeAppMock({ isAdmin: false, adminToken: null }));
    activeTree = await renderComponent(React.createElement(UploadScreen));
    await flushPromises();
    expect(hasText(activeTree!.root!, "Admin Access Required")).toBe(true);
  });

  it("does NOT show the 'Admin Dashboard' nav row when isAdmin=false", async () => {
    useApp.mockReturnValue(makeAppMock({ isAdmin: false, adminToken: null }));
    activeTree = await renderComponent(React.createElement(UploadScreen));
    await flushPromises();
    expect(hasText(activeTree!.root!, "Admin Dashboard")).toBe(false);
  });

  it("does NOT show the 'Inbox' nav row when isAdmin=false", async () => {
    useApp.mockReturnValue(makeAppMock({ isAdmin: false, adminToken: null }));
    activeTree = await renderComponent(React.createElement(UploadScreen));
    await flushPromises();
    expect(hasText(activeTree!.root!, "Inbox")).toBe(false);
  });

  it("does NOT show the 'AI Log' nav row when isAdmin=false", async () => {
    useApp.mockReturnValue(makeAppMock({ isAdmin: false, adminToken: null }));
    activeTree = await renderComponent(React.createElement(UploadScreen));
    await flushPromises();
    expect(hasText(activeTree!.root!, "AI Log")).toBe(false);
  });
});
