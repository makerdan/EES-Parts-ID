/**
 * @jest-environment node
 *
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
import renderer, { act } from "react-test-renderer";
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

jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#fff",  foreground: "#000",  card: "#fff",
    border: "#ccc",      primary: "#3b82f6",  primaryForeground: "#fff",
    muted: "#f1f5f9",    mutedForeground: "#64748b",
    destructive: "#ef4444", success: "#22c55e", warning: "#f59e0b",
    accent: "#f1f5f9",   accentForeground: "#000",
  }),
}));

jest.mock("@/components/DismissKeyboard", () => ({
  DismissKeyboard: ({ children }: { children: React.ReactNode }) =>
    children as React.ReactElement,
}));

jest.mock("@/components/MeasurePartScreen", () => ({
  MeasurePartScreen: () => null,
}));

jest.mock("@/utils/editItemCache", () => ({
  invalidateListCache:          jest.fn().mockResolvedValue(undefined),
  invalidateAllCachesAfterSave: jest.fn().mockResolvedValue(undefined),
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
  useRouter:           jest.fn(() => ({ replace: jest.fn(), back: jest.fn() })),
  useLocalSearchParams: jest.fn(() => ({})),
  useFocusEffect:      jest.fn(),
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

type Inst = renderer.ReactTestInstance;

function findByA11yLabel(root: Inst, label: string): Inst | null {
  return (
    root
      .findAll(n => n.props.accessibilityLabel === label, { deep: true })
      .at(0) ?? null
  );
}

async function renderUI(ui: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => { tree = renderer.create(ui); });
  return tree;
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

let activeTree: renderer.ReactTestRenderer | null = null;

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
    const tree = await renderUI(
      <PartDetailsEditor
        item={item}
        adminToken={null}
        onClose={jest.fn()}
      />
    );
    activeTree = tree;

    const deleteBtn = findByA11yLabel(tree.root, "Delete this part");
    expect(deleteBtn).toBeNull();
  });

  it("DOES render the delete button when adminToken is provided", async () => {
    const item = makeItem();
    const tree = await renderUI(
      <PartDetailsEditor
        item={item}
        adminToken="test-admin-token"
        onClose={jest.fn()}
      />
    );
    activeTree = tree;

    const deleteBtn = findByA11yLabel(tree.root, "Delete this part");
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
    const tree = await renderUI(<EditItemScreen />);
    activeTree = tree;

    const deleteBtn = findByA11yLabel(tree.root, "Delete this part");
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
    const tree = await renderUI(<EditItemScreen />);
    activeTree = tree;

    const deleteBtn = findByA11yLabel(tree.root, "Delete this part");
    expect(deleteBtn).not.toBeNull();
  });
});
