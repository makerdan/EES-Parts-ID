/**
 * Regression test: tapping the "People & System" hub card with isAdmin=true
 * but adminToken=null must NOT crash, and must open the People section showing
 * a graceful empty state.
 *
 * ## What & Why
 *
 * `fetchUsers` in UploadScreen guards on `if (!adminToken) return` (line 1659).
 * When the People card is pressed (line 1934):
 *
 *   onPress={() => { setActiveSection("people"); fetchUsers(); }}
 *
 * the section transitions to "people" even though fetchUsers returns immediately
 * without calling fetchAdminUsers.  The rendered People section shows
 * "No users yet. Tap Refresh to load." (line 3279) — a graceful empty state,
 * not a crash or error message.
 *
 * ## Why we mount the real UploadScreen
 *
 * The previous approach (harness-based) mirrored the guard logic in isolation,
 * which lets the test pass even if the component's wiring changes (e.g. People
 * card stops calling fetchUsers, or the guard moves).  Mounting the real
 * component exercises the production code path end-to-end.
 *
 * ## Source inspection (§ 1)
 *
 * Source inspection locks the guard contract against the raw source text so any
 * structural refactor (e.g. extracting fetchUsers to a helper) is flagged before
 * the component test is even run.
 *
 * ## Component mount (§ 2–3)
 *
 * Uses @testing-library/react-native in a node environment (same pattern as
 * adminBridgeMeasureNow.test.tsx) with all external dependencies mocked.
 */

// Required for act() to work in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import * as fs from "fs";
import * as path from "path";
import React from "react";
import { Platform } from "react-native";
import { render, act, fireEvent } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";

// ── Source paths ──────────────────────────────────────────────────────────────

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

// ── expo-file-system (File + Paths, new streaming API) ───────────────────────
// The jest.config.js maps expo-file-system → __mocks__/expo-file-system.js
// which only has readAsStringAsync.  upload.tsx imports { File as FsFile,
// Paths as FsPaths } from the streaming API; override inline.

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
// Mocked so we can assert fetchAdminUsers is / is not called.

const mockFetchAdminUsers = jest.fn().mockResolvedValue(undefined);

