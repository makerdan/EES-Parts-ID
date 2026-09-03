/**
 * @jest-environment node
 *
 * Rendered regression coverage for the admin AI Status workflow.
 *
 * This mounts the real UploadScreen inside the real ApiHealthProvider. The
 * screen's AI Status card owns the authenticated GET/full-probe requests, and
 * the shared API-health hook owns the authenticated single-bot request.
 */

// Required for act() to work in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { render, act, fireEvent } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";

// ── expo-router ────────────────────────────────────────────────────────────────
// useApiStatus waits for the screen to be focused before it requests /healthz.
// Capture that callback so this rendered test can enter the focused state without
// replacing the production health provider or hook.
let capturedFocusCallback: (() => (() => void) | void) | null = null;

const mockRouterPush = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockRouterPush, replace: jest.fn(), navigate: jest.fn() }),
  useFocusEffect: (callback: () => (() => void) | void) => {
    capturedFocusCallback = callback;
  },
}));

// ── App/API mocks ──────────────────────────────────────────────────────────────
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

jest.mock("@/contexts/ApiHealthContext", () =>
  jest.requireActual("../contexts/ApiHealthContext"),
);

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn().mockResolvedValue(null),
  setItem: jest.fn().mockResolvedValue(undefined),
  removeItem: jest.fn().mockResolvedValue(undefined),
  multiRemove: jest.fn().mockResolvedValue(undefined),
}));

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

jest.mock("@/hooks/useColors", () =>
  require("./helpers/mapMocks").createUseColorsMock(),
);

jest.mock("@/utils/apiBase", () => ({
  API_BASE: "http://localhost:3001/api",
}));

jest.mock("@/utils/useTrackScreen", () => ({
  useTrackScreen: jest.fn(),
}));

jest.mock("@/utils/adminUserActions", () => ({
  deleteAdminUser: jest.fn().mockResolvedValue(undefined),
  fetchAdminUsers: jest.fn().mockResolvedValue(undefined),
  handleUserAction: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/utils/expandDescHandlers", () => ({
  applyDiscardAll: jest.fn(),
  runSaveAll: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/utils/binSkipLogic", () => ({
  activeReplacementCount: jest.fn().mockReturnValue(0),
  preservedBinCount: jest.fn().mockReturnValue(0),
  serializeToCsv: jest.fn().mockReturnValue(""),
  toggleSkipAll: jest.fn((_rows: unknown, _value: unknown) => []),
  toggleSkipRow: jest.fn((_rows: unknown, _index: unknown) => []),
}));

jest.mock("@/utils/exportCsv", () => ({
  serializeInventoryToCsv: jest.fn().mockReturnValue(""),
}));

jest.mock("@/styles/shared", () => ({
  secondaryBtnBase: {},
}));

// Child workflows are outside this test's boundary. Keeping them mounted as
// null components still leaves UploadScreen itself and its status controls real.
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

// The jest config maps AppContext to this mock. The returned value is replaced
// per test so the rendered screen always has an admin token.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useApp } = require("@/contexts/AppContext") as { useApp: jest.Mock };

// ── Fetch fixtures ─────────────────────────────────────────────────────────────
const API_BASE = "http://localhost:3001/api";
const ADMIN_TOKEN = "rendered-ai-status-admin-token";
const FIRST_BOT = "Gemini-3.1-Pro";
const SECOND_BOT = "GPT-5";

type FetchCall = {
  url: string;
  init: RequestInit | undefined;
};

const mockFetch = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
const fetchCalls: FetchCall[] = [];
let statusResponses: Response[];
let fullProbeResponses: Array<Response | Promise<Response>>;
let singleProbeResponses: Response[];

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

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
    adminToken: ADMIN_TOKEN,
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

