/**
 * Regression tests: cross-flow session warning banner in BarcodeAddPart.
 *
 * When BarcodeAddPart mounts while BulkShelfAssign has an active session
 * (parts_id_bulk_shelf_session_v1), it must show a non-blocking informational
 * banner so the admin knows to switch to the Bulk Assign flow and continue.
 *
 * Cases covered:
 *   A) BulkShelfAssign session exists → cross-flow warning banner visible.
 *   B) No BulkShelfAssign session → no cross-flow warning.
 *   C) BulkShelfAssign key holds a malformed blob (missing shelfItems array)
 *      → warning is suppressed.
 *   D) BulkShelfAssign key holds nested-malformed data (itemRowStates is an
 *      array, not an object) → warning is suppressed.
 *   E) BarcodeAddPart also has its own resume session active → both own resume
 *      banner and cross-flow warning appear simultaneously.
 */

// Required for act() to work in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { render, act } from "@testing-library/react-native";
import type { RenderResult } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";

// ── Session key constants ─────────────────────────────────────────────────────

const BARCODE_KEY = "parts_id_shelf_session_v1";
const BULK_KEY    = "parts_id_bulk_shelf_session_v1";

// ── Valid session fixtures ────────────────────────────────────────────────────

/** A valid BulkShelfAssign session blob. */
const BULK_SESSION = JSON.stringify({
  shelfPrefix:   "16-37",
  shelfItems:    [{ id: 1, catalog: "ITEM-001", vendor: "ACME", binLocations: ["16-37"], barcodes: [] }],
  itemRowStates: {},
  targetItemId:  null,
});

/** A valid BarcodeAddPart own-session blob (for case E). */
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

// ── expo-camera — grant permission so the main render path is reached ─────────

const mockPermissionGranted = { granted: true, canAskAgain: true };
const mockRequestPermission  = jest.fn();

jest.mock("expo-camera", () => ({
  CameraView:           () => null,
  useCameraPermissions: jest.fn(() => [mockPermissionGranted, mockRequestPermission]),
}));

// ── expo-audio ────────────────────────────────────────────────────────────────

jest.mock("expo-audio", () => ({
  createAudioPlayer: jest.fn(() => ({
    volume:  0,
    seekTo:  jest.fn(),
    play:    jest.fn(),
  })),
}));

// ── expo-file-system/legacy ───────────────────────────────────────────────────

jest.mock("expo-file-system/legacy", () => ({
  readAsStringAsync: jest.fn().mockResolvedValue(""),
}));

// ── expo-haptics ──────────────────────────────────────────────────────────────

jest.mock("expo-haptics", () => ({
  notificationAsync:   jest.fn().mockResolvedValue(undefined),
  impactAsync:         jest.fn().mockResolvedValue(undefined),
  NotificationFeedbackType: { Success: "Success" },
  ImpactFeedbackStyle:      { Medium: "Medium" },
}));

// ── expo-router ───────────────────────────────────────────────────────────────

jest.mock("expo-router", () => ({
  useFocusEffect: jest.fn(),
  useRouter:      jest.fn(() => ({ push: jest.fn() })),
}));

// ── @tanstack/react-query ─────────────────────────────────────────────────────

jest.mock("@tanstack/react-query", () => ({
  useQueryClient: jest.fn(() => ({ invalidateQueries: jest.fn() })),
}));

// ── @workspace/api-client-react ───────────────────────────────────────────────

jest.mock("@workspace/api-client-react", () => ({
  useListInventory:     jest.fn(() => ({ data: null })),
  useUpdateItemBarcodes: jest.fn(() => ({ mutateAsync: jest.fn() })),
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

// ── @/components/* stubs ──────────────────────────────────────────────────────

jest.mock("@/components/CatalogPickerModal", () => ({
  CatalogPickerModal: () => null,
}));
jest.mock("@/components/KeyboardDoneInput", () => ({
  KeyboardDoneInput: () => null,
}));
jest.mock("@/components/PartDetailsEditor", () => ({
  PartDetailsEditor: () => null,
}));
jest.mock("@/components/PartPhotoPicker", () => ({
  PartPhotoPicker: () => null,
}));

// ── @/utils/* ─────────────────────────────────────────────────────────────────

jest.mock("@/utils/apiBase",         () => ({ API_BASE: "http://localhost:3001/api" }));
jest.mock("@/utils/barcodeResolver", () => ({ resolveShelfAssign: jest.fn() }));
jest.mock("@/utils/editItemCache",   () => ({ invalidateListCache: jest.fn().mockResolvedValue(undefined) }));
jest.mock("@/utils/offlineBarcode",  () => ({ upsertItemInBarcodeCache: jest.fn().mockResolvedValue(undefined) }));

// ── AppContext (moduleNameMapper → __mocks__/contexts/AppContext.js) ───────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useApp } = require("@/contexts/AppContext") as { useApp: jest.Mock };

// ── Subject under test ────────────────────────────────────────────────────────

import { BarcodeAddPart } from "../components/BarcodeAddPart";

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
    isAdmin:    true,
    adminToken: "tok",
    settings:   { themeMode: "light", scanSound: false },
    showToast:  jest.fn(),
  });
});

afterEach(async () => {
  if (tree) { await tree.unmount(); tree = null; }
});

