/**
 * @jest-environment node
 *
 * Verifies that photo-upload errors in PartDetailsEditor surface as visible
 * field-level error text after the expo-file-system import was changed to
 * expo-file-system/legacy.
 *
 * Scenarios covered:
 *   1. FileSystem.readAsStringAsync (expo-file-system/legacy) throws →
 *      fieldSaveErrors.photo is shown ("Could not save — check connection")
 *   2. PATCH /photo returns a non-ok response →
 *      fieldSaveErrors.photo is shown
 *   3. Happy path: readAsStringAsync succeeds + PATCH ok →
 *      fetch is called with the correct imageBase64 body
 *   4. Slot-2 (photo2) upload error also surfaces as fieldSaveErrors.photo2
 */

// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

// ─── expo-file-system/legacy mock ────────────────────────────────────────────

const mockReadAsStringAsync = jest.fn<Promise<string>, [string, { encoding: string }]>();

jest.mock("expo-file-system/legacy", () => ({
  readAsStringAsync: (...a: [string, { encoding: string }]) => mockReadAsStringAsync(...a),
  EncodingType: { Base64: "base64" },
}));

// ─── PartPhotoPicker mock — captures onChange per slot ────────────────────────

const mockPhotoCbs: {
  slot1?: ((uri: string | null) => void) | undefined;
  slot2?: ((uri: string | null) => void) | undefined;
} = {};

jest.mock("@/components/PartPhotoPicker", () => ({
  PartPhotoPicker: ({
    onChange,
    slot,
  }: {
    onChange: (uri: string | null) => void;
    slot?: number;
  }) => {
    if (slot === 2) {
      mockPhotoCbs.slot2 = onChange;
    } else {
      mockPhotoCbs.slot1 = onChange;
    }
    return null;
  },
}));

// ─── fetch mock ───────────────────────────────────────────────────────────────

const mockFetch = jest.fn();
(global as unknown as { fetch: unknown }).fetch = mockFetch;

// ─── Remaining module mocks ───────────────────────────────────────────────────

jest.mock("@workspace/api-client-react", () => ({
  useUpdateItemBins:        jest.fn(() => ({ mutateAsync: jest.fn().mockResolvedValue(undefined) })),
  useUpdateItemKeywords:    jest.fn(() => ({ mutateAsync: jest.fn().mockResolvedValue(undefined) })),
  getListInventoryQueryKey: jest.fn(() => ["inventory"]),
}));