function responseFor(url: string): Response | Promise<Response> {
  if (url === `${API_BASE}/healthz`) {
    return jsonResponse({
      status: "ok",
      bots: { [FIRST_BOT]: "ok" },
    });
  }
  if (url === `${API_BASE}/admin/ai-status`) {
    return statusResponses.shift() ?? jsonResponse({ bots: {} });
  }
  if (url === `${API_BASE}/admin/ai-status/probe`) {
    return fullProbeResponses.shift() ?? jsonResponse({ bots: {} });
  }
  if (url.startsWith(`${API_BASE}/admin/ai-status/probe/`)) {
    return singleProbeResponses.shift() ?? jsonResponse({ bots: {} });
  }
  if (url === `${API_BASE}/inventory/enrich-summary`) {
    return jsonResponse({ total: 0, enriched: 0, unenriched: 0 });
  }
  if (url.includes("/inventory/bulk-enrich/status")) {
    return jsonResponse({
      job: {
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
      },
    });
  }
  if (url.includes("/inventory/enrich-measurements/status")) {
    return jsonResponse({
      job: {
        running: false,
        startedAt: null,
        processed: 0,
        updated: 0,
        total: null,
        finishedAt: null,
        lastError: null,
      },
    });
  }
  return jsonResponse({ bots: {} });
}

// ── Imports after mocks ────────────────────────────────────────────────────────
import { ApiHealthProvider } from "../contexts/ApiHealthContext";
import UploadScreen from "../app/(tabs)/upload";

// ── Render helpers ──────────────────────────────────────────────────────────────
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
        (node: Inst) =>
          (node.type as string) === "rn-pressable" && instText(node).includes(label),
        { includeSelf: true },
      )
      .find(Boolean) ?? null
  );
}

function findPressableByAccessibilityLabel(root: Inst, label: string): Inst | null {
  return (
    root
      .queryAll(
        (node: Inst) =>
          (node.type as string) === "rn-pressable" &&
          node.props.accessibilityLabel === label,
        { includeSelf: true },
      )
      .find(Boolean) ?? null
  );
}

const flushPromises = () =>
  act(async () => {
    for (let index = 0; index < 8; index++) await Promise.resolve();
  });

async function renderAdminUpload() {
  useApp.mockReturnValue(makeAppMock());
  const tree = await render(
    <ApiHealthProvider>
      <UploadScreen />
    </ApiHealthProvider>,
  );

  // The real health hook now starts its focused polling lifecycle.
  const blur = capturedFocusCallback?.();
  await flushPromises();
  return { tree, blur };
}

function callsFor(path: string): FetchCall[] {
  return fetchCalls.filter((call) => call.url === `${API_BASE}${path}`);
}

// ── Setup / teardown ───────────────────────────────────────────────────────────
beforeEach(() => {
  capturedFocusCallback = null;
  fetchCalls.length = 0;
  statusResponses = [
    jsonResponse({
      bots: {
        [FIRST_BOT]: "ok",
        [SECOND_BOT]: "timeout",
      },
    }),
  ];
  fullProbeResponses = [];
  singleProbeResponses = [];
  mockFetch.mockReset();
  mockFetch.mockImplementation((input, init) => {
    const call = { url: String(input), init };
    fetchCalls.push(call);
    return Promise.resolve(responseFor(call.url));
  });
  global.fetch = mockFetch as unknown as typeof fetch;
});

let activeTree: Awaited<ReturnType<typeof render>> | null = null;
let activeBlur: (() => void) | void;

afterEach(async () => {
  activeBlur?.();
  activeBlur = undefined;
  if (activeTree) {
    await activeTree.unmount();
    activeTree = null;
  }
  jest.clearAllMocks();
});

