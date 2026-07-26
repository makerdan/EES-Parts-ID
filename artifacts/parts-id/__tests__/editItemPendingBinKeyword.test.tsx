/**
 * Guards the auto-pending bin/keyword logic in EditItemScreen.handleSave:
 *
 *   When the admin types text into the newBin or newKeyword input field but
 *   does NOT press the "Add" button before tapping "Save Details", handleSave
 *   must treat that text as a pending addition and include it in the mutation
 *   payload — so no data typed by the admin is silently dropped.
 *
 * Cases covered:
 *   1. Pending bin text is appended to the bins array sent to updateBinsMutation.
 *   2. Pending keyword text is appended (lowercased) to the keywords array sent
 *      to updateKeywordsMutation.
 *   3. Both pending bin and pending keyword are included in the same save.
 *   4. Pending bin/keyword that already exists in the array is NOT duplicated.
 *   5. Whitespace-only pending text is ignored.
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { render, act } from "@testing-library/react-native";
import type { InventoryItem } from "@workspace/api-client-react";
import type { TestInstance } from "test-renderer";

// ─── Stable spies ────────────────────────────────────────────────────────────

const mockRouterBack    = jest.fn();
const mockRouterReplace = jest.fn();

const mockGetQueriesData      = jest.fn().mockReturnValue([]);
const mockSetQueryData        = jest.fn();
const mockSetQueriesData      = jest.fn();
const mockInvalidateQueries   = jest.fn().mockResolvedValue(undefined);

const mockBinsMutateAsync      = jest.fn().mockResolvedValue(undefined);
const mockKeywordsMutateAsync  = jest.fn().mockResolvedValue(undefined);
const mockBarcodesMutateAsync  = jest.fn().mockResolvedValue(undefined);

const mockFetch = jest.fn().mockResolvedValue({
  ok: true,
  json: jest.fn().mockResolvedValue({}),
});
(global as unknown as { fetch: unknown }).fetch = mockFetch;

const mockInvalidateAllCachesAfterSave = jest.fn().mockResolvedValue(undefined);
const mockEvictDeletedItemFromAllCaches = jest.fn().mockResolvedValue(undefined);

// ─── Item fixture ─────────────────────────────────────────────────────────────

function makeItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id:           42,
    catalog:      "PART-X",
    description:  "Original description",
    vendor:       "ACME",
    binLocations: [],
    barcodes:     [],
    aiKeywords:   [],
    imageUrl:     null,
    imageUrl2:    null,
    dimensions:   null,
    ...overrides,
  } as unknown as InventoryItem;
}

// The screen reads item from useLocalSearchParams as JSON.
let testItem = makeItem();

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock("expo-router", () => ({
  useRouter:             jest.fn(() => ({ back: mockRouterBack, replace: mockRouterReplace })),
  useLocalSearchParams:  jest.fn(() => ({ item: JSON.stringify(testItem), section: undefined })),
  useFocusEffect:        jest.fn((cb: () => (() => void) | void) => { cb(); }),
}));

jest.mock("expo-camera", () => ({
  CameraView:           () => null,
  useCameraPermissions: jest.fn(() => [{ granted: false }, jest.fn()]),
}));

jest.mock("lidar-measure", () => ({
  isLiDARSupported: jest.fn(() => false),
}));

jest.mock("expo-file-system/legacy", () => ({
  readAsStringAsync: jest.fn().mockResolvedValue("base64data"),
  cacheDirectory:    "/tmp/",
  makeDirectoryAsync: jest.fn().mockResolvedValue(undefined),
  getInfoAsync:       jest.fn().mockResolvedValue({ exists: false }),
  deleteAsync:        jest.fn().mockResolvedValue(undefined),
  downloadAsync:      jest.fn().mockResolvedValue({ status: 200, uri: "/tmp/file" }),
}));

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem:  jest.fn().mockResolvedValue(null),
    setItem:  jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("@tanstack/react-query", () => ({
  useQueryClient: jest.fn(() => ({
    getQueriesData:    (...a: unknown[]) => mockGetQueriesData(...a),
    setQueryData:      (...a: unknown[]) => mockSetQueryData(...a),
    setQueriesData:    (...a: unknown[]) => mockSetQueriesData(...a),
    invalidateQueries: (...a: unknown[]) => mockInvalidateQueries(...a),
  })),
}));

jest.mock("@workspace/api-client-react", () => ({
  useUpdateItemBins:        jest.fn(() => ({ mutateAsync: (...a: unknown[]) => mockBinsMutateAsync(...a) })),
  useUpdateItemKeywords:    jest.fn(() => ({ mutateAsync: (...a: unknown[]) => mockKeywordsMutateAsync(...a) })),
  useUpdateItemBarcodes:    jest.fn(() => ({ mutateAsync: (...a: unknown[]) => mockBarcodesMutateAsync(...a) })),
  getListInventoryQueryKey: jest.fn(() => ["/api/inventory"]),
}));

jest.mock("@/contexts/AppContext", () => ({
  useApp: jest.fn(() => ({
    adminToken:          "test-token",
    isAdmin:             true,
    isLoading:           false,
    pendingLidarDims:    null,
    setPendingLidarDims: jest.fn(),
  })),
}));

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

jest.mock("@/utils/adminGuard", () => ({
  shouldRedirectNonAdmin: jest.fn(() => false),
}));

jest.mock("@/utils/apiBase", () => ({
  API_BASE:   "http://localhost:8080/api",
  API_ORIGIN: "http://localhost:8080",
}));

jest.mock("@/utils/editItemCache", () => ({
  invalidateAllCachesAfterSave:    (...args: unknown[]) => mockInvalidateAllCachesAfterSave(...args),
  evictDeletedItemFromAllCaches:   (...args: unknown[]) => mockEvictDeletedItemFromAllCaches(...args),
}));

jest.mock("@/utils/useTrackScreen", () => ({
  useTrackScreen: jest.fn(),
}));

jest.mock("@/components/MeasurePartScreen", () => ({
  MeasurePartScreen: () => null,
}));

jest.mock("@/components/PartPhotoPicker", () => ({
  PartPhotoPicker: () => null,
}));

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

jest.mock("@/components/KeyboardDoneInput", () => {
  const Rct = require("react");
  return {
    KeyboardDoneInput: (props: {
      placeholder?: string;
      onChangeText?: (v: string) => void;
      value?: string;
      testID?: string;
      [k: string]: unknown;
    }) =>
      Rct.createElement("rn-textinput", {
        testID:       props.testID ?? props.placeholder ?? "",
        value:        props.value,
        onChangeText: props.onChangeText,
        placeholder:  props.placeholder,
      }),
  };
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

type Inst = TestInstance;

function instText(node: Inst | string): string {
  if (typeof node === "string") return node;
  return (node.children ?? []).map((c: Inst | string) => instText(c as Inst | string)).join("");
}

function findPressable(root: Inst, label: string): Inst | null {
  return (
    root
      .queryAll((n: TestInstance) => (n.type as string) === "rn-pressable", { includeSelf: true })
      .find((n: Inst) => instText(n).includes(label)) ?? null
  );
}

function findTextInput(root: Inst, placeholder: string): Inst | null {
  return (
    root
      .queryAll((n: TestInstance) => (n.type as string) === "rn-textinput", { includeSelf: true })
      .find((n: Inst) => n.props.testID === placeholder || n.props.placeholder === placeholder)
    ?? null
  );
}

async function renderScreen() {
  const EditItemScreen = (await import("../app/edit-item")).default;
  return await render(<EditItemScreen />);
}

// ─── Per-test teardown ────────────────────────────────────────────────────────

let activeTree: Awaited<ReturnType<typeof render>> | null = null;

afterEach(async () => {
  if (activeTree) {
    await act(async () => { activeTree!.unmount(); });
    activeTree = null;
  }
  jest.clearAllMocks();
  // Restore defaults wiped by clearAllMocks.
  mockInvalidateQueries.mockResolvedValue(undefined);
  mockGetQueriesData.mockReturnValue([]);
  mockBinsMutateAsync.mockResolvedValue(undefined);
  mockKeywordsMutateAsync.mockResolvedValue(undefined);
  mockBarcodesMutateAsync.mockResolvedValue(undefined);
  mockInvalidateAllCachesAfterSave.mockResolvedValue(undefined);
  mockFetch.mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({}) });
  // Reset the expo-router mock to always return the current testItem.
  const { useLocalSearchParams } = await import("expo-router");
  (useLocalSearchParams as jest.Mock).mockImplementation(
    () => ({ item: JSON.stringify(testItem), section: undefined }),
  );
  const { shouldRedirectNonAdmin } = await import("@/utils/adminGuard");
  (shouldRedirectNonAdmin as jest.Mock).mockReturnValue(false);
  const { useApp } = await import("@/contexts/AppContext");
  (useApp as jest.Mock).mockReturnValue({
    adminToken:          "test-token",
    isAdmin:             true,
    isLoading:           false,
    pendingLidarDims:    null,
    setPendingLidarDims: jest.fn(),
  });
});

// =============================================================================
// 1. Pending bin text is included in the bins mutation payload
// =============================================================================

describe("EditItemScreen – pending bin text is carried through on Save", () => {
  it("includes typed bin text in the bins mutation when Save is pressed without pressing Add", async () => {
    // Start with a different description so hasChanges is true once we change it.
    testItem = makeItem({ binLocations: [], description: "Original description" });

    const result = await renderScreen();
    activeTree = result;

    // Change description to make hasChanges = true.
    const descInput = findTextInput(result.root!, "Brief description of the part\u2026");
    expect(descInput).not.toBeNull();
    await act(async () => { descInput!.props.onChangeText("New description"); });

    // Type a bin but do NOT press Add.
    const binInput = findTextInput(result.root!, "e.g. A1-04");
    expect(binInput).not.toBeNull();
    await act(async () => { binInput!.props.onChangeText("B2-07"); });

    const saveBtn = findPressable(result.root!, "Save Details");
    expect(saveBtn).not.toBeNull();
    await act(async () => { saveBtn!.props.onPress(); });

    expect(mockBinsMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockBinsMutateAsync).toHaveBeenCalledWith({
      id:   42,
      data: { binLocations: ["B2-07"] },
    });
  });

  it("appends pending bin to existing bins in the mutation payload", async () => {
    testItem = makeItem({ binLocations: ["AISLE-01"], description: "Original description" });

    const result = await renderScreen();
    activeTree = result;

    const descInput = findTextInput(result.root!, "Brief description of the part\u2026");
    await act(async () => { descInput!.props.onChangeText("Updated description"); });

    const binInput = findTextInput(result.root!, "e.g. A1-04");
    expect(binInput).not.toBeNull();
    await act(async () => { binInput!.props.onChangeText("C3-12"); });

    const saveBtn = findPressable(result.root!, "Save Details");
    await act(async () => { saveBtn!.props.onPress(); });

    expect(mockBinsMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockBinsMutateAsync).toHaveBeenCalledWith({
      id:   42,
      data: { binLocations: ["AISLE-01", "C3-12"] },
    });
  });

  it("does NOT duplicate a pending bin that already exists (case-insensitive)", async () => {
    testItem = makeItem({ binLocations: ["AISLE-01"], description: "Original description" });

    const result = await renderScreen();
    activeTree = result;

    const descInput = findTextInput(result.root!, "Brief description of the part\u2026");
    await act(async () => { descInput!.props.onChangeText("Updated description"); });

    // Type the same bin as already exists, different case.
    const binInput = findTextInput(result.root!, "e.g. A1-04");
    await act(async () => { binInput!.props.onChangeText("aisle-01"); });

    const saveBtn = findPressable(result.root!, "Save Details");
    await act(async () => { saveBtn!.props.onPress(); });

    // The duplicate is discarded: finalBins === bins (same reference, already equal
    // to item.binLocations) so no bins mutation fires at all.
    expect(mockBinsMutateAsync).not.toHaveBeenCalled();
  });

  it("ignores whitespace-only pending bin text (does not fire the bins mutation)", async () => {
    testItem = makeItem({ binLocations: [], description: "Original description" });

    const result = await renderScreen();
    activeTree = result;

    const descInput = findTextInput(result.root!, "Brief description of the part\u2026");
    await act(async () => { descInput!.props.onChangeText("Updated description"); });

    const binInput = findTextInput(result.root!, "e.g. A1-04");
    await act(async () => { binInput!.props.onChangeText("   "); });

    const saveBtn = findPressable(result.root!, "Save Details");
    await act(async () => { saveBtn!.props.onPress(); });

    // finalBins === [] === item.binLocations → no bin mutation fires.
    expect(mockBinsMutateAsync).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 2. Pending keyword text is included in the keywords mutation payload
// =============================================================================

describe("EditItemScreen – pending keyword text is carried through on Save", () => {
  it("includes typed keyword text (lowercased) in the keywords mutation when Save is pressed without pressing Add", async () => {
    testItem = makeItem({ aiKeywords: [], description: "Original description" });

    const result = await renderScreen();
    activeTree = result;

    const descInput = findTextInput(result.root!, "Brief description of the part\u2026");
    await act(async () => { descInput!.props.onChangeText("New description"); });

    const kwInput = findTextInput(result.root!, "Type keyword and press Add\u2026");
    expect(kwInput).not.toBeNull();
    await act(async () => { kwInput!.props.onChangeText("Motor"); });

    const saveBtn = findPressable(result.root!, "Save Details");
    await act(async () => { saveBtn!.props.onPress(); });

    expect(mockKeywordsMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockKeywordsMutateAsync).toHaveBeenCalledWith({
      id:   42,
      data: { keywords: ["motor"] },
    });
  });

  it("appends pending keyword to existing keywords in the mutation payload", async () => {
    testItem = makeItem({ aiKeywords: ["relay"], description: "Original description" });

    const result = await renderScreen();
    activeTree = result;

    const descInput = findTextInput(result.root!, "Brief description of the part\u2026");
    await act(async () => { descInput!.props.onChangeText("New description"); });

    const kwInput = findTextInput(result.root!, "Type keyword and press Add\u2026");
    await act(async () => { kwInput!.props.onChangeText("Breaker"); });

    const saveBtn = findPressable(result.root!, "Save Details");
    await act(async () => { saveBtn!.props.onPress(); });

    expect(mockKeywordsMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockKeywordsMutateAsync).toHaveBeenCalledWith({
      id:   42,
      data: { keywords: ["relay", "breaker"] },
    });
  });

  it("does NOT duplicate a pending keyword that already exists in the list", async () => {
    testItem = makeItem({ aiKeywords: ["motor"], description: "Original description" });

    const result = await renderScreen();
    activeTree = result;

    const descInput = findTextInput(result.root!, "Brief description of the part\u2026");
    await act(async () => { descInput!.props.onChangeText("New description"); });

    const kwInput = findTextInput(result.root!, "Type keyword and press Add\u2026");
    await act(async () => { kwInput!.props.onChangeText("Motor"); });

    const saveBtn = findPressable(result.root!, "Save Details");
    await act(async () => { saveBtn!.props.onPress(); });

    // The duplicate is discarded: finalKeywords === keywords (same reference,
    // already equal to item.aiKeywords) so no keywords mutation fires at all.
    expect(mockKeywordsMutateAsync).not.toHaveBeenCalled();
  });

  it("ignores whitespace-only pending keyword text (does not fire the keywords mutation)", async () => {
    testItem = makeItem({ aiKeywords: [], description: "Original description" });

    const result = await renderScreen();
    activeTree = result;

    const descInput = findTextInput(result.root!, "Brief description of the part\u2026");
    await act(async () => { descInput!.props.onChangeText("Updated description"); });

    const kwInput = findTextInput(result.root!, "Type keyword and press Add\u2026");
    await act(async () => { kwInput!.props.onChangeText("   "); });

    const saveBtn = findPressable(result.root!, "Save Details");
    await act(async () => { saveBtn!.props.onPress(); });

    expect(mockKeywordsMutateAsync).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 3. Both pending bin AND keyword text are included together
// =============================================================================

describe("EditItemScreen – both pending bin and keyword text are carried through on Save", () => {
  it("includes both pending bin and keyword in their respective mutation payloads in the same save", async () => {
    testItem = makeItem({ binLocations: [], aiKeywords: [], description: "Original description" });

    const result = await renderScreen();
    activeTree = result;

    const descInput = findTextInput(result.root!, "Brief description of the part\u2026");
    await act(async () => { descInput!.props.onChangeText("New description"); });

    const binInput = findTextInput(result.root!, "e.g. A1-04");
    await act(async () => { binInput!.props.onChangeText("D4-22"); });

    const kwInput = findTextInput(result.root!, "Type keyword and press Add\u2026");
    await act(async () => { kwInput!.props.onChangeText("Contactor"); });

    const saveBtn = findPressable(result.root!, "Save Details");
    await act(async () => { saveBtn!.props.onPress(); });

    expect(mockBinsMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockBinsMutateAsync).toHaveBeenCalledWith({
      id:   42,
      data: { binLocations: ["D4-22"] },
    });

    expect(mockKeywordsMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockKeywordsMutateAsync).toHaveBeenCalledWith({
      id:   42,
      data: { keywords: ["contactor"] },
    });
  });
});

// =============================================================================
// 4. Stale-dims regression — itemRef.current?.dimensions is used, not the
//    render-time existingDims closure
// =============================================================================

describe("EditItemScreen – stale-dims regression", () => {
  it("does not fire a dims PATCH when dimensions are unchanged from itemRef", async () => {
    testItem = makeItem({
      description:  "Original description",
      dimensions:   { length: 5, width: 3, height: 2, diameter: null } as unknown as Exclude<InventoryItem["dimensions"], undefined>,
    });

    const result = await renderScreen();
    activeTree = result;

    // Change description so the save has at least one field to commit,
    // but leave all dim fields at their initial values.
    const descInput = findTextInput(result.root!, "Brief description of the part\u2026");
    await act(async () => { descInput!.props.onChangeText("Updated description"); });

    const saveBtn = findPressable(result.root!, "Save Details");
    await act(async () => { saveBtn!.props.onPress(); });

    // The description PATCH should fire…
    const dimsPatchCalls = (mockFetch as jest.Mock).mock.calls.filter(
      (args: unknown[]) => typeof args[0] === "string" && (args[0] as string).endsWith("/dimensions"),
    );
    expect(dimsPatchCalls).toHaveLength(0);
  });

  it("reverts dim fields to itemRef.current dimensions when the dims PATCH fails", async () => {
    testItem = makeItem({
      description: "Original description",
      dimensions:  { length: 5, width: null, height: null, diameter: null } as unknown as Exclude<InventoryItem["dimensions"], undefined>,
    });

    const result = await renderScreen();
    activeTree = result;

    // The dim inputs all share placeholder="–"; find the length input by its
    // initial value ("5") which matches fmtDim(5).
    const allDashInputs = result.root!!.queryAll(
      (n: TestInstance) => (n.type as string) === "rn-textinput" && n.props.placeholder === "–",
      { includeSelf: true },
    );
    // length is the first dim field rendered.
    const lengthInput = allDashInputs.find((n: TestInstance) => n.props.value === "5") ?? null;
    expect(lengthInput).not.toBeNull();
    await act(async () => { lengthInput!.props.onChangeText("10"); });

    // Make the dims PATCH fail; let other PATCHes succeed.
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.endsWith("/dimensions")) {
        return Promise.resolve({
          ok:   false,
          json: jest.fn().mockResolvedValue({ error: "Validation error" }),
        });
      }
      return Promise.resolve({ ok: true, json: jest.fn().mockResolvedValue({}) });
    });

    // Change description so there is at least one op that succeeds.
    const descInput = findTextInput(result.root!, "Brief description of the part\u2026");
    await act(async () => { descInput!.props.onChangeText("Updated description"); });

    const saveBtn = findPressable(result.root!, "Save Details");
    await act(async () => { saveBtn!.props.onPress(); });

    // After partial failure the dim length field should be reverted to the
    // original value from itemRef.current.dimensions (5 → "5").
    const lengthInputAfter = result.root!!.queryAll(
      (n: TestInstance) => (n.type as string) === "rn-textinput" && n.props.placeholder === "–",
      { includeSelf: true },
    ).find((n: TestInstance) => n.props.value !== "") ?? null;
    expect(lengthInputAfter).not.toBeNull();
    expect(lengthInputAfter!.props.value).toBe("5");
  });
});
