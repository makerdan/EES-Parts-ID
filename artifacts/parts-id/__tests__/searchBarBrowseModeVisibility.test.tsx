/**
 * @jest-environment node
 *
 * Regression guard: the persistent search bar (KeyboardDoneInput + Search/Clear
 * buttons) and the AI "Searched as:" chip row must be hidden when the user
 * switches to aisle or category browse mode, and visible in the default search
 * mode.
 *
 * Covers:
 *   1. Search bar is rendered in the default "search" mode.
 *   2. Search bar is absent after switching to "aisle" mode.
 *   3. Search bar is absent after switching to "category" mode.
 *   4. Invoking BrowseByAisle's onClose prop returns to search mode (search bar re-appears).
 *   5. Invoking BrowseByCategory's onClose prop returns to search mode (search bar re-appears).
 */

// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

// ─── AsyncStorage ──────────────────────────────────────────────────────────────

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem:    jest.fn().mockResolvedValue(null),
    setItem:    jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
    multiGet:   jest.fn().mockResolvedValue([]),
    multiSet:   jest.fn().mockResolvedValue(undefined),
    clear:      jest.fn().mockResolvedValue(undefined),
  },
}));

// ─── expo-router ───────────────────────────────────────────────────────────────

jest.mock("expo-router", () => ({
  router: { navigate: jest.fn(), push: jest.fn(), replace: jest.fn() },
  useFocusEffect: (cb: () => (() => void) | void) => {
    const cleanup = cb();
    return cleanup ?? undefined;
  },
}));

// ─── fuse.js ───────────────────────────────────────────────────────────────────

jest.mock("fuse.js", () => {
  return jest.fn().mockImplementation(() => ({
    search: jest.fn().mockReturnValue([]),
    setCollection: jest.fn(),
  }));
});

// ─── @workspace/api-client-react ──────────────────────────────────────────────

jest.mock("@workspace/api-client-react", () => ({
  useSearchInventory: jest.fn(() => ({
    isPending: false,
    mutateAsync: jest.fn().mockResolvedValue({ results: [], total: 0 }),
  })),
}));

// ─── @expo/vector-icons ────────────────────────────────────────────────────────

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
  MaterialCommunityIcons: () => null,
}));

// ─── AppContext override (needs more fields than the shared mock) ───────────────

const DEFAULT_SETTINGS = {
  textSize: "normal",
  defaultConfidenceThreshold: 50,
  themeMode: "system",
  shelfViewEnabled: true,
  scanSound: true,
  dimensionUnit: "mm",
};

jest.mock("@/contexts/AppContext", () => ({
  DEFAULT_SETTINGS,
  useApp: jest.fn(() => ({
    settings: { ...DEFAULT_SETTINGS },
    updateSetting: jest.fn(),
    logout: jest.fn(),
    clearCache: jest.fn(),
    textFontScale: 1,
    isLoading: false,
    isAdmin: false,
    adminToken: null,
    registerLogoutHandler: jest.fn(() => jest.fn()),
    setPendingMapFocus: jest.fn(),
    showToast: jest.fn(),
    setPinnedParts: jest.fn(),
    pendingMeasureSearch: null,
    setPendingMeasureSearch: jest.fn(),
    pendingInventorySearch: null,
    setPendingInventorySearch: jest.fn(),
  })),
}));

// ─── useColors ─────────────────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#fff",
    foreground: "#000",
    card: "#fff",
    border: "#ccc",
    primary: "#3b82f6",
    primaryForeground: "#fff",
    muted: "#f1f5f9",
    mutedForeground: "#64748b",
    destructive: "#ef4444",
    success: "#22c55e",
    warning: "#f59e0b",
    accent: "#f1f5f9",
    accentForeground: "#000",
  }),
}));

// ─── KeyboardDoneInput — renders a tagged element so we can find it by placeholder

jest.mock("@/components/KeyboardDoneInput", () => ({
  KeyboardDoneInput: function KDI(props: Record<string, unknown>) {
    const React = require("react");
    return React.createElement("rn-text-input", { placeholder: props.placeholder });
  },
}));

// ─── Heavy child components — stub with a discoverable sentinel element ────────
//
// Each stub renders a uniquely-typed host element that carries the onClose prop
// so tests can retrieve and invoke it directly without relying on UI buttons
// inside the real (heavy) component.

jest.mock("@/components/BrowseByAisle", () => ({
  BrowseByAisle: function BrowseByAisleStub(props: Record<string, unknown>) {
    const React = require("react");
    return React.createElement("browse-by-aisle-stub", { onClose: props.onClose });
  },
}));

