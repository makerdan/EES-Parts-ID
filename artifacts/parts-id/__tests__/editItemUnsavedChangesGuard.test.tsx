/**
 * Guards the unsaved-changes navigation guard added to EditItemScreen (F-040).
 *
 * The screen registers a `beforeRemove` listener via useNavigation().addListener
 * and uses the rendered ConfirmDialog for every dirty exit path.
 *
 * When no changes have been made the listener must allow navigation through
 * without calling preventDefault.
 */

// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

// ─── Navigation listener capture ─────────────────────────────────────────────

type BeforeRemoveEvent = {
  preventDefault: jest.Mock;
  data: { action: { type: string } };
};

let capturedBeforeRemove: ((e: BeforeRemoveEvent) => void) | null = null;
const mockNavigationDispatch = jest.fn();

// ─── Stable spies ─────────────────────────────────────────────────────────────

const mockRouterBack    = jest.fn();
const mockRouterReplace = jest.fn();

const mockGetQueriesData    = jest.fn().mockReturnValue([]);
const mockSetQueryData      = jest.fn();
const mockSetQueriesData    = jest.fn();
const mockInvalidateQueries = jest.fn().mockResolvedValue(undefined);

const mockBinsMutateAsync     = jest.fn().mockResolvedValue(undefined);
const mockKeywordsMutateAsync = jest.fn().mockResolvedValue(undefined);
const mockBarcodesMutateAsync = jest.fn().mockResolvedValue(undefined);

const mockFetch = jest.fn().mockResolvedValue({
  ok: true,
  json: jest.fn().mockResolvedValue({}),
});
(global as unknown as { fetch: unknown }).fetch = mockFetch;

const mockInvalidateAllCachesAfterSave  = jest.fn().mockResolvedValue(undefined);
const mockEvictDeletedItemFromAllCaches = jest.fn().mockResolvedValue(undefined);

// ─── Item fixture ─────────────────────────────────────────────────────────────

const ITEM_FIXTURE = {
  id:           42,
  catalog:      "GUARD-X",
  description:  "Original description",
  vendor:       "ACME",
  binLocations: [] as string[],
  barcodes:     [] as string[],
  aiKeywords:   [] as string[],
  imageUrl:     null as string | null,
  imageUrl2:    null as string | null,
  dimensions:   null,
};

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock("expo-router", () => ({
  useRouter:            jest.fn(() => ({ back: mockRouterBack, replace: mockRouterReplace })),
  useLocalSearchParams: jest.fn(() => ({
    item:    JSON.stringify(ITEM_FIXTURE),
    section: undefined,
  })),
  useFocusEffect: jest.fn((cb: () => (() => void) | void) => { cb(); }),
  useNavigation:  jest.fn(() => ({
    addListener: jest.fn((event: string, cb: (e: BeforeRemoveEvent) => void) => {
      if (event === "beforeRemove") capturedBeforeRemove = cb;
      return jest.fn(); // unsubscribe
    }),
    dispatch: mockNavigationDispatch,
  })),
}));

jest.mock("expo-camera", () => ({
  CameraView:           () => null,
  useCameraPermissions: jest.fn(() => [{ granted: false }, jest.fn()]),
}));

jest.mock("lidar-measure", () => ({
  isLiDARSupported: jest.fn(() => false),
}));

