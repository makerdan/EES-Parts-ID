/**
 * Rendered regression coverage for the administrator inventory edit workflow.
 *
 * This suite mounts the real EditItemScreen, changes the description through
 * its controlled input, persists it through the screen's authenticated PATCH,
 * verifies the synchronous cache update and success state, then remounts the
 * screen from the persisted item. Failure and protected-state assertions stay
 * in this same workflow suite so they cannot regress independently of the
 * screen that owns the behavior.
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";
import type {
  InventoryItem,
  InventoryListResponse,
  SearchInventoryResponse,
} from "@workspace/api-client-react";
import { useApp } from "@/contexts/AppContext";

// ─── Mutable test doubles ─────────────────────────────────────────────────────

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;
const mockUseApp = useApp as unknown as jest.Mock;
const mockSetQueriesData = jest.fn();
const mockSetQueryData = jest.fn();
const mockInvalidateAllCachesAfterSave = jest.fn().mockResolvedValue(undefined);
const mockInvalidateListCache = jest.fn().mockResolvedValue(undefined);
const mockRouter = { back: jest.fn(), replace: jest.fn() };
const mockNavigation = {
  addListener: jest.fn(() => jest.fn()),
  dispatch: jest.fn(),
};

let serverItem: InventoryItem;
let routeItem: InventoryItem | null;
let failDescriptionSave = false;
let inventoryCache: InventoryListResponse;
let searchCache: SearchInventoryResponse;

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock("@/components/PartPhotoPicker", () => ({
  PartPhotoPicker: () => null,
}));

jest.mock("@/components/MeasurePartScreen", () => ({
  MeasurePartScreen: () => null,
}));

jest.mock("@/components/KeyboardDoneInput", () => {
  const R = require("react") as typeof React;
  return {
    KeyboardDoneInput: (props: Record<string, unknown>) =>
      R.createElement("rn-textinput", props),
  };
});

jest.mock("@workspace/api-client-react", () => ({
  getListInventoryQueryKey: jest.fn(() => ["inventory"]),
  useUpdateItemBins: jest.fn(() => ({ mutateAsync: jest.fn().mockResolvedValue(undefined) })),
  useUpdateItemBarcodes: jest.fn(() => ({ mutateAsync: jest.fn().mockResolvedValue(undefined) })),
  useUpdateItemKeywords: jest.fn(() => ({ mutateAsync: jest.fn().mockResolvedValue(undefined) })),
}));

jest.mock("@tanstack/react-query", () => ({
  useQueryClient: jest.fn(() => ({
    getQueriesData: (filters: { predicate: (query: { queryKey: unknown[] }) => boolean }) => {
      const listQuery = { queryKey: ["inventory"] };
      return filters.predicate(listQuery)
        ? [[listQuery.queryKey, inventoryCache]]
        : [[["searchInventory"], searchCache]];
    },
    setQueriesData: (...args: unknown[]) => {
      mockSetQueriesData(...args);
      const [filters, updater] = args as [
        { predicate: (query: { queryKey: unknown[] }) => boolean },
        (old: unknown) => unknown,
      ];
      if (filters.predicate({ queryKey: ["inventory"] })) {
        inventoryCache = updater(inventoryCache) as InventoryListResponse;
      } else if (filters.predicate({ queryKey: ["searchInventory"] })) {
        searchCache = updater(searchCache) as SearchInventoryResponse;
      }
    },
    setQueryData: (...args: unknown[]) => {
      mockSetQueryData(...args);
    },
    invalidateQueries: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("@/utils/editItemCache", () => ({
  evictDeletedItemFromAllCaches: jest.fn().mockResolvedValue(undefined),
  invalidateAllCachesAfterSave: (...args: unknown[]) => mockInvalidateAllCachesAfterSave(...args),
  invalidateListCache: (...args: unknown[]) => mockInvalidateListCache(...args),
}));

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

jest.mock("@expo/vector-icons", () => require("./helpers/mapMocks").createVectorIconsMock());

jest.mock("expo-camera", () => ({
  CameraView: () => null,
  useCameraPermissions: jest.fn(() => [{ granted: false }, jest.fn()]),
}));

jest.mock("lidar-measure", () => ({
  isLiDARSupported: jest.fn(() => false),
}));

jest.mock("@/utils/apiBase", () => ({
  API_BASE: "http://localhost:8080/api",
  API_ORIGIN: "http://localhost:8080",
}));

jest.mock("@/utils/useTrackScreen", () => ({
  useTrackScreen: jest.fn(),
}));

jest.mock("@/utils/adminGuard", () => ({
  shouldRedirectNonAdmin: jest.fn(() => false),
}));

jest.mock("expo-router", () => ({
  useRouter: jest.fn(() => mockRouter),
  useLocalSearchParams: jest.fn(() => (
    routeItem ? { item: JSON.stringify(routeItem) } : {}
  )),
  useFocusEffect: jest.fn(),
  useNavigation: jest.fn(() => mockNavigation),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

type Inst = TestInstance;

function makeItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 42,
    catalog: "EDIT-WORKFLOW",
    description: "Original description",
    vendor: "ACME",
    binLocations: ["AISLE-01"],
    aiKeywords: ["relay"],
    barcodes: [],
    dimensions: null,
    imageUrl: null,
    imageUrl2: null,
    ...overrides,
  } as unknown as InventoryItem;
}

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  };
}

function instText(node: Inst | string): string {
  if (typeof node === "string") return node;
  return (node.children ?? [])
    .map((child) => instText(child as Inst | string))
    .join("");
}

function findTextInput(root: Inst, placeholder: string): Inst | null {
  return root.queryAll(
    (node: TestInstance) =>
      (node.type as string) === "rn-textinput" &&
      (node.props.placeholder === placeholder || node.props.testID === placeholder),
    { includeSelf: true },
  )[0] ?? null;
}

function findPressable(root: Inst, label: string): Inst | null {
  return root.queryAll(
    (node: TestInstance) =>
      (node.type as string) === "rn-pressable" &&
      instText(node).includes(label),
    { includeSelf: true },
  )[0] ?? null;
}

function findByA11yLabel(root: Inst, label: string): Inst | null {
  return root.queryAll(
    (node: TestInstance) => node.props.accessibilityLabel === label,
    { includeSelf: true },
  )[0] ?? null;
}

function hasText(root: Inst, value: string): boolean {
  return instText(root).includes(value);
}

async function renderScreen() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const EditItemScreen = require("@/app/edit-item").default as React.ComponentType;
  return render(<EditItemScreen />);
}

function makeCaches(item: InventoryItem) {
  inventoryCache = {
    items: [{ ...item }],
    total: 1,
  } as unknown as InventoryListResponse;
  searchCache = {
    results: [{ item: { ...item }, score: 1 }],
    sizeUnknownResults: [],
  } as unknown as SearchInventoryResponse;
}

// ─── Per-test setup ──────────────────────────────────────────────────────────

let activeTree: Awaited<ReturnType<typeof render>> | null = null;

beforeEach(() => {
  jest.useFakeTimers();
  serverItem = makeItem();
  routeItem = { ...serverItem };
  failDescriptionSave = false;
  makeCaches(serverItem);

  mockUseApp.mockReturnValue({
    adminToken: "admin-test-token",
    isAdmin: true,
    isLoading: false,
    pendingLidarDims: null,
    setPendingLidarDims: jest.fn(),
  });

  mockFetch.mockReset();
  global.fetch = mockFetch as unknown as typeof fetch;
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith(`/inventory/${serverItem.id}/description`) && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as { description: string };
      if (failDescriptionSave) {
        return response({ error: "Description save unavailable" }, 503);
      }
      serverItem = { ...serverItem, description: body.description };
      return response({ id: serverItem.id, description: serverItem.description });
    }
    return response({});
  });

  mockSetQueriesData.mockClear();
  mockSetQueryData.mockClear();
  mockInvalidateAllCachesAfterSave.mockClear();
  mockInvalidateAllCachesAfterSave.mockResolvedValue(undefined);
  mockInvalidateListCache.mockClear();
  mockInvalidateListCache.mockResolvedValue(undefined);
  mockRouter.back.mockClear();
  mockRouter.replace.mockClear();
  mockNavigation.addListener.mockClear();
  mockNavigation.dispatch.mockClear();
});

afterEach(async () => {
  if (activeTree) {
    await activeTree.unmount();
    activeTree = null;
  }
  jest.useRealTimers();
  jest.clearAllMocks();
});

// =============================================================================
// Full admin workflow
// =============================================================================

describe("EditItemScreen — administrator inventory edit workflow", () => {
  it("loads, saves through the authenticated API, patches caches, and shows the persisted value after reload", async () => {
    activeTree = await renderScreen();

    const descriptionInput = findTextInput(activeTree.root!, "Brief description of the part…");
    expect(descriptionInput).not.toBeNull();
    expect(descriptionInput!.props.value).toBe("Original description");

    await act(async () => {
      fireEvent.changeText(descriptionInput!, "Persisted workflow description");
    });
    expect(findTextInput(activeTree.root!, "Brief description of the part…")!.props.value)
      .toBe("Persisted workflow description");

    const saveButton = findPressable(activeTree.root!, "Save Details");
    expect(saveButton).not.toBeNull();
    expect(saveButton!.props.disabled).toBe(false);
    expect(typeof saveButton!.props.onPress).toBe("function");
    await act(async () => {
      await (saveButton!.props.onPress as () => Promise<void>)();
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8080/api/inventory/42/description",
      expect.objectContaining({
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer admin-test-token",
        },
        body: JSON.stringify({ description: "Persisted workflow description" }),
      }),
    );
    expect(mockInvalidateAllCachesAfterSave).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 42 }),
    );
    expect(mockSetQueriesData).toHaveBeenCalledTimes(2);
    expect(inventoryCache.items[0]!.description).toBe("Persisted workflow description");
    expect(searchCache.results[0]!.item.description).toBe("Persisted workflow description");
    expect(hasText(activeTree.root!, "✓ Saved")).toBe(true);

    // Remount from the record held by the fake server, rather than relying on
    // the prior component state, to prove a later item view sees persistence.
    await activeTree.unmount();
    activeTree = null;
    routeItem = { ...serverItem };
    activeTree = await renderScreen();

    const reloadedInput = findTextInput(activeTree.root!, "Brief description of the part…");
    expect(reloadedInput).not.toBeNull();
    expect(reloadedInput!.props.value).toBe("Persisted workflow description");
  });

  it("rolls the edited field back and shows actionable feedback when the save is rejected", async () => {
    failDescriptionSave = true;
    activeTree = await renderScreen();

    const descriptionInput = findTextInput(activeTree.root!, "Brief description of the part…");
    expect(descriptionInput).not.toBeNull();
    await act(async () => {
      fireEvent.changeText(descriptionInput!, "This must not persist");
    });
    expect(findTextInput(activeTree.root!, "Brief description of the part…")!.props.value)
      .toBe("This must not persist");

    await act(async () => {
      const saveButton = findPressable(activeTree!.root!, "Save Details");
      await (saveButton!.props.onPress as () => Promise<void>)();
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(descriptionInput!.props.value).toBe("Original description");
    expect(hasText(activeTree.root!, "Description failed")).toBe(true);
    expect(hasText(activeTree.root!, "✓ Saved")).toBe(false);
    expect(inventoryCache.items[0]!.description).toBe("Original description");
    expect(serverItem.description).toBe("Original description");
  });
});

// =============================================================================
// Protected paths
// =============================================================================

describe("EditItemScreen — protected inventory mutations", () => {
  it("does not expose delete and does not invoke a protected save for a non-admin", async () => {
    mockUseApp.mockReturnValue({
      adminToken: null,
      isAdmin: false,
      isLoading: false,
      pendingLidarDims: null,
      setPendingLidarDims: jest.fn(),
    });
    activeTree = await renderScreen();

    expect(findByA11yLabel(activeTree.root!, "Delete this part")).toBeNull();

    const descriptionInput = findTextInput(activeTree.root!, "Brief description of the part…");
    await act(async () => {
      fireEvent.changeText(descriptionInput!, "Unauthorized change");
      fireEvent.press(findPressable(activeTree!.root!, "Save Details")!);
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(hasText(activeTree.root!, "Admin session expired")).toBe(true);
  });

  it("does not expose or invoke delete when the route contains no item", async () => {
    routeItem = null;
    activeTree = await renderScreen();

    expect(hasText(activeTree.root!, "Item not found.")).toBe(true);
    expect(findByA11yLabel(activeTree.root!, "Delete this part")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});