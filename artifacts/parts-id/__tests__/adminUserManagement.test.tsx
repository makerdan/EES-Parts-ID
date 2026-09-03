/**
 * Rendered People-section regression coverage.
 *
 * Unlike the adminUserActions unit suite, this mounts the real UploadScreen,
 * UserAdminButtonRow, and adminUserActions utility together. The mocked fetch
 * endpoint keeps a deterministic server-side user list so a mutation can be
 * followed by the screen's real refresh request.
 */

// Required for React 19 act() in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";

import type { UserRow } from "../utils/adminUserActions";

// ── expo-router ───────────────────────────────────────────────────────────────

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), navigate: jest.fn() }),
  useFocusEffect: jest.fn(),
}));

// ── Async storage ─────────────────────────────────────────────────────────────

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn().mockResolvedValue(null),
  setItem: jest.fn().mockResolvedValue(undefined),
  removeItem: jest.fn().mockResolvedValue(undefined),
  multiRemove: jest.fn().mockResolvedValue(undefined),
}));

// ── API client ────────────────────────────────────────────────────────────────

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

// ── Upload-only dependencies ───────────────────────────────────────────────────

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
    triggerRestart: jest.fn().mockResolvedValue(undefined),
    checkStatus: jest.fn().mockResolvedValue(undefined),
    bots: {},
    probeSingleBot: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());
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
  toggleSkipAll: jest.fn(() => []),
  toggleSkipRow: jest.fn(() => []),
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
  KeyboardDoneInput: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));
jest.mock("@/components/MeasurePartScreen", () => ({ MeasurePartScreen: () => null }));
jest.mock("@/components/ReferenceModal", () => ({ ReferenceModal: () => null }));
jest.mock("@/components/ShelfCatalogEntry", () => ({ ShelfCatalogEntry: () => null }));
// Intentionally do not mock UserAdminButtonRow: its real role/status gate is
// part of the rendered-screen contract under test.

// ── Context mocks ──────────────────────────────────────────────────────────────

// jest.config maps this module to the shared mock, which exposes useApp as a
// jest.fn so each test can provide a tracked admin context.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useApp } = require("@/contexts/AppContext") as { useApp: jest.Mock };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useAuth } = require("@clerk/expo") as { useAuth: jest.Mock };

const SELF_ID = "clerk-self-admin";
const ADMIN_TOKEN = "clerk-session-token";

function makeAppMock(showToast: jest.Mock) {
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
    showToast,
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

// ── Deterministic API state ───────────────────────────────────────────────────

const initialUsers: Array<UserRow> = [
  {
    clerkUserId: SELF_ID,
    email: "admin@example.com",
    status: "approved",
    role: "admin",
    createdAt: "2024-01-01T00:00:00.000Z",
  },
  {
    clerkUserId: "clerk-pending",
    email: "pending@example.com",
    status: "pending",
    role: "user",
    createdAt: "2024-01-02T00:00:00.000Z",
  },
  {
    clerkUserId: "clerk-banned",
    email: "banned@example.com",
    status: "banned",
    role: "user",
    createdAt: "2024-01-03T00:00:00.000Z",
  },
  {
    clerkUserId: "clerk-approved",
    email: "member@example.com",
    status: "approved",
    role: "user",
    createdAt: "2024-01-04T00:00:00.000Z",
  },
];

let serverUsers: Array<UserRow> = [];
let rejectedAction: { userId: string; action: string } | null = null;
let partialDeleteUserId: string | null = null;

function cloneUsers(users: Array<UserRow>): Array<UserRow> {
  return users.map((user) => ({ ...user }));
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => "",
  } as unknown as Response;
}