// =============================================================================
// The complete rendered workflow
// =============================================================================
describe("UploadScreen — rendered admin AI Status workflow", () => {
  it("loads the initial status with GET and renders each returned bot result", async () => {
    const rendered = await renderAdminUpload();
    activeTree = rendered.tree;
    activeBlur = rendered.blur;

    const enrichmentCard = findPressable(rendered.tree.root!, "AI & Enrichment");
    expect(enrichmentCard).not.toBeNull();
    await act(async () => { fireEvent.press(enrichmentCard!); });
    await flushPromises();

    const aiCard = findPressable(rendered.tree.root!, "Re-run probe");
    expect(aiCard).not.toBeNull();
    expect(instText(rendered.tree.root!)).toContain(FIRST_BOT);
    expect(instText(rendered.tree.root!)).toContain(SECOND_BOT);
    expect(instText(rendered.tree.root!)).toContain("timeout");

    const initialCalls = callsFor("/admin/ai-status");
    expect(initialCalls).toHaveLength(1);
    expect(initialCalls[0]?.init?.method).toBeUndefined();
    expect((initialCalls[0]?.init?.headers as Record<string, string>)?.Authorization)
      .toBe(`Bearer ${ADMIN_TOKEN}`);
  });

  it("enters AI & Enrichment, runs the full probe, and renders refreshed results", async () => {
    fullProbeResponses.push(
      jsonResponse({
        bots: {
          [FIRST_BOT]: "error",
          [SECOND_BOT]: "ok",
        },
      }),
    );

    const rendered = await renderAdminUpload();
    activeTree = rendered.tree;
    activeBlur = rendered.blur;

    const enrichmentCard = findPressable(rendered.tree.root!, "AI & Enrichment");
    expect(enrichmentCard).not.toBeNull();
    await act(async () => { fireEvent.press(enrichmentCard!); });
    await flushPromises();

    expect(instText(rendered.tree.root!)).toContain("AI Status");
    const probeButton = findPressable(rendered.tree.root!, "Re-run probe");
    expect(probeButton).not.toBeNull();

    await act(async () => { fireEvent.press(probeButton!); });
    await flushPromises();

    expect(instText(rendered.tree.root!)).toContain("error");
    expect(instText(rendered.tree.root!)).toContain("ok");
    expect(callsFor("/admin/ai-status/probe")).toHaveLength(1);
    const probeCall = callsFor("/admin/ai-status/probe")[0]!;
    expect(probeCall.init?.method).toBe("POST");
    expect(probeCall.init?.headers).toEqual({
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    });
  });

  it("uses the header bot control for a single-bot POST and renders its refreshed health result", async () => {
    singleProbeResponses.push(
      jsonResponse({
        bots: {
          [FIRST_BOT]: "ok",
          [SECOND_BOT]: "ok",
        },
      }),
    );

    const rendered = await renderAdminUpload();
    activeTree = rendered.tree;
    activeBlur = rendered.blur;

    const botChip = findPressableByAccessibilityLabel(
      rendered.tree.root!,
      `${FIRST_BOT}: ok. Tap to re-probe.`,
    );
    expect(botChip).not.toBeNull();

    await act(async () => { fireEvent.press(botChip!); });
    await flushPromises();

    const singleCalls = fetchCalls.filter((call) =>
      call.url === `${API_BASE}/admin/ai-status/probe/${encodeURIComponent(FIRST_BOT)}`,
    );
    expect(singleCalls).toHaveLength(1);
    expect(singleCalls[0]?.init?.method).toBe("POST");
    expect(singleCalls[0]?.init?.headers).toEqual({
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    });
    expect(
      findPressableByAccessibilityLabel(
        rendered.tree.root!,
        `${FIRST_BOT}: ok. Tap to re-probe.`,
      ),
    ).not.toBeNull();
  });

  it("shows a protected probe failure and preserves the last good bot results", async () => {
    let resolvePendingProbe!: (response: Response) => void;
    const pendingProbe = new Promise<Response>((resolve) => {
      resolvePendingProbe = resolve;
    });
    fullProbeResponses.push(
      pendingProbe,
      jsonResponse({ error: "AI provider unavailable" }, false, 503),
    );

    const rendered = await renderAdminUpload();
    activeTree = rendered.tree;
    activeBlur = rendered.blur;

    const enrichmentCard = findPressable(rendered.tree.root!, "AI & Enrichment");
    await act(async () => { fireEvent.press(enrichmentCard!); });
    await flushPromises();

    const probeButton = findPressable(rendered.tree.root!, "Re-run probe");
    expect(probeButton).not.toBeNull();
    const priorResults = instText(rendered.tree.root!);
    // Confirm the baseline before exercising the failing request. This keeps
    // the preservation assertion meaningful rather than allowing an empty
    // initial response to masquerade as preserved state.
    expect(priorResults).toContain("timeout");

    await act(async () => { fireEvent.press(probeButton!); });
    await flushPromises();

    // While the protected request is in flight, the last good data remains
    // rendered. A loading/error transition must not clear it preemptively.
    expect(instText(rendered.tree.root!)).toContain("timeout");

    resolvePendingProbe(jsonResponse({ error: "Unknown bot name" }, false, 400));
    await flushPromises();

    expect(instText(rendered.tree.root!)).toContain("HTTP 400");
    expect(instText(rendered.tree.root!)).toContain(FIRST_BOT);

    await act(async () => { fireEvent.press(probeButton!); });
    await flushPromises();

    expect(instText(rendered.tree.root!)).toContain("HTTP 503");
    expect(callsFor("/admin/ai-status/probe")).toHaveLength(2);
  });
});