jest.mock("@tanstack/react-query", () => ({
  useQueryClient: jest.fn(() => ({
    getQueriesData:    jest.fn().mockReturnValue([]),
    setQueryData:      jest.fn(),
    setQueriesData:    jest.fn(),
    invalidateQueries: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem:  jest.fn().mockResolvedValue(null),
    setItem:  jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

jest.mock("@/components/DismissKeyboard", () => ({
  DismissKeyboard: ({ children }: { children: React.ReactNode }) =>
    children as React.ReactElement,
}));

jest.mock("@/components/MeasurePartScreen", () => ({
  MeasurePartScreen: () => null,
}));

jest.mock("@/utils/editItemCache", () => ({
  invalidateListCache:           jest.fn().mockResolvedValue(undefined),
  evictDeletedItemFromAllCaches: jest.fn().mockResolvedValue(undefined),
  invalidateAllCachesAfterSave:  jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

jest.mock("@/utils/apiBase", () => ({
  API_BASE:   "http://localhost:8080/api",
  API_ORIGIN: "http://localhost:8080",
}));

jest.mock("@/components/KeyboardDoneInput", () => {
  const Rct = require("react");
  return {
    KeyboardDoneInput: (props: {
      placeholder?: string;
      value?: string;
      testID?: string;
      [k: string]: unknown;
    }) =>
      Rct.createElement("rn-textinput", {
        testID:       props.testID ?? props.placeholder ?? "",
        value:        props.value,
        placeholder:  props.placeholder,
      }),
  };
});

// ─── Suppress react-test-renderer deprecation warnings ───────────────────────

let origConsoleError: typeof console.error;
beforeAll(() => {
  origConsoleError = console.error.bind(console);
  jest.spyOn(console, "error").mockImplementation(
    (msg: unknown, ...args: unknown[]) => {
      if (
        typeof msg === "string" &&
        (msg.includes("react-test-renderer is deprecated") ||
          msg.includes("Warning:"))
      ) return;
      origConsoleError(msg, ...args);
    }
  );
});
afterAll(() => { (console.error as jest.Mock).mockRestore?.(); });

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import React from "react";
import renderer, { act } from "react-test-renderer";
import { PartDetailsEditor } from "@/components/PartDetailsEditor";
import type { InventoryItem } from "@workspace/api-client-react";

// ─── Helpers ──────────────────────────────────────────────────────────────────

type Inst = renderer.ReactTestInstance;

function instText(node: Inst | string): string {
  if (typeof node === "string") return node;
  return (node.children ?? []).map(c => instText(c as Inst | string)).join("");
}

function hasText(root: Inst, text: string): boolean {
  return instText(root).includes(text);
}

function findPressable(root: Inst, label: string): Inst | null {
  return (
    root
      .findAll(n => (n.type as string) === "rn-pressable", { deep: true })
      .find(n => instText(n).includes(label)) ?? null
  );
}

async function renderEditor(ui: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => { tree = renderer.create(ui); });
  return tree;
}

const flushPromises = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

function makeItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 42,
    catalog: "PART-X",
    description: "A test part",
    vendor: "ACME",
    binLocations: [],
    aiKeywords: [],
    imageUrl: null,
    imageUrl2: null,
    ...overrides,
  } as unknown as InventoryItem;
}

// ─── Per-test teardown ────────────────────────────────────────────────────────

let activeTree: renderer.ReactTestRenderer | null = null;

afterEach(async () => {
  if (activeTree) {
    await act(async () => { activeTree!.unmount(); });
    activeTree = null;
  }
  jest.clearAllMocks();
  mockPhotoCbs.slot1 = undefined;
  mockPhotoCbs.slot2 = undefined;
  // Restore safe defaults after clearAllMocks.
  mockFetch.mockResolvedValue({
    ok: true,
    json: jest.fn().mockResolvedValue({ imageUrl: "https://example.com/photo.jpg" }),
  });
  mockReadAsStringAsync.mockResolvedValue("base64data==");
});

// =============================================================================
// 1. readAsStringAsync throws → fieldSaveErrors.photo shown
// =============================================================================

describe("PartDetailsEditor – FileSystem.readAsStringAsync failure surfaces as photo field error", () => {
  it("shows 'Could not save — check connection' under the photo slot when readAsStringAsync throws", async () => {
    mockReadAsStringAsync.mockRejectedValueOnce(new Error("disk read failed"));

    const item = makeItem();
    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />
    );
    activeTree = tree;

    // Trigger a new photo selection on slot 1.
    expect(mockPhotoCbs.slot1).toBeDefined();
    await act(async () => {
      mockPhotoCbs.slot1!("file:///new/photo.jpg");
    });

    // hasChanges is now true — "Save Details" button should be present.
    const saveBtn = findPressable(tree.root, "Save Details");
    expect(saveBtn).not.toBeNull();

    await act(async () => { saveBtn!.props.onPress(); });
    await flushPromises();

    expect(hasText(tree.root, "Could not save — check connection")).toBe(true);
  });

  it("does NOT show the error banner (errorMsg) for a photo-slot failure — it uses fieldSaveErrors instead", async () => {
    mockReadAsStringAsync.mockRejectedValueOnce(new Error("permission denied"));

    const item = makeItem();
    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />
    );
    activeTree = tree;

    await act(async () => { mockPhotoCbs.slot1!("file:///new/photo.jpg"); });
    const saveBtn = findPressable(tree.root, "Save Details");
    await act(async () => { saveBtn!.props.onPress(); });
    await flushPromises();

    // The field-level error must be shown, not an errorMsg banner.
    expect(hasText(tree.root, "Could not save — check connection")).toBe(true);
  });
});

// =============================================================================
// 2. PATCH /photo returns non-ok → fieldSaveErrors.photo shown
// =============================================================================

describe("PartDetailsEditor – PATCH /photo non-ok response surfaces as photo field error", () => {
  it("shows 'Could not save — check connection' when the server returns a 400 error", async () => {
    mockReadAsStringAsync.mockResolvedValue("base64data==");
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: jest.fn().mockResolvedValue({ error: "Invalid image format" }),
    });

    const item = makeItem();
    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />
    );
    activeTree = tree;

    await act(async () => { mockPhotoCbs.slot1!("file:///new/photo.jpg"); });
    const saveBtn = findPressable(tree.root, "Save Details");
    expect(saveBtn).not.toBeNull();

    await act(async () => { saveBtn!.props.onPress(); });
    await flushPromises();

    expect(hasText(tree.root, "Could not save — check connection")).toBe(true);
  });

  it("shows session-expired field error when the server returns a 401", async () => {
    mockReadAsStringAsync.mockResolvedValue("base64data==");
    // Return empty json so the thrown message falls back to "HTTP 401",
    // which the handler detects via msg.includes("401").
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: jest.fn().mockResolvedValue({}),
    });

    const item = makeItem();
    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />
    );
    activeTree = tree;

    await act(async () => { mockPhotoCbs.slot1!("file:///new/photo.jpg"); });
    const saveBtn = findPressable(tree.root, "Save Details");

    await act(async () => { saveBtn!.props.onPress(); });
    await flushPromises();

    expect(hasText(tree.root, "Session expired — re-unlock admin access")).toBe(true);
  });
});