async function renderComponent(
  bulkRaw: string | null,
  barcodeOwnRaw: string | null = null,
): Promise<Inst> {
  mockGetItem.mockImplementation((key: string) => {
    if (key === BULK_KEY)    return Promise.resolve(bulkRaw);
    if (key === BARCODE_KEY) return Promise.resolve(barcodeOwnRaw);
    return Promise.resolve(null);
  });

  await act(async () => {
    tree = await render(<BarcodeAddPart />);
  });
  // Flush async storage reads
  await act(async () => {});

  return tree!.root as unknown as Inst;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("BarcodeAddPart — cross-flow session warning (reciprocal)", () => {

  it("A) shows cross-flow warning when BulkShelfAssign has an active session", async () => {
    const root = await renderComponent(BULK_SESSION);

    expect(hasText(root, "In-progress session in another flow")).toBe(true);
    expect(hasText(root, "Bulk Assign by Shelf")).toBe(true);
  });

  it("B) no cross-flow warning when BulkShelfAssign session is absent", async () => {
    const root = await renderComponent(null);

    expect(hasText(root, "In-progress session in another flow")).toBe(false);
  });

  it("C) suppresses warning when BulkShelfAssign blob is missing shelfItems", async () => {
    // Missing shelfItems → isActiveBulkShelfAssignSession returns false
    const malformed = JSON.stringify({
      shelfPrefix:  "16-37",
      itemRowStates: {},
      targetItemId: null,
      // shelfItems intentionally omitted
    });
    const root = await renderComponent(malformed);

    expect(hasText(root, "In-progress session in another flow")).toBe(false);
  });

  it("D) suppresses warning when itemRowStates is an array (nested malformed)", async () => {
    const nestedMalformed = JSON.stringify({
      shelfPrefix:   "16-37",
      shelfItems:    [],
      itemRowStates: [],     // must be a plain object, not an array
      targetItemId:  null,
    });
    const root = await renderComponent(nestedMalformed);

    expect(hasText(root, "In-progress session in another flow")).toBe(false);
  });

  it("C2) suppresses warning when shelfItems contains null entries", async () => {
    const nullEntry = JSON.stringify({
      shelfPrefix:   "16-37",
      shelfItems:    [null],   // null is not a valid InventoryItem
      itemRowStates: {},
      targetItemId:  null,
    });
    const root = await renderComponent(nullEntry);
    expect(hasText(root, "In-progress session in another flow")).toBe(false);
  });

  it("C3) suppresses warning when shelfItems entries are missing required id field", async () => {
    const missingId = JSON.stringify({
      shelfPrefix:   "16-37",
      shelfItems:    [{ catalog: "PART-1", vendor: "ACME" }],  // id missing
      itemRowStates: {},
      targetItemId:  null,
    });
    const root = await renderComponent(missingId);
    expect(hasText(root, "In-progress session in another flow")).toBe(false);
  });

  it("D2) suppresses warning when itemRowStates values are non-object (string)", async () => {
    const badRowState = JSON.stringify({
      shelfPrefix:   "16-37",
      shelfItems:    [{ id: 1, catalog: "PART-1", vendor: "ACME" }],
      itemRowStates: { "1": "not_an_object" },  // values must be objects
      targetItemId:  null,
    });
    const root = await renderComponent(badRowState);
    expect(hasText(root, "In-progress session in another flow")).toBe(false);
  });

  it("D3) suppresses warning when itemRowStates entry has non-boolean flash", async () => {
    const badFlash = JSON.stringify({
      shelfPrefix:   "16-37",
      shelfItems:    [{ id: 1, catalog: "PART-1", vendor: "ACME" }],
      itemRowStates: {
        "1": {
          assignedBarcode: null,
          syncStatus:      null,
          conflictBarcode: null,
          conflictOwner:   null,
          flash:           "yes",  // must be boolean
        },
      },
      targetItemId: null,
    });
    const root = await renderComponent(badFlash);
    expect(hasText(root, "In-progress session in another flow")).toBe(false);
  });

  it("D4) shows warning when shelfItems and itemRowStates are fully valid", async () => {
    const fullyValid = JSON.stringify({
      shelfPrefix:   "16-37",
      shelfItems:    [{ id: 1, catalog: "PART-1", vendor: "ACME", binLocations: [], barcodes: [] }],
      itemRowStates: {
        "1": {
          assignedBarcode: null,
          syncStatus:      "pending",
          conflictBarcode: null,
          conflictOwner:   null,
          flash:           false,
        },
      },
      targetItemId: null,
    });
    const root = await renderComponent(fullyValid);
    expect(hasText(root, "In-progress session in another flow")).toBe(true);
  });

  it("E) shows BOTH own resume banner and cross-flow warning when both sessions are active", async () => {
    const root = await renderComponent(BULK_SESSION, BARCODE_SESSION);

    // Own resume banner
    expect(hasText(root, "Resume shelf session")).toBe(true);
    expect(hasText(root, "10-22")).toBe(true);

    // Cross-flow warning must appear alongside the resume banner
    expect(hasText(root, "In-progress session in another flow")).toBe(true);
    expect(hasText(root, "Bulk Assign by Shelf")).toBe(true);
  });
});
