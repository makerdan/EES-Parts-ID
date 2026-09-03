/**
 * Regression tests: cross-flow session warning banners in bulk shelf flows.
 *
 * BulkShelfAssign and BarcodeAddPart each maintain their own AsyncStorage
 * session key. When one flow opens while the other has an active session, a
 * non-blocking informational banner must appear so the admin knows to switch
 * back and continue the other flow before starting a new one.
 *
 * Cases covered (BulkShelfAssign):
 *   A) Both flows have active sessions → OWN resume banner AND cross-flow
 *      warning banner both appear simultaneously.
 *   B) Only BulkShelfAssign session exists → only own resume banner; no
 *      cross-flow warning.
 *   C) Only BarcodeAddPart session exists → only cross-flow warning; no
 *      resume banner.
 *   D) No sessions → neither banner appears.
 *   E) BarcodeAddPart key holds a malformed blob → cross-flow warning is
 *      suppressed (guard against false positives from stale / corrupt data).
 */

// Required for act() to work in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { render, act } from "@testing-library/react-native";
import type { RenderResult } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";

// ── Session key constants (mirror the component constants) ────────────────────

const BULK_KEY   = "parts_id_bulk_shelf_session_v1";
const BARCODE_KEY = "parts_id_shelf_session_v1";

// ── Valid session fixtures ────────────────────────────────────────────────────

const BULK_SESSION = JSON.stringify({
  shelfPrefix:   "16-37",
  shelfItems:    [{ id: 1, catalog: "ITEM-001", vendor: "ACME", binLocations: ["16-37"], barcodes: [] }],
  itemRowStates: {},
  targetItemId:  null,
});

const BARCODE_SESSION = JSON.stringify({
  shelfPrefix: "10-22",
  assignments: [],
  bulkQueue:   [],
  bulkMode:    false,
});

// ── AsyncStorage mock ─────────────────────────────────────────────────────────

const mockGetItem = jest.fn<Promise<string | null>, [string]>();

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem:    (...args: [string]) => mockGetItem(...args),
    setItem:    jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
  },
}));

// ── expo-camera ───────────────────────────────────────────────────────────────

const mockPermission = { granted: false, canAskAgain: true };
const mockRequestPermission = jest.fn();

jest.mock("expo-camera", () => ({
  CameraView:           () => null,
  useCameraPermissions: jest.fn(() => [mockPermission, mockRequestPermission]),
}));

// ── expo-haptics ──────────────────────────────────────────────────────────────

jest.mock("expo-haptics", () => ({
  impactAsync:       jest.fn().mockResolvedValue(undefined),
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Medium: "Medium" },
  NotificationFeedbackType: { Success: "Success" },
}));

// ── @tanstack/react-query ─────────────────────────────────────────────────────

jest.mock("@tanstack/react-query", () => ({
  useQueryClient: jest.fn(() => ({ invalidateQueries: jest.fn() })),
}));

// ── @workspace/api-client-react ───────────────────────────────────────────────

jest.mock("@workspace/api-client-react", () => ({
  useListInventory:     jest.fn(() => ({ data: null })),
  useUpdateItemBarcodes: jest.fn(() => ({ mutateAsync: jest.fn() })),
  listInventory:        jest.fn().mockResolvedValue({ items: [], total: 0 }),
}));

// ── @/hooks/useColors ─────────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background:        "#fff",
    foreground:        "#111",
    card:              "#f9f9f9",
    border:            "#ddd",
    primary:           "#007aff",
    primaryForeground: "#fff",
    muted:             "#f0f0f0",
    mutedForeground:   "#888",
    success:           "#10b981",
    successForeground: "#fff",
    destructive:       "#ef4444",
    warning:           "#f59e0b",
    warningForeground: "#fff",
    accent:            "#fef3c7",
    accentForeground:  "#92400e",
  }),
}));

// ── @/components/DismissKeyboard ──────────────────────────────────────────────