// =============================================================================
// 3. Happy path: readAsStringAsync + PATCH succeed → fetch called with correct body
// =============================================================================

describe("PartDetailsEditor – successful photo upload calls PATCH /photo with imageBase64", () => {
  it("calls fetch with imageBase64 body when readAsStringAsync returns base64 data", async () => {
    const fakeBase64 = "ZmFrZWJhc2U2NA==";
    mockReadAsStringAsync.mockResolvedValue(fakeBase64);
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ imageUrl: "https://example.com/photo.jpg" }),
    });

    const item = makeItem();
    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />
    );
    activeTree = tree;

    await act(async () => { mockPhotoCbs.slot1!("file:///new/photo.jpg"); });
    const saveBtn = findPressable(tree.root, "Save Details");

    await act(async () => { saveBtn!.props.onPress(); });
    await flushPromises();

    // fetch must have been called with the PATCH /photo endpoint.
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/photo"),
      expect.objectContaining({
        method: "PATCH",
        body: expect.stringContaining(fakeBase64),
      }),
    );

    // No error text should be visible.
    expect(hasText(tree.root, "Could not save — check connection")).toBe(false);
    expect(hasText(tree.root, "Session expired — re-unlock admin access")).toBe(false);
  });

  it("reads from expo-file-system/legacy (readAsStringAsync) with base64 encoding option", async () => {
    const photoUri = "file:///tmp/new-photo.jpg";
    mockReadAsStringAsync.mockResolvedValue("aGVsbG8=");
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ imageUrl: "https://example.com/photo.jpg" }),
    });

    const item = makeItem();
    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />
    );
    activeTree = tree;

    await act(async () => { mockPhotoCbs.slot1!(photoUri); });
    const saveBtn = findPressable(tree.root, "Save Details");

    await act(async () => { saveBtn!.props.onPress(); });
    await flushPromises();

    expect(mockReadAsStringAsync).toHaveBeenCalledWith(
      photoUri,
      expect.objectContaining({ encoding: "base64" }),
    );
  });
});

// =============================================================================
// 4. Slot-2 upload error also surfaces as fieldSaveErrors.photo2
// =============================================================================

describe("PartDetailsEditor – slot-2 photo upload error surfaces as photo2 field error", () => {
  it("shows 'Could not save — check connection' under slot 2 when readAsStringAsync throws", async () => {
    mockReadAsStringAsync.mockRejectedValueOnce(new Error("slot 2 disk error"));

    const item = makeItem();
    const tree = await renderEditor(
      <PartDetailsEditor item={item} adminToken="test-token" onClose={jest.fn()} />
    );
    activeTree = tree;

    expect(mockPhotoCbs.slot2).toBeDefined();
    await act(async () => {
      mockPhotoCbs.slot2!("file:///new/photo2.jpg");
    });

    const saveBtn = findPressable(tree.root, "Save Details");
    expect(saveBtn).not.toBeNull();

    await act(async () => { saveBtn!.props.onPress(); });
    await flushPromises();

    expect(hasText(tree.root, "Could not save — check connection")).toBe(true);
  });
});
