/**
 * Regression guard: the "Delete this part" trash-icon button must NEVER appear
 * for non-admin users.
 *
 * Covers:
 *   A. PartDetailsEditor rendered with adminToken=null → no delete button.
 *   B. EditItemScreen rendered with isAdmin=false / adminToken=null → no delete button.
 *
 * For comparison each suite also asserts the button IS present when the token
 * is supplied, confirming the gate is actually wired up (not just missing).
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { render, act } from "@testing-library/react-native";
import type { RenderResult } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";
import { PartDetailsEditor } from "@/components/PartDetailsEditor";
import type { InventoryItem } from "@workspace/api-client-react";

// ─── Shared mocks ─────────────────────────────────────────────────────────────

jest.mock("@/components/PartPhotoPicker", () => ({
  PartPhotoPicker: () => null,
}));

jest.mock("@workspace/api-client-react", () => ({
  useUpdateItemBins:         jest.fn(() => ({ mutateAsync: jest.fn().mockResolvedValue(undefined) })),
  useUpdateItemKeywords:     jest.fn(() => ({ mutateAsync: jest.fn().mockResolvedValue(undefined) })),
  useUpdateItemBarcodes:     jest.fn(() => ({ mutateAsync: jest.fn().mockResolvedValue(undefined) })),
  getListInventoryQueryKey:  jest.fn(() => ["inventory"]),
}));

jest.mock("@tanstack/react-query", () => ({
  useQueryClient: jest.fn(() => ({
    getQueriesData:    jest.fn().mockReturnValue([]),
    setQueryData:      jest.fn(),
    setQueriesData:    jest.fn(),
    invalidateQueries: jest.fn().mockResolvedValue(undefined),
  })),
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
  invalidateAllCachesAfterSave:  jest.fn().mockResolvedValue(undefined),
  evictDeletedItemFromAllCaches: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

jest.mock("@/utils/apiBase", () => ({
  API_BASE:   "http://localhost:8080/api",
  API_ORIGIN: "http://localhost:8080",
}));

// ─── EditItemScreen-specific mocks ────────────────────────────────────────────

// Mutable so each suite can adjust adminToken / isAdmin.
const mockUseApp = jest.fn();

jest.mock("@/contexts/AppContext", () => ({
  useApp: () => mockUseApp(),
}));

jest.mock("expo-router", () => ({
  useRouter:            jest.fn(() => ({ replace: jest.fn(), back: jest.fn() })),
  useLocalSearchParams: jest.fn(() => ({})),
  useFocusEffect:       jest.fn(),
  useNavigation:        jest.fn(() => ({
    addListener: jest.fn(() => jest.fn()),
    dispatch:    jest.fn(),
  })),
}));

jest.mock("expo-camera", () => ({
  CameraView:           () => null,
  useCameraPermissions: jest.fn(() => [{ granted: false }, jest.fn()]),
}));

jest.mock("lidar-measure", () => ({
  isLiDARSupported: jest.fn(() => false),
}));

jest.mock("@/components/KeyboardDoneInput", () => ({
  KeyboardDoneInput: ({ children }: { children?: React.ReactNode }) =>
    (children ?? null) as React.ReactElement | null,
}));

jest.mock("@/utils/useTrackScreen", () => ({
  useTrackScreen: jest.fn(),
}));

jest.mock("@/utils/adminGuard", () => ({
  shouldRedirectNonAdmin: jest.fn(() => false),
}));

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: { getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn() },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

type Inst = TestInstance;

function findByA11yLabel(root: Inst, label: string): Inst | null {
  return (
    root
      .queryAll((n: TestInstance) => n.props.accessibilityLabel === label, { includeSelf: true })
      .at(0) ?? null
  );
}

async function renderUI(ui: React.ReactElement) {
  let result!: Awaited<ReturnType<typeof render>>;
  await act(async () => { result = await render(ui); });
  return result;
}

function makeItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 7,
    catalog: "GATE-TEST",
    description: "Gate test part",
    vendor: "ACME",
    binLocations: [],
    aiKeywords: [],
    imageUrl: null,
    ...overrides,
  } as unknown as InventoryItem;
}

// ─── Per-test teardown ────────────────────────────────────────────────────────

let activeTree: Awaited<ReturnType<typeof render>> | null = null;

afterEach(async () => {
  if (activeTree) {
    await act(async () => { activeTree!.unmount(); });
    activeTree = null;
  }
  jest.clearAllMocks();
});

// =============================================================================
// A. PartDetailsEditor – admin gate on the delete button
// =============================================================================

describe("PartDetailsEditor – delete button admin gate", () => {
  it("does NOT render the delete button when adminToken is null", async () => {
    const item = makeItem();
    const result = await renderUI(
      <PartDetailsEditor
        item={item}
        adminToken={null}
        onClose={jest.fn()}
      />
    );
    activeTree = result;

    const deleteBtn = findByA11yLabel(result.root!, "Delete this part");
    expect(deleteBtn).toBeNull();
  });

  it("DOES render the delete button when adminToken is provided", async () => {
    const item = makeItem();
    const result = await renderUI(
      <PartDetailsEditor
        item={item}
        adminToken="test-admin-token"
        onClose={jest.fn()}
      />
    );
    activeTree = result;

    const deleteBtn = findByA11yLabel(result.root!, "Delete this part");
    expect(deleteBtn).not.toBeNull();
  });
});

// =============================================================================
// B. EditItemScreen – delete button admin gate
// =============================================================================

describe("EditItemScreen – delete button admin gate", () => {
  // Lazy-import so module mocks are already in place before the first import.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const getEditItemScreen = () => require("@/app/edit-item").default as React.ComponentType;

  const baseAppContext = {
    isLoading:         true,   // keeps shouldRedirectNonAdmin silent during the test
    pendingLidarDims:  null,
    setPendingLidarDims: jest.fn(),
    settings:          {},
  };

  it("does NOT render the delete button when adminToken is null and isAdmin is false", async () => {
    mockUseApp.mockReturnValue({
      ...baseAppContext,
      adminToken: null,
      isAdmin:    false,
    });

    const { useLocalSearchParams } = require("expo-router") as {
      useLocalSearchParams: jest.Mock;
    };
    useLocalSearchParams.mockReturnValue({ item: JSON.stringify(makeItem()) });

    const EditItemScreen = getEditItemScreen();
    const result = await renderUI(<EditItemScreen />);
    activeTree = result;

    const deleteBtn = findByA11yLabel(result.root!, "Delete this part");
    expect(deleteBtn).toBeNull();
  });

  it("DOES render the delete button when adminToken is present", async () => {
    mockUseApp.mockReturnValue({
      ...baseAppContext,
      adminToken: "admin-token",
      isAdmin:    true,
    });

    const { useLocalSearchParams } = require("expo-router") as {
      useLocalSearchParams: jest.Mock;
    };
    useLocalSearchParams.mockReturnValue({ item: JSON.stringify(makeItem()) });

    const EditItemScreen = getEditItemScreen();
    const result = await renderUI(<EditItemScreen />);
    activeTree = result;

    const deleteBtn = findByA11yLabel(result.root!, "Delete this part");
    expect(deleteBtn).not.toBeNull();
  });
});

// =============================================================================
// C. EditItemScreen – delete handler behaviour
// =============================================================================

describe("delete handler behaviour", () => {
  // Lazy-import after all mocks are registered.
  const getEditItemScreen = () => require("@/app/edit-item").default as React.ComponentType;

  // Stable router stubs — recreated per-test so call counts start at 0.
  let mockRouterBack: jest.Mock;
  let mockRouterReplace: jest.Mock;

  const adminAppCtx = {
    isLoading:           true, // keeps shouldRedirectNonAdmin quiet
    pendingLidarDims:    null,
    setPendingLidarDims: jest.fn(),
    settings:            {},
    adminToken:          "test-admin-token",
    isAdmin:             true,
  };

  // ─── Restore every mock cleared by the outer afterEach clearAllMocks ───────
  beforeEach(() => {
    mockRouterBack    = jest.fn();
    mockRouterReplace = jest.fn();

    mockUseApp.mockReturnValue(adminAppCtx);

    const expoRouter = require("expo-router") as {
      useRouter:            jest.Mock;
      useLocalSearchParams: jest.Mock;
      useFocusEffect:       jest.Mock;
    };
    expoRouter.useRouter.mockReturnValue({ back: mockRouterBack, replace: mockRouterReplace });
    expoRouter.useLocalSearchParams.mockReturnValue({ item: JSON.stringify(makeItem()) });
    expoRouter.useFocusEffect.mockImplementation(() => {});

    const cam = require("expo-camera") as { useCameraPermissions: jest.Mock };
    cam.useCameraPermissions.mockReturnValue([{ granted: false }, jest.fn()]);

    (require("lidar-measure") as { isLiDARSupported: jest.Mock })
      .isLiDARSupported.mockReturnValue(false);

    (require("@/utils/adminGuard") as { shouldRedirectNonAdmin: jest.Mock })
      .shouldRedirectNonAdmin.mockReturnValue(false);

    const apiClient = require("@workspace/api-client-react") as {
      useUpdateItemBins:        jest.Mock;
      useUpdateItemBarcodes:    jest.Mock;
      useUpdateItemKeywords:    jest.Mock;
      getListInventoryQueryKey: jest.Mock;
    };
    const noopMutate = { mutateAsync: jest.fn().mockResolvedValue(undefined) };
    apiClient.useUpdateItemBins.mockReturnValue(noopMutate);
    apiClient.useUpdateItemBarcodes.mockReturnValue(noopMutate);
    apiClient.useUpdateItemKeywords.mockReturnValue(noopMutate);
    apiClient.getListInventoryQueryKey.mockReturnValue(["inventory"]);

    (require("@tanstack/react-query") as { useQueryClient: jest.Mock })
      .useQueryClient.mockReturnValue({
        getQueriesData:    jest.fn().mockReturnValue([]),
        setQueryData:      jest.fn(),
        setQueriesData:    jest.fn(),
        invalidateQueries: jest.fn().mockResolvedValue(undefined),
      });

    const cache = require("@/utils/editItemCache") as {
      invalidateListCache:           jest.Mock;
      invalidateAllCachesAfterSave:  jest.Mock;
      evictDeletedItemFromAllCaches: jest.Mock;
    };
    cache.invalidateListCache.mockResolvedValue(undefined);
    cache.invalidateAllCachesAfterSave.mockResolvedValue(undefined);
    cache.evictDeletedItemFromAllCaches.mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Remove the per-test fetch override to avoid cross-test pollution.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (global as any).fetch;
  });

  // ─── Local helpers ─────────────────────────────────────────────────────────

  function findDeleteBtn(root: Inst): Inst | null {
    return (
      root
        .queryAll((n: Inst) => n.props.accessibilityLabel === "Delete this part", { includeSelf: true })
        .at(0) ?? null
    );
  }

  function findByTestIDProp(root: Inst, testID: string): Inst | null {
    return (
      root
        .queryAll((n: Inst) => n.props.testID === testID, { includeSelf: true })
        .at(0) ?? null
    );
  }

  /**
   * Press the "Delete" button inside the most-recent Alert.alert call.
   * Must be called inside act().
   */
  function pressAlertDelete(): void {
    const alertMock = (require("react-native") as { Alert: { alert: jest.Mock } }).Alert.alert;
    const calls = alertMock.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const buttons = calls[calls.length - 1]![2] as Array<{ text: string; onPress?: () => void }>;
    const btn = buttons.find(b => b.text === "Delete");
    expect(btn).toBeDefined();
    btn!.onPress?.();
  }

  // ─── Tests ─────────────────────────────────────────────────────────────────

  it("disables the delete button while the fetch is in flight", async () => {
    // Fetch stays pending for the duration of the in-flight assertion.
    let resolveFetch!: (v: unknown) => void;
    global.fetch = jest.fn().mockReturnValue(new Promise(res => { resolveFetch = res; }));

    const EditItemScreen = getEditItemScreen();
    const result = await renderUI(<EditItemScreen />);
    activeTree = result;

    const deleteBtn = findDeleteBtn(result.root!);
    expect(deleteBtn).not.toBeNull();
    expect(deleteBtn!.props.disabled).toBeFalsy();

    // Open Alert.
    await act(async () => { deleteBtn!.props.onPress(); });
    expect((require("react-native") as { Alert: { alert: jest.Mock } }).Alert.alert)
      .toHaveBeenCalledTimes(1);

    // Confirm — fetch starts but stays pending.
    await act(async () => { pressAlertDelete(); });

    // Button must be disabled (deleting === true).
    const btnMidFlight = findDeleteBtn(result.root!);
    expect(btnMidFlight).not.toBeNull();
    expect(btnMidFlight!.props.disabled).toBe(true);

    // Resolve so the component can finish before the next test / unmount.
    await act(async () => {
      resolveFetch({ ok: true, json: async () => ({ deleted: true }) });
    });
  });

  it("shows a footer error when the DELETE endpoint returns a non-2xx status", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok:     false,
      status: 403,
      json:   async () => ({ error: "Forbidden" }),
    });

    const EditItemScreen = getEditItemScreen();
    const result = await renderUI(<EditItemScreen />);
    activeTree = result;

    await act(async () => { findDeleteBtn(result.root!)!.props.onPress(); });
    await act(async () => { pressAlertDelete(); });
    await act(async () => {}); // flush remaining microtasks

    const errorEl = findByTestIDProp(result.root!, "delete-error-msg");
    expect(errorEl).not.toBeNull();
    expect(errorEl!.props.children).toBe("Forbidden");
  });

  it("shows a footer error when the network call throws entirely", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("network failure"));

    const EditItemScreen = getEditItemScreen();
    const result = await renderUI(<EditItemScreen />);
    activeTree = result;

    await act(async () => { findDeleteBtn(result.root!)!.props.onPress(); });
    await act(async () => { pressAlertDelete(); });
    await act(async () => {});

    const errorEl = findByTestIDProp(result.root!, "delete-error-msg");
    expect(errorEl).not.toBeNull();
    expect(String(errorEl!.props.children)).toContain("Could not delete the part");
  });

  it("calls router.back and evicts the item from all caches on a successful 200 delete", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok:   true,
      json: async () => ({ deleted: true }),
    });

    const EditItemScreen = getEditItemScreen();
    const result = await renderUI(<EditItemScreen />);
    activeTree = result;

    await act(async () => { findDeleteBtn(result.root!)!.props.onPress(); });
    await act(async () => { pressAlertDelete(); });
    await act(async () => {});

    // No footer error on success.
    expect(findByTestIDProp(result.root!, "delete-error-msg")).toBeNull();

    // Cache eviction with the correct itemId.
    const { evictDeletedItemFromAllCaches } = require("@/utils/editItemCache") as {
      evictDeletedItemFromAllCaches: jest.Mock;
    };
    expect(evictDeletedItemFromAllCaches).toHaveBeenCalledTimes(1);
    expect(evictDeletedItemFromAllCaches.mock.calls[0]![0]).toMatchObject({ itemId: 7 });

    // Navigation.
    expect(mockRouterBack).toHaveBeenCalledTimes(1);
  });

  it("clears the previous error before showing the Alert on a retry", async () => {
    // First attempt — fails.
    global.fetch = jest.fn().mockResolvedValue({
      ok:     false,
      status: 500,
      json:   async () => ({}),
    });

    const EditItemScreen = getEditItemScreen();
    const result = await renderUI(<EditItemScreen />);
    activeTree = result;

    await act(async () => { findDeleteBtn(result.root!)!.props.onPress(); });
    await act(async () => { pressAlertDelete(); });
    await act(async () => {});

    // Error is visible after the first failure.
    expect(findByTestIDProp(result.root!, "delete-error-msg")).not.toBeNull();

    // Reset the Alert spy so we can assert it fires once more.
    const alertMock = (require("react-native") as { Alert: { alert: jest.Mock } }).Alert.alert;
    alertMock.mockClear();

    // Second tap — press the delete button again.
    await act(async () => { findDeleteBtn(result.root!)!.props.onPress(); });

    // handleDeleteItem calls setDeleteErrorMsg(null) synchronously before Alert.alert,
    // so the error must be gone by the time act() resolves.
    expect(findByTestIDProp(result.root!, "delete-error-msg")).toBeNull();

    // A fresh confirmation Alert must have appeared.
    expect(alertMock).toHaveBeenCalledTimes(1);
  });
});