jest.mock("expo-file-system/legacy", () => ({
  readAsStringAsync:  jest.fn().mockResolvedValue("base64data"),
  cacheDirectory:     "/tmp/",
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
  invalidateAllCachesAfterSave:  (...args: unknown[]) => mockInvalidateAllCachesAfterSave(...args),
  evictDeletedItemFromAllCaches: (...args: unknown[]) => mockEvictDeletedItemFromAllCaches(...args),
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

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import React from "react";
import { render, act, fireEvent } from "@testing-library/react-native";

async function renderScreen() {
  const EditItemScreen = (await import("../app/edit-item")).default;
  return await render(<EditItemScreen />);
}

// ─── Per-test teardown ────────────────────────────────────────────────────────

let activeTree: Awaited<ReturnType<typeof render>> | null = null;

afterEach(async () => {
  if (activeTree) {
    await activeTree.unmount();
    activeTree = null;
  }
  capturedBeforeRemove = null;
  jest.clearAllMocks();
  mockInvalidateQueries.mockResolvedValue(undefined);
  mockGetQueriesData.mockReturnValue([]);
  mockFetch.mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({}) });
  mockBinsMutateAsync.mockResolvedValue(undefined);
  mockKeywordsMutateAsync.mockResolvedValue(undefined);
  mockBarcodesMutateAsync.mockResolvedValue(undefined);
  mockInvalidateAllCachesAfterSave.mockResolvedValue(undefined);
  mockEvictDeletedItemFromAllCaches.mockResolvedValue(undefined);
  // Restore the useNavigation mock implementation after clearAllMocks.
  const { useNavigation } = await import("expo-router");
  (useNavigation as jest.Mock).mockImplementation(() => ({
    addListener: jest.fn((event: string, cb: (e: BeforeRemoveEvent) => void) => {
      if (event === "beforeRemove") capturedBeforeRemove = cb;
      return jest.fn();
    }),
    dispatch: mockNavigationDispatch,
  }));
  const { useLocalSearchParams } = await import("expo-router");
  (useLocalSearchParams as jest.Mock).mockImplementation(
    () => ({ item: JSON.stringify(ITEM_FIXTURE), section: undefined }),
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
// F-040 — unsaved-changes guard via beforeRemove listener
// =============================================================================

describe("EditItemScreen — beforeRemove listener (F-040)", () => {
  const findNode = (result: Awaited<ReturnType<typeof render>>, predicate: (node: any) => boolean) =>
    result.root!.queryAll(predicate)[0];

  const findDescriptionInput = (result: Awaited<ReturnType<typeof render>>) =>
    findNode(result, n => n.type === "rn-textinput" && n.props.placeholder === "Brief description of the part…");

  const findButton = (result: Awaited<ReturnType<typeof render>>, label: string) =>
    findNode(result, n => n.type === "rn-pressable" && n.props.accessibilityLabel === label);

  const expectDiscardDialogVisible = (result: Awaited<ReturnType<typeof render>>) => {
    expect(result.root!.queryAll(n => n.type === "rn-modal")).toHaveLength(1);
    expect(result.root!.queryAll(n => n.type === "Text" && n.props.children === "Discard changes?")).toHaveLength(1);
  };

  const pressDialogButton = async (
    result: Awaited<ReturnType<typeof render>>,
    label: string,
  ) => {
    const button = findNode(
      result,
      n => n.type === "rn-pressable" && n.props.children?.props?.children === label,
    );
    expect(button).toBeDefined();
    await act(async () => { fireEvent.press(button!); });
  };

  it("registers a beforeRemove listener via useNavigation().addListener", async () => {
    const result = await renderScreen();
    activeTree = result;

    expect(capturedBeforeRemove).not.toBeNull();
  });

  it("allows navigation when no changes have been made", async () => {
    const result = await renderScreen();
    activeTree = result;

    const mockPreventDefault = jest.fn();
    await act(async () => {
      capturedBeforeRemove!({
        preventDefault: mockPreventDefault,
        data: { action: { type: "GO_BACK" } },
      });
    });

    expect(mockPreventDefault).not.toHaveBeenCalled();
  });

  it("leaves immediately from the header Back control when there are no changes", async () => {
    const result = await renderScreen();
    activeTree = result;

    const backButton = findButton(result, "Back");
    expect(backButton).toBeDefined();
    await act(async () => { fireEvent.press(backButton!); });

    expect(mockRouterBack).toHaveBeenCalledTimes(1);

    const cancelButton = findButton(result, "Cancel");
    expect(cancelButton).toBeDefined();
    await act(async () => { fireEvent.press(cancelButton!); });
    expect(mockRouterBack).toHaveBeenCalledTimes(2);
  });

  it("shows a visible dialog from Back, preserves edits when kept, and discards once", async () => {
    const result = await renderScreen();
    activeTree = result;

    const descInput = findDescriptionInput(result);
    expect(descInput).toBeDefined();
    await act(async () => { fireEvent.changeText(descInput!, "Changed description"); });

    const backButton = findButton(result, "Back");
    expect(backButton).toBeDefined();
    await act(async () => { fireEvent.press(backButton!); });

    expectDiscardDialogVisible(result);
    expect(mockRouterBack).not.toHaveBeenCalled();

    await pressDialogButton(result, "Keep Editing");
    expect(result.root!.queryAll(n => n.type === "rn-modal")).toHaveLength(0);
    expect(descInput!.props.value).toBe("Changed description");
    expect(mockRouterBack).not.toHaveBeenCalled();

    await act(async () => { fireEvent.press(backButton!); });
    expectDiscardDialogVisible(result);
    await pressDialogButton(result, "Discard");
    expect(mockRouterBack).toHaveBeenCalledTimes(1);

    const mockPreventDefault = jest.fn();
    await act(async () => {
      capturedBeforeRemove!({
        preventDefault: mockPreventDefault,
        data: { action: { type: "GO_BACK" } },
      });
    });
    expect(mockPreventDefault).not.toHaveBeenCalled();
  });

  it("shows the same dialog from footer Cancel and completes that exit once", async () => {
    const result = await renderScreen();
    activeTree = result;

    const descInput = findDescriptionInput(result);
    expect(descInput).toBeDefined();
    await act(async () => { fireEvent.changeText(descInput!, "Changed description"); });

    const cancelButton = findButton(result, "Cancel");
    expect(cancelButton).toBeDefined();
    await act(async () => { fireEvent.press(cancelButton!); });
    expectDiscardDialogVisible(result);
    expect(mockRouterBack).not.toHaveBeenCalled();
    await pressDialogButton(result, "Keep Editing");
    expect(descInput!.props.value).toBe("Changed description");
    expect(mockRouterBack).not.toHaveBeenCalled();

    await act(async () => { fireEvent.press(cancelButton!); });
    expectDiscardDialogVisible(result);
    await pressDialogButton(result, "Discard");

    expect(mockRouterBack).toHaveBeenCalledTimes(1);

    const mockPreventDefault2 = jest.fn();
    await act(async () => {
      capturedBeforeRemove!({
        preventDefault: mockPreventDefault2,
        data: { action: { type: "GO_BACK" } },
      });
    });
    expect(mockPreventDefault2).not.toHaveBeenCalled();
  });

  it("dispatches the original action when a blocked navigation is discarded", async () => {
    const result = await renderScreen();
    activeTree = result;

    const descInput = findDescriptionInput(result);
    expect(descInput).toBeDefined();
    await act(async () => { fireEvent.changeText(descInput!, "Changed description"); });

    const originalAction = { type: "GO_BACK" };
    const mockPreventDefault = jest.fn();
    await act(async () => {
      capturedBeforeRemove!({
        preventDefault: mockPreventDefault,
        data: { action: originalAction },
      });
    });

    expect(mockPreventDefault).toHaveBeenCalledTimes(1);
    expectDiscardDialogVisible(result);
    await pressDialogButton(result, "Discard");

    expect(mockNavigationDispatch).toHaveBeenCalledWith(originalAction);
    expect(mockNavigationDispatch).toHaveBeenCalledTimes(1);
  });
});