jest.mock("@/components/BrowseByCategory", () => ({
  BrowseByCategory: function BrowseByCategoryStub(props: Record<string, unknown>) {
    const React = require("react");
    return React.createElement("browse-by-category-stub", { onClose: props.onClose });
  },
}));

jest.mock("@/components/AISearchFallback", () => ({
  AIZeroResultsCard: () => null,
  SearchedAsRow: () => null,
}));

jest.mock("@/components/FilterPanel", () => ({
  FilterPanel: () => null,
  ConfidenceSlider: () => null,
}));

jest.mock("@/components/MeasurePartScreen", () => ({
  MeasurePartScreen: () => null,
}));

jest.mock("@/components/PartDetailsEditor", () => ({
  PartDetailsEditor: () => null,
}));

jest.mock("@/components/RecentSearchesPanel", () => ({
  RecentSearchesPanel: () => null,
}));

jest.mock("@/components/ReferenceModal", () => ({
  ReferenceModal: () => null,
}));

jest.mock("@/components/ResultCard", () => ({
  ResultCard: () => null,
}));

// ─── Utility stubs ─────────────────────────────────────────────────────────────

jest.mock("@/lib/aisleHierarchy", () => ({
  parseBin: jest.fn().mockReturnValue(null),
}));

jest.mock("@/styles/shared", () => ({
  secondaryBtnBase: {},
}));

jest.mock("@/utils/apiBase", () => ({
  API_BASE: "http://localhost:3000",
}));

jest.mock("@/utils/appAuth", () => ({
  fetchWithAuth: jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
}));

jest.mock("@/utils/offlineBarcode", () => ({
  FUSE_CACHE_KEY: "fuse_cache",
  FUSE_CACHE_SYNCED_AT_KEY: "fuse_synced_at",
  FUSE_SYNC_MAX_AGE_MS: 3_600_000,
  getFuseCacheSyncedAt: jest.fn().mockResolvedValue(null),
}));

jest.mock("@/utils/queryCacheBound", () => ({
  QUERY_CACHE_MAX_ENTRIES: 50,
  evictLRU: jest.fn((cache: unknown) => cache),
}));

jest.mock("@/utils/retryAsync", () => ({
  retryAsync: jest.fn((fn: () => unknown) => fn()),
}));

jest.mock("@/utils/searchHelpers", () => ({
  buildQueryKey: jest.fn(() => "key"),
  buildSearchBody: jest.fn(() => ({})),
  fetchInventoryPages: jest.fn().mockResolvedValue([]),
  formatRelativeAge: jest.fn(() => "just now"),
  formatStaleCacheWarning: jest.fn(() => ""),
  pruneExpired: jest.fn((c: unknown) => c),
  QUERY_CACHE_KEY: "parts_id_query_cache_v1",
  resolveOfflineFallback: jest.fn().mockResolvedValue({ results: [], total: 0 }),
}));

jest.mock("@/utils/searchHistory", () => ({
  appendQueryHistory:  jest.fn().mockResolvedValue(undefined),
  appendViewedHistory: jest.fn().mockResolvedValue(undefined),
  clearQueryHistory:   jest.fn().mockResolvedValue(undefined),
  clearViewedHistory:  jest.fn().mockResolvedValue(undefined),
  loadQueryHistory:    jest.fn().mockResolvedValue([]),
  loadViewedHistory:   jest.fn().mockResolvedValue([]),
}));

jest.mock("@/utils/searchResetEvent", () => ({
  searchResetEvent: {
    subscribe: jest.fn(() => jest.fn()),
    emit: jest.fn(),
  },
}));

jest.mock("@/utils/storageErrorReporter", () => ({
  reportStorageError: jest.fn(),
}));

jest.mock("@/utils/translateQuery", () => ({
  runTranslateQuery: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/utils/useTrackScreen", () => ({
  useTrackScreen: jest.fn(),
}));

// ─── Imports (after all mocks) ────────────────────────────────────────────────

import React from "react";
import renderer, { act } from "react-test-renderer";
import SearchScreen from "../app/(tabs)/index";

// ─── Suppress react-test-renderer deprecation noise ───────────────────────────