jest.mock("@/utils/adminUserActions", () => ({
  fetchAdminUsers: (...args: unknown[]) => mockFetchAdminUsers(...args),
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

// ── @/utils/exportCsv ────────────────────────────────────────────────────────

jest.mock("@/utils/exportCsv", () => ({
  serializeInventoryToCsv: jest.fn().mockReturnValue(""),
}));

// ── @/styles/shared ───────────────────────────────────────────────────────────

jest.mock("@/styles/shared", () => ({ secondaryBtnBase: {} }));

// ── Child components (all return null to avoid their own deps) ────────────────

jest.mock("@/components/AddPartForm",      () => ({ AddPartForm:      () => null }));
jest.mock("@/components/BarcodeAddPart",   () => ({ BarcodeAddPart:   () => null }));
jest.mock("@/components/BinEditor",        () => ({ BinEditor:        () => null }));
jest.mock("@/components/BulkShelfAssign",  () => ({ BulkShelfAssign:  () => null }));
jest.mock("@/components/CatalogPdfUpload", () => ({ CatalogPdfUpload: () => null }));
jest.mock("@/components/KeyboardDoneInput", () => ({ KeyboardDoneInput: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children) }));
jest.mock("@/components/MeasurePartScreen", () => ({ MeasurePartScreen: () => null }));
jest.mock("@/components/ReferenceModal",   () => ({ ReferenceModal:   () => null }));
jest.mock("@/components/ShelfCatalogEntry", () => ({ ShelfCatalogEntry: () => null }));
jest.mock("@/components/UserAdminButtonRow", () => ({ UserAdminButtonRow: () => null }));

// ── AppContext — already mapped by jest.config.js to __mocks__/contexts/AppContext.js ──
// Grab the mock to configure return values per test.
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
  return (node.children ?? []).map((c: TestInstance | string) => instText(c as Inst | string)).join("");
}

function hasText(root: Inst | undefined | null, text: string): boolean {
  if (!root) return false;
  return instText(root).includes(text);
}

function findPressable(root: Inst | undefined | null, label: string): Inst | null {
  if (!root) return null;
  return (
    root.queryAll((n: TestInstance) => (n.type as string) === "rn-pressable", { includeSelf: true })
        .find(n => instText(n).includes(label)) ?? null
  );
}

function backupDialog(root: Inst | null): Inst | null {
  if (!root) return null;
  return root.queryAll((n: TestInstance) => (n.type as string) === "rn-modal" &&
    typeof n.props.onRequestClose === "function", { includeSelf: true })
    .find(n => instText(n).includes("Start Database Backup?")) ?? null;
}

function backupPosts(fetchMock: jest.Mock) {
  return fetchMock.mock.calls.filter(([url, init]) =>
    String(url).endsWith("/admin/snapshots") && (init as RequestInit | undefined)?.method === "POST");
}

// ── Per-test teardown ─────────────────────────────────────────────────────────

let activeTree: Awaited<ReturnType<typeof render>> | null = null;

afterEach(async () => {
  if (activeTree) {
    await activeTree.unmount();
    activeTree = null;
  }
  mockFetchAdminUsers.mockReset();
  mockFetchAdminUsers.mockResolvedValue(undefined);
  mockRouterPush.mockClear();
  jest.clearAllMocks();
});

// ── Component under test ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const UploadScreen = (require("../app/(tabs)/upload") as { default: React.ComponentType }).default;

// =============================================================================
// § 1 — Source inspection: guard contract in upload.tsx
//
// Locks the fact that fetchUsers has an !adminToken guard and that the People
// card wires it to onPress.  If someone removes or renames the guard, this
// test fails before the component mount even runs.
// =============================================================================

describe("UploadScreen source — fetchUsers guard contract", () => {
  let source: string;

  beforeAll(() => { source = fs.readFileSync(UPLOAD_PATH, "utf8"); });

  it("defines a fetchUsers closure that guards on !adminToken", () => {
    expect(source).toMatch(/const fetchUsers\s*=\s*async\s*\(\)/);
    expect(source).toMatch(/if\s*\(!adminToken\)\s*return/);
  });

  it("People card onPress calls both setActiveSection('people') and fetchUsers()", () => {
    expect(source).toMatch(/setActiveSection\(["']people["']\)/);
    expect(source).toMatch(/setActiveSection\(["']people["']\)[^;]*;\s*fetchUsers\(\)/s);
  });

  it("fetchAdminUsers is not called directly from the press handler — only via fetchUsers", () => {
    const pressHandlerMatch = source.match(/onPress=\{[^}]*setActiveSection\(["']people["']\)[^}]*\}/);
    expect(pressHandlerMatch).not.toBeNull();
    expect(pressHandlerMatch![0]).not.toContain("fetchAdminUsers");
  });
});

// =============================================================================
// § 2 — Component mount: People card tap with adminToken=null does not crash
// =============================================================================

describe("UploadScreen — People card tap with isAdmin=true, adminToken=null", () => {
  it("renders the hub home initially (hub cards are visible)", async () => {
    useApp.mockReturnValue(makeAppMock({ isAdmin: true, adminToken: null }));

    activeTree = await renderComponent(React.createElement(UploadScreen));

    expect(hasText(activeTree.root, "People & System")).toBe(true);
  });

  it("does NOT throw when the People card is tapped with adminToken=null", async () => {
    useApp.mockReturnValue(makeAppMock({ isAdmin: true, adminToken: null }));

    activeTree = await renderComponent(React.createElement(UploadScreen));

    const peopleCard = findPressable(activeTree.root, "People & System");
    expect(peopleCard).not.toBeNull();

    await act(async () => { fireEvent.press(peopleCard!); });

    await flushPromises();
  });

  it("fetchAdminUsers is NOT called when adminToken is null (guard fires)", async () => {
    useApp.mockReturnValue(makeAppMock({ isAdmin: true, adminToken: null }));

    activeTree = await renderComponent(React.createElement(UploadScreen));

    const peopleCard = findPressable(activeTree.root, "People & System");
    await act(async () => { fireEvent.press(peopleCard!); });
    await flushPromises();

    expect(mockFetchAdminUsers).not.toHaveBeenCalled();
  });

  it("transitions to the People section (header subtitle changes to 'People & System')", async () => {
    useApp.mockReturnValue(makeAppMock({ isAdmin: true, adminToken: null }));

    activeTree = await renderComponent(React.createElement(UploadScreen));

    const peopleCard = findPressable(activeTree.root, "People & System");
    await act(async () => { fireEvent.press(peopleCard!); });
    await flushPromises();

    // The hub section cards (Data Import, AI & Enrichment, Warehouse) are gone;
    // the People section content is now rendered.
    expect(hasText(activeTree.root, "User Management")).toBe(true);
  });

  it("shows a graceful empty state — 'No users yet. Tap Refresh to load.'", async () => {
    useApp.mockReturnValue(makeAppMock({ isAdmin: true, adminToken: null }));

    activeTree = await renderComponent(React.createElement(UploadScreen));

    const peopleCard = findPressable(activeTree.root, "People & System");
    await act(async () => { fireEvent.press(peopleCard!); });
    await flushPromises();

    expect(hasText(activeTree.root, "No users yet. Tap Refresh to load.")).toBe(true);
  });

  it("does NOT show an error message (no fetch was attempted)", async () => {
    useApp.mockReturnValue(makeAppMock({ isAdmin: true, adminToken: null }));

    activeTree = await renderComponent(React.createElement(UploadScreen));

    const peopleCard = findPressable(activeTree.root, "People & System");
    await act(async () => { fireEvent.press(peopleCard!); });
    await flushPromises();

    // usersError remains null because the guard prevented any fetch attempt
    expect(hasText(activeTree.root, "Failed to load")).toBe(false);
  });
});

// =============================================================================
// § 3 — Component mount: positive path — valid token triggers the fetch
//
// Regression guard: ensures the guard does NOT block a real token.
// =============================================================================

describe("UploadScreen — People card tap with valid adminToken (positive path)", () => {
  it("calls fetchAdminUsers when a non-null adminToken is present", async () => {
    useApp.mockReturnValue(makeAppMock({ isAdmin: true, adminToken: "valid-clerk-tok" }));

    activeTree = await renderComponent(React.createElement(UploadScreen));

    const peopleCard = findPressable(activeTree.root, "People & System");
    expect(peopleCard).not.toBeNull();

    await act(async () => { fireEvent.press(peopleCard!); });
    await flushPromises();

    expect(mockFetchAdminUsers).toHaveBeenCalledTimes(1);
    const deps = mockFetchAdminUsers.mock.calls[0][0] as { adminToken: string };
    expect(deps.adminToken).toBe("valid-clerk-tok");
  });
});

describe("UploadScreen — manual database backup", () => {
  let mockFetch: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => null,
    });
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each(["web", "ios"] as const)("shows the %s dialog before starting; cancel and dismiss send no POST", async platform => {
    const originalPlatform = Platform.OS;
    Platform.OS = platform;
    try {
    useApp.mockReturnValue(makeAppMock({ isAdmin: true, adminToken: "admin-token" }));

    activeTree = await renderComponent(React.createElement(UploadScreen));
    await act(async () => { fireEvent.press(findPressable(activeTree!.root, "People & System")!); });
    await flushPromises();
    await act(async () => { fireEvent.press(findPressable(activeTree!.root, "Start Database Backup")!); });
    expect(hasText(backupDialog(activeTree.root), "full inventory snapshot")).toBe(true);
    expect(hasText(backupDialog(activeTree.root), "server will continue")).toBe(true);
    expect(backupPosts(mockFetch)).toHaveLength(0);
    await act(async () => { fireEvent.press(findPressable(backupDialog(activeTree!.root), "Cancel")!); });
    expect(backupDialog(activeTree.root)).toBeNull();
    expect(backupPosts(mockFetch)).toHaveLength(0);

    await act(async () => { fireEvent.press(findPressable(activeTree!.root, "Start Database Backup")!); });
    await act(async () => { backupDialog(activeTree!.root)!.props.onRequestClose(); });
    expect(backupDialog(activeTree.root)).toBeNull();
    expect(backupPosts(mockFetch)).toHaveLength(0);

    await act(async () => { fireEvent.press(findPressable(activeTree!.root, "Start Database Backup")!); });
    const staleConfirm = findPressable(backupDialog(activeTree.root), "Start Backup")!.props.onPress;
    const back = activeTree.root!.queryAll((n: TestInstance) => n.props.accessibilityLabel === "Back to Admin Hub")[0];
    await act(async () => { fireEvent.press(back!); });
    await act(async () => { staleConfirm(); });
    expect(backupPosts(mockFetch)).toHaveLength(0);
    } finally {
      Platform.OS = originalPlatform;
    }
  });

  it("starts once after confirmation and displays the completed row count and local date", async () => {
    useApp.mockReturnValue(makeAppMock({ isAdmin: true, adminToken: "admin-token" }));
    let statusCalls = 0;
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/admin/snapshots") && init?.method === "POST") {
        return {
          ok: true,
          status: 202,
          json: async () => ({
            status: "running",
            persistence: "saved",
            startedAt: "2026-09-19T09:00:00.000Z",
            finishedAt: null,
            rowCount: null,
            snapshotId: null,
            error: null,
            warning: null,
          }),
        };
      }
      if (url.endsWith("/admin/snapshots/status")) {
        statusCalls += 1;
        const body = statusCalls === 1
          ? null
          : statusCalls === 2
            ? {
                status: "running",
                persistence: "saved",
                startedAt: "2026-09-19T09:00:00.000Z",
                finishedAt: null,
                rowCount: null,
                snapshotId: null,
                error: null,
                warning: null,
              }
            : {
                status: "completed",
                persistence: "saved",
                startedAt: "2026-09-19T09:00:00.000Z",
                finishedAt: "2026-09-19T09:42:00.000Z",
                rowCount: 1234,
                snapshotId: "snapshot-id",
                error: null,
                warning: null,
              };
        return {
          ok: true,
          status: 200,
          json: async () => body,
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
    activeTree = await renderComponent(React.createElement(UploadScreen));
    await act(async () => { fireEvent.press(findPressable(activeTree!.root, "People & System")!); });
    await flushPromises();
    await act(async () => { fireEvent.press(findPressable(activeTree!.root, "Start Database Backup")!); });
    expect(backupPosts(mockFetch)).toHaveLength(0);
    const confirm = findPressable(backupDialog(activeTree.root), "Start Backup")!;
    await act(async () => {
      fireEvent.press(confirm);
      fireEvent.press(confirm);
    });
    await flushPromises();

    expect(backupPosts(mockFetch)).toHaveLength(1);
    expect(backupPosts(mockFetch)[0][1]).toMatchObject({ headers: { Authorization: "Bearer admin-token" } });
    expect(hasText(activeTree.root, "Backup in progress")).toBe(true);
    expect(findPressable(activeTree.root, "Backup Running")?.props.disabled).toBe(true);

    await act(async () => {
      jest.advanceTimersByTime(2000);
      await Promise.resolve();
    });
    await act(async () => {
      jest.advanceTimersByTime(2000);
      await Promise.resolve();
    });
    expect(hasText(activeTree.root, "1,234 rows backed up")).toBe(true);
    expect(hasText(activeTree.root, "Completed September 19, 2026 at ")).toBe(true);
    expect(instText(activeTree!.root!)).toMatch(/Completed September 19, 2026 at \d{1,2}:42 (AM|PM)/);
  });

  it("times out a stalled status read, keeps the backup running, and recovers on the next poll", async () => {
    useApp.mockReturnValue(makeAppMock({ isAdmin: true, adminToken: "admin-token" }));
    const running = {
      status: "running",
      persistence: "saved",
      startedAt: "2026-09-19T09:00:00.000Z",
      finishedAt: null,
      rowCount: null,
      snapshotId: null,
      error: null,
      warning: null,
    };
    let statusCalls = 0;
    let stalledSignal: AbortSignal | undefined;
    let resolveStalled!: (response: unknown) => void;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/admin/snapshots") && init?.method === "POST") {
        return Promise.resolve({ ok: true, status: 202, json: async () => running });
      }
      if (url.endsWith("/admin/snapshots/status")) {
        statusCalls += 1;
        if (statusCalls === 2) {
          stalledSignal = init?.signal as AbortSignal;
          // Deliberately ignores abort to prove the timeout releases the poll slot.
          return new Promise(resolve => { resolveStalled = resolve; });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => statusCalls === 1 ? null : running,
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    });

    activeTree = await renderComponent(React.createElement(UploadScreen));
    await act(async () => { fireEvent.press(findPressable(activeTree!.root, "People & System")!); });
    await flushPromises();
    await act(async () => { fireEvent.press(findPressable(activeTree!.root, "Start Database Backup")!); });
    await act(async () => { fireEvent.press(findPressable(backupDialog(activeTree!.root), "Start Backup")!); });
    await flushPromises();
    expect(statusCalls).toBe(2);
    expect(hasText(activeTree.root, "Backup in progress")).toBe(true);

    await act(async () => {
      jest.advanceTimersByTime(10000);
      await Promise.resolve();
    });
    expect(stalledSignal?.aborted).toBe(true);
    expect(hasText(activeTree.root, "Database backup status timed out. Retrying automatically; the backup may still be running.")).toBe(true);
    expect(hasText(activeTree.root, "Backup in progress")).toBe(true);
    expect(hasText(activeTree.root, "Backup failed")).toBe(false);
    expect(backupPosts(mockFetch)).toHaveLength(1);

    await act(async () => {
      jest.advanceTimersByTime(2000);
      await Promise.resolve();
    });
    expect(statusCalls).toBe(3);
    expect(hasText(activeTree.root, "Database backup status timed out")).toBe(false);
    expect(hasText(activeTree.root, "Backup in progress")).toBe(true);

    await act(async () => {
      resolveStalled({ ok: true, status: 200, json: async () => ({ ...running, status: "failed" }) });
      await Promise.resolve();
    });
    expect(hasText(activeTree.root, "Backup failed")).toBe(false);
    expect(hasText(activeTree.root, "Backup in progress")).toBe(true);
  });

  it("shows the safe status-saving warning when the backup result is not durable", async () => {
    useApp.mockReturnValue(makeAppMock({ isAdmin: true, adminToken: "admin-token" }));
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/admin/snapshots") && init?.method === "POST") {
        return {
          ok: true,
          status: 202,
          json: async () => ({
            status: "completed",
            persistence: "unavailable",
            startedAt: "2026-09-19T09:00:00.000Z",
            finishedAt: "2026-09-19T09:42:00.000Z",
            rowCount: 1234,
            snapshotId: "snapshot-id",
            error: null,
            warning: "Backup status could not be saved. The result may not survive an API server restart.",
          }),
        };
      }
      return { ok: true, status: 200, json: async () => null };
    });
    activeTree = await renderComponent(React.createElement(UploadScreen));
    await act(async () => { fireEvent.press(findPressable(activeTree!.root, "People & System")!); });
    await flushPromises();
    await act(async () => { fireEvent.press(findPressable(activeTree!.root, "Start Database Backup")!); });
    await act(async () => { fireEvent.press(findPressable(backupDialog(activeTree!.root), "Start Backup")!); });
    await flushPromises();

    expect(hasText(activeTree.root, "Status saving unavailable")).toBe(true);
    expect(hasText(activeTree.root, "The result may not survive an API server restart.")).toBe(true);
  });

  it("keeps the button busy during acceptance and shows a failed start as retryable", async () => {
    useApp.mockReturnValue(makeAppMock({ isAdmin: true, adminToken: "admin-token" }));
    let resolveStart!: (response: unknown) => void;
    mockFetch.mockImplementation((url: string, init?: RequestInit) =>
      url.endsWith("/admin/snapshots") && init?.method === "POST"
        ? new Promise(resolve => { resolveStart = resolve; })
        : Promise.resolve({ ok: true, status: 200, json: async () => null }));
    activeTree = await renderComponent(React.createElement(UploadScreen));
    await act(async () => { fireEvent.press(findPressable(activeTree!.root, "People & System")!); });
    await flushPromises();
    await act(async () => { fireEvent.press(findPressable(activeTree!.root, "Start Database Backup")!); });
    const confirm = findPressable(backupDialog(activeTree.root), "Start Backup")!;
    await act(async () => { fireEvent.press(confirm); fireEvent.press(confirm); });
    expect(backupPosts(mockFetch)).toHaveLength(1);
    const busyButton = activeTree.root!.queryAll((n: TestInstance) => n.props.accessibilityLabel === "Start database backup")[0];
    expect(busyButton!.props.accessibilityState).toMatchObject({
      disabled: true, busy: true,
    });
    await act(async () => { resolveStart({ ok: false, status: 500, json: async () => ({}) }); });
    await flushPromises();
    expect(hasText(activeTree.root, "Could not start the database backup. Please try again.")).toBe(true);
    expect(hasText(activeTree.root, "Backup in progress")).toBe(false);
    expect(findPressable(activeTree.root, "Start Database Backup")?.props.disabled).toBe(false);
  });
});