const mockFetch = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
  async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url.endsWith("/admin/users") && method === "GET") {
      return response({ users: cloneUsers(serverUsers) });
    }

    const actionMatch = url.match(/\/admin\/users\/([^/]+)\/(approve|ban|promote|demote)$/);
    if (actionMatch && method === "POST") {
      const [, userId, action] = actionMatch;
      if (
        rejectedAction &&
        rejectedAction.userId === userId &&
        rejectedAction.action === action
      ) {
        return response({ error: "Action is not allowed" }, 403);
      }

      const user = serverUsers.find((candidate) => candidate.clerkUserId === userId);
      if (!user) return response({ error: "User not found" }, 404);
      if (action === "approve") user.status = "approved";
      if (action === "ban") user.status = "banned";
      if (action === "promote") user.role = "admin";
      if (action === "demote") user.role = "user";
      return response({ user: { ...user } });
    }

    const deleteMatch = url.match(/\/admin\/users\/([^/]+)$/);
    if (deleteMatch && method === "DELETE") {
      const userId = deleteMatch[1]!;
      const index = serverUsers.findIndex((user) => user.clerkUserId === userId);
      if (index < 0) return response({ error: "User not found" }, 404);
      serverUsers.splice(index, 1);
      return response({
        deleted: true,
        clerkDeleted: partialDeleteUserId === userId ? false : true,
        ...(partialDeleteUserId === userId ? { clerkError: "Clerk API unavailable" } : {}),
      });
    }

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

    return response({});
  },
);

// ── Render and tree helpers ───────────────────────────────────────────────────

type Inst = TestInstance;

function instText(node: Inst | string): string {
  if (typeof node === "string") return node;
  return (node.children ?? [])
    .map((child: Inst | string) => instText(child as Inst | string))
    .join("");
}

function findPressable(root: Inst | null, text: string): Inst | null {
  if (!root) return null;
  return (
    root
      .queryAll(
        (node: TestInstance) =>
          (node.type as string) === "rn-pressable" && instText(node).includes(text),
        { includeSelf: true },
      )
      .find(Boolean) ?? null
  );
}

function findUserCard(root: Inst | null, email: string): Inst {
  if (!root) throw new Error(`Could not find user card for ${email}: tree root is null`);
  const card = root
    .queryAll(
      (node: TestInstance) =>
        (node.type as string) === "rn-view" &&
        instText(node).includes(email) &&
        instText(node).includes("ID:"),
      { includeSelf: true },
    )
    .sort((left, right) => instText(left).length - instText(right).length)[0];
  if (!card) throw new Error(`Could not find user card for ${email}`);
  return card;
}

const flushPromises = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });

let activeTree: Awaited<ReturnType<typeof render>> | null = null;

async function renderPeopleSection() {
  const showToast = jest.fn();
  useApp.mockReturnValue(makeAppMock(showToast));
  useAuth.mockReturnValue({
    isSignedIn: true,
    userId: SELF_ID,
    getToken: jest.fn().mockResolvedValue(ADMIN_TOKEN),
    signOut: jest.fn().mockResolvedValue(undefined),
  });

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const UploadScreen = (require("../app/(tabs)/upload") as {
    default: React.ComponentType;
  }).default;

  activeTree = await render(React.createElement(UploadScreen));
  const peopleCard = findPressable(activeTree.root!, "People & System");
  if (!peopleCard) throw new Error("People & System hub card was not rendered");

  await act(async () => {
    fireEvent.press(peopleCard);
  });
  await flushPromises();

  return { tree: activeTree!, showToast };
}