jest.mock("@/components/DismissKeyboard", () => ({
  DismissKeyboard: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

// ── @/components/KeyboardDoneInput ────────────────────────────────────────────

jest.mock("@/components/KeyboardDoneInput", () => ({
  KeyboardDoneInput: () => null,
}));

// ── @/utils/* ─────────────────────────────────────────────────────────────────

jest.mock("@/utils/barcodeResolver",    () => ({ resolveShelfAssign:          jest.fn() }));
jest.mock("@/utils/listEditorHandlers", () => ({
  invalidateListIfNew:       jest.fn().mockResolvedValue(undefined),
  undoBarcodeAndInvalidate:  jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/utils/offlineBarcode",     () => ({ upsertItemInBarcodeCache:    jest.fn().mockResolvedValue(undefined) }));
jest.mock("@/utils/storageErrorReporter", () => ({ reportStorageError: jest.fn() }));

// ── AppContext (moduleNameMapper → __mocks__/contexts/AppContext.js) ───────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useApp } = require("@/contexts/AppContext") as { useApp: jest.Mock };

// ── Subject under test ────────────────────────────────────────────────────────

import { BulkShelfAssign } from "../components/BulkShelfAssign";

// ── Helpers ───────────────────────────────────────────────────────────────────

type Inst = TestInstance;

function instText(node: Inst | string): string {
  if (typeof node === "string") return node;
  return (node.children ?? []).map((c: TestInstance | string) =>
    instText(c as Inst | string),
  ).join("");
}

function allTextStrings(root: Inst): string[] {
  const out: string[] = [];
  function walk(node: Inst | string) {
    if (typeof node === "string") { if (node.trim()) out.push(node.trim()); return; }
    if ((node.type as string) === "Text") { out.push(instText(node)); }
    (node.children ?? []).forEach((c: TestInstance | string) => walk(c as Inst | string));
  }
  walk(root);
  return out;
}

function hasText(root: Inst, substr: string): boolean {
  return allTextStrings(root).some(t => t.includes(substr));
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let tree: RenderResult | null = null;

beforeEach(() => {
  jest.clearAllMocks();
  useApp.mockReturnValue({
    isAdmin:   true,
    adminToken: "tok",
    settings:  { themeMode: "light" },
    showToast: jest.fn(),
  });
});

afterEach(async () => {
  if (tree) { await tree.unmount(); tree = null; }
});

async function renderModal(bulkRaw: string | null, barcodeRaw: string | null): Promise<Inst> {
  mockGetItem.mockImplementation((key: string) => {
    if (key === BULK_KEY)    return Promise.resolve(bulkRaw);
    if (key === BARCODE_KEY) return Promise.resolve(barcodeRaw);
    return Promise.resolve(null);
  });

  const onClose = jest.fn();
  await act(async () => {
    tree = await render(<BulkShelfAssign visible={true} onClose={onClose} />);
  });
  // Flush async storage reads
  await act(async () => {});

  return tree!.root as unknown as Inst;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("BulkShelfAssign — cross-flow session warnings", () => {

  it("A) shows BOTH own resume banner and cross-flow warning when both sessions are active", async () => {
    const root = await renderModal(BULK_SESSION, BARCODE_SESSION);

    // Own resume banner
    expect(hasText(root, "Resume session")).toBe(true);
    expect(hasText(root, "16-37")).toBe(true);

    // Cross-flow warning (must appear even alongside the resume banner)
    expect(hasText(root, "In-progress session in another flow")).toBe(true);
    expect(hasText(root, "Scan to Assign Barcode")).toBe(true);
  });

  it("B) shows only own resume banner when BulkShelfAssign session exists but BarcodeAddPart does not", async () => {
    const root = await renderModal(BULK_SESSION, null);

    expect(hasText(root, "Resume session")).toBe(true);
    expect(hasText(root, "In-progress session in another flow")).toBe(false);
  });

  it("C) shows only cross-flow warning when only BarcodeAddPart session exists", async () => {
    const root = await renderModal(null, BARCODE_SESSION);

    expect(hasText(root, "In-progress session in another flow")).toBe(true);
    expect(hasText(root, "Scan to Assign Barcode")).toBe(true);
    // No own resume banner
    expect(hasText(root, "Resume session")).toBe(false);
  });

  it("D) shows no session banners when neither session exists", async () => {
    const root = await renderModal(null, null);

    expect(hasText(root, "Resume session")).toBe(false);
    expect(hasText(root, "In-progress session in another flow")).toBe(false);
  });

  it("E) suppresses cross-flow warning for a malformed BarcodeAddPart blob", async () => {
    const root = await renderModal(null, '{"shelfPrefix":""}');

    expect(hasText(root, "In-progress session in another flow")).toBe(false);
  });

  it("E2) suppresses cross-flow warning for a completely invalid BarcodeAddPart blob", async () => {
    const root = await renderModal(null, '{"not":"valid","blob":true}');

    expect(hasText(root, "In-progress session in another flow")).toBe(false);
  });

  it("E3) suppresses cross-flow warning when assignments contain nested-malformed entries", async () => {
    // Outer shape is correct but assignment entries are missing required `item.id`
    const nestedMalformed = JSON.stringify({
      shelfPrefix: "10-22",
      assignments: [{ barcode: "ABC", item: { catalog: "PART-1" } }], // item.id missing
      bulkQueue:   [],
      bulkMode:    false,
    });
    const root = await renderModal(null, nestedMalformed);

    expect(hasText(root, "In-progress session in another flow")).toBe(false);
  });

  it("E4) suppresses cross-flow warning when bulkQueue entries have an invalid status", async () => {
    const nestedMalformed = JSON.stringify({
      shelfPrefix: "10-22",
      assignments: [],
      bulkQueue:   [{ barcode: "ABC", status: "unknown_status" }], // invalid status
      bulkMode:    false,
    });
    const root = await renderModal(null, nestedMalformed);

    expect(hasText(root, "In-progress session in another flow")).toBe(false);
  });
});