let origConsoleError: typeof console.error;
beforeAll(() => {
  origConsoleError = console.error.bind(console);
  jest.spyOn(console, "error").mockImplementation(
    (msg: unknown, ...rest: unknown[]) => {
      if (
        typeof msg === "string" &&
        (msg.includes("react-test-renderer is deprecated") ||
          msg.includes("Warning:"))
      ) return;
      origConsoleError(msg, ...rest);
    },
  );
});
afterAll(() => {
  (console.error as jest.Mock).mockRestore?.();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

type Inst = renderer.ReactTestInstance;

const SEARCH_PLACEHOLDER = "Search parts — keyword, catalog #, vendor…";

/** Returns true when the search bar input is present in the tree. */
function hasSearchBar(root: Inst): boolean {
  return root.findAll(
    (n) =>
      (n.type as string) === "rn-text-input" &&
      (n.props as { placeholder?: string }).placeholder === SEARCH_PLACEHOLDER,
    { deep: true },
  ).length > 0;
}

/**
 * Find the first rn-pressable whose rn-text descendant contains the given label.
 */
function findPressableByLabel(root: Inst, label: string): Inst | null {
  function textOf(node: Inst): string {
    if ((node.type as string) === "rn-text") {
      const c = (node.props as { children?: unknown }).children;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) return c.filter((x) => typeof x === "string").join("");
    }
    return node.children
      .filter((ch): ch is Inst => typeof ch !== "string")
      .map(textOf)
      .join("");
  }

  let found: Inst | null = null;

  function walk(node: Inst) {
    if (found) return;
    if ((node.type as string) === "rn-pressable" && textOf(node).includes(label)) {
      found = node;
      return;
    }
    node.children.forEach((ch) => { if (typeof ch !== "string") walk(ch as Inst); });
  }

  walk(root);
  return found;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SearchScreen — search bar visibility by mode", () => {
  it("renders the search bar in the default search mode", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SearchScreen />);
    });

    expect(hasSearchBar(tree.root)).toBe(true);

    await act(async () => { tree.unmount(); });
  });

  it("hides the search bar after switching to aisle mode", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SearchScreen />);
    });

    // Search bar must be present before the switch.
    expect(hasSearchBar(tree.root)).toBe(true);

    // Press the "By Aisle" mode toggle button.
    const aisleBtn = findPressableByLabel(tree.root, "By Aisle");
    expect(aisleBtn).not.toBeNull();

    await act(async () => {
      (aisleBtn!.props as { onPress?: () => void }).onPress?.();
    });

    // Search bar must be gone in aisle mode.
    expect(hasSearchBar(tree.root)).toBe(false);

    await act(async () => { tree.unmount(); });
  });

  it("hides the search bar after switching to category mode", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SearchScreen />);
    });

    expect(hasSearchBar(tree.root)).toBe(true);

    const categoryBtn = findPressableByLabel(tree.root, "By Category");
    expect(categoryBtn).not.toBeNull();

    await act(async () => {
      (categoryBtn!.props as { onPress?: () => void }).onPress?.();
    });

    expect(hasSearchBar(tree.root)).toBe(false);

    await act(async () => { tree.unmount(); });
  });

  it("restores the search bar when BrowseByAisle's onClose is invoked", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SearchScreen />);
    });

    // Switch to aisle mode — search bar disappears.
    const aisleBtn = findPressableByLabel(tree.root, "By Aisle");
    expect(aisleBtn).not.toBeNull();
    await act(async () => {
      (aisleBtn!.props as { onPress?: () => void }).onPress?.();
    });
    expect(hasSearchBar(tree.root)).toBe(false);

    // Find the BrowseByAisle sentinel element and invoke its onClose prop directly.
    const stub = tree.root.findAll(
      (n) => (n.type as string) === "browse-by-aisle-stub",
      { deep: true },
    );
    expect(stub.length).toBeGreaterThan(0);
    const onClose = (stub[0].props as { onClose?: () => void }).onClose;
    expect(typeof onClose).toBe("function");

    await act(async () => {
      onClose!();
    });

    // Search bar must be back in the tree now that mode is "search" again.
    expect(hasSearchBar(tree.root)).toBe(true);

    await act(async () => { tree.unmount(); });
  });

  it("restores the search bar when BrowseByCategory's onClose is invoked", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SearchScreen />);
    });

    // Switch to category mode — search bar disappears.
    const categoryBtn = findPressableByLabel(tree.root, "By Category");
    expect(categoryBtn).not.toBeNull();
    await act(async () => {
      (categoryBtn!.props as { onPress?: () => void }).onPress?.();
    });
    expect(hasSearchBar(tree.root)).toBe(false);

    // Find the BrowseByCategory sentinel element and invoke its onClose prop directly.
    const stub = tree.root.findAll(
      (n) => (n.type as string) === "browse-by-category-stub",
      { deep: true },
    );
    expect(stub.length).toBeGreaterThan(0);
    const onClose = (stub[0].props as { onClose?: () => void }).onClose;
    expect(typeof onClose).toBe("function");

    await act(async () => {
      onClose!();
    });

    // Search bar must be back in the tree now that mode is "search" again.
    expect(hasSearchBar(tree.root)).toBe(true);

    await act(async () => { tree.unmount(); });
  });
});