beforeEach(() => {
  serverUsers = cloneUsers(initialUsers);
  rejectedAction = null;
  partialDeleteUserId = null;
  mockFetch.mockClear();
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(async () => {
  if (activeTree) {
    await activeTree.unmount();
    activeTree = null;
  }
  jest.clearAllMocks();
});

// =============================================================================
// Complete rendered mutation path
// =============================================================================

describe("UploadScreen People section — approve and refresh", () => {
  it("loads users, authorizes approve, refreshes the list, and shows the new status", async () => {
    const { tree, showToast } = await renderPeopleSection();
    const pendingCard = findUserCard(tree.root, "pending@example.com");
    const approveButton = findPressable(pendingCard, "✓ Approve");

    expect(approveButton).not.toBeNull();
    expect(findPressable(pendingCard, "↑ Make Admin")).toBeNull();

    await act(async () => {
      fireEvent.press(approveButton!);
    });
    await flushPromises();

    const userRequests = mockFetch.mock.calls.filter(([input]) =>
      String(input).endsWith("/admin/users"),
    );
    const actionCall = mockFetch.mock.calls.find(([input]) =>
      String(input).endsWith("/admin/users/clerk-pending/approve"),
    );
    expect(userRequests).toHaveLength(2);
    expect(actionCall).toBeDefined();
    expect(actionCall?.[1]?.method).toBe("POST");
    expect((actionCall?.[1]?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${ADMIN_TOKEN}`,
    );
    expect(
      (userRequests[0]?.[1]?.headers as Record<string, string>).Authorization,
    ).toBe(`Bearer ${ADMIN_TOKEN}`);
    expect(showToast).not.toHaveBeenCalled();

    const refreshedCard = findUserCard(tree.root, "pending@example.com");
    expect(instText(refreshedCard)).toContain("approved");
    expect(findPressable(refreshedCard, "✓ Approve")).toBeNull();
    expect(findPressable(refreshedCard, "↑ Make Admin")).not.toBeNull();
  });
});

// =============================================================================
// Error, confirmation, and partial Clerk-delete contracts
// =============================================================================

describe("UploadScreen People section — rejected and delete actions", () => {
  it("shows a mutation error and leaves the rendered status unchanged", async () => {
    rejectedAction = { userId: "clerk-approved", action: "ban" };
    const { tree, showToast } = await renderPeopleSection();
    const memberCard = findUserCard(tree.root, "member@example.com");
    const banButton = findPressable(memberCard, "✕ Ban");

    expect(banButton).not.toBeNull();
    await act(async () => {
      fireEvent.press(banButton!);
    });
    await flushPromises();

    expect(showToast).toHaveBeenCalledWith("HTTP 403", "error");
    expect(mockFetch.mock.calls.filter(([input]) =>
      String(input).endsWith("/admin/users"),
    )).toHaveLength(1);
    expect(instText(findUserCard(tree.root, "member@example.com"))).toContain("approved");
  });

  it("confirms deletion, sends auth, removes the row, and surfaces partial Clerk failure", async () => {
    partialDeleteUserId = "clerk-approved";
    const { tree } = await renderPeopleSection();
    const memberCard = findUserCard(tree.root, "member@example.com");
    const deleteButton = findPressable(memberCard, "🗑 Delete");
    expect(deleteButton).not.toBeNull();

    const { Alert } = require("react-native") as {
      Alert: { alert: jest.Mock };
    };
    await act(async () => {
      fireEvent.press(deleteButton!);
    });

    expect(Alert.alert).toHaveBeenCalledWith(
      "Delete User",
      expect.stringContaining("member@example.com"),
      expect.any(Array),
    );
    const confirmationButtons = Alert.alert.mock.calls[0][2] as Array<{
      text: string;
      onPress?: () => void;
    }>;
    const confirmDelete = confirmationButtons.find((button) => button.text === "Delete");
    expect(confirmDelete?.onPress).toBeDefined();

    await act(async () => {
      confirmDelete!.onPress!();
    });
    await flushPromises();

    const deleteCall = mockFetch.mock.calls.find(([input]) =>
      String(input).endsWith("/admin/users/clerk-approved"),
    );
    expect(deleteCall?.[1]?.method).toBe("DELETE");
    expect((deleteCall?.[1]?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${ADMIN_TOKEN}`,
    );
    expect(findPressable(tree.root, "member@example.com")).toBeNull();
    expect(Alert.alert).toHaveBeenLastCalledWith(
      "Partial Deletion",
      expect.stringContaining("Clerk API unavailable"),
    );
  });
});

// =============================================================================
// Self-action and status-gated controls
// =============================================================================

describe("UploadScreen People section — prohibited actions", () => {
  it("does not render self-action controls or invalid-state mutations", async () => {
    const { tree } = await renderPeopleSection();
    const selfCard = findUserCard(tree.root, "admin@example.com");
    const pendingCard = findUserCard(tree.root, "pending@example.com");
    const bannedCard = findUserCard(tree.root, "banned@example.com");

    expect(instText(selfCard)).toContain("Cannot act on your own account");
    expect(selfCard.queryAll(
      (node: TestInstance) => (node.type as string) === "rn-pressable",
      { includeSelf: true },
    )).toHaveLength(0);

    expect(findPressable(pendingCard, "↑ Make Admin")).toBeNull();
    expect(findPressable(bannedCard, "✕ Ban")).toBeNull();
    expect(findPressable(bannedCard, "↑ Make Admin")).toBeNull();
    expect(mockFetch.mock.calls.filter(([input]) =>
      String(input).includes("/admin/users/"),
    )).toHaveLength(0);
  });
});