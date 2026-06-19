/**
 * @jest-environment node
 *
 * Regression guard: WarehouseMapWeb pinned-aisle highlight styles.
 *
 * WarehouseMapWeb renders aisle tiles as Pressable elements whose style is a
 * function of the pressed state. This test resolves that function with
 * `pressed: false` and inspects the resulting style to verify that:
 *
 *   - Pinned aisles (in pinnedAisleNums):
 *       borderColor "#92400e"   (dark amber highlight)
 *       borderWidth 3           (thicker ring)
 *
 *   - Non-pinned aisles:
 *       borderColor "#d97706"   (standard amber)
 *       borderWidth 2
 *
 * If the highlight logic regresses (wrong colour, wrong width, or the
 * isPinned branch is removed), at least one of these assertions will fail.
 */

// Required for act() in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import renderer, { act } from "react-test-renderer";

// ─── react-native ─────────────────────────────────────────────────────────────
//
// Pressable's style is left as-is (may be a function) so the test can call it
// with { pressed: false } and inspect the resolved values.

jest.mock("react-native", () => {
  const React = require("react");
  return {
    Pressable: function Pressable({
      children,
      style,
      onPress,
    }: {
      children?: React.ReactNode;
      style?: unknown;
      onPress?: () => void;
    }) {
      return React.createElement("rn-pressable", { style, onPress }, children);
    },
    FlatList: function FlatList({
      data,
      renderItem,
      ListHeaderComponent,
      ListFooterComponent,
      ListEmptyComponent,
      keyExtractor,
    }: {
      data?: unknown[];
      renderItem?: (info: { item: unknown; index: number }) => React.ReactNode;
      ListHeaderComponent?: React.ReactNode;
      ListFooterComponent?: React.ReactNode;
      ListEmptyComponent?: React.ReactNode;
      keyExtractor?: (item: unknown, index: number) => string;
    }) {
      const items =
        data && data.length > 0 && renderItem
          ? data.map((item, index) => {
              const key = keyExtractor ? keyExtractor(item, index) : String(index);
              return React.createElement(React.Fragment, { key }, renderItem({ item, index }));
            })
          : (ListEmptyComponent ?? null);
      return React.createElement("rn-flatlist", {}, ListHeaderComponent, items, ListFooterComponent);
    },
    StyleSheet: {
      create: (s: unknown) => s,
      flatten: (s: unknown) => {
        if (!Array.isArray(s)) return (typeof s === "object" && s !== null ? s : {});
        return Object.assign(
          {},
          ...s.filter(Boolean).map((x: unknown) =>
            typeof x === "object" && x !== null ? x : {},
          ),
        );
      },
    },
    Text: function Text({ children }: { children?: React.ReactNode }) {
      return React.createElement("rn-text", {}, children);
    },
    useWindowDimensions: () => ({ width: 375, height: 812 }),
    View: function View({
      children,
      style,
    }: {
      children?: React.ReactNode;
      style?: unknown;
    }) {
      return React.createElement("rn-view", { style }, children);
    },
  };
});

// ─── @/hooks/useColors ────────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#fff",
    foreground: "#000",
    card: "#fff",
    border: "#ccc",
    muted: "#f1f5f9",
    mutedForeground: "#64748b",
  }),
}));

// ─── Suppress react-test-renderer deprecation warning ────────────────────────

let origConsoleError: typeof console.error;
beforeAll(() => {
  origConsoleError = console.error.bind(console);
  jest.spyOn(console, "error").mockImplementation(
    (msg: unknown, ...args: unknown[]) => {
      if (
        typeof msg === "string" &&
        (msg.includes("react-test-renderer is deprecated") ||
          msg.includes("Warning:"))
      )
        return;
      origConsoleError(msg, ...args);
    },
  );
});
afterAll(() => {
  (console.error as jest.Mock).mockRestore?.();
});

// ─── Subject under test ───────────────────────────────────────────────────────

import { WarehouseMapWeb } from "@/components/WarehouseMapWeb";
import type { InventoryItem } from "@workspace/api-client-react";

// ─── Helpers ──────────────────────────────────────────────────────────────────

type Inst = renderer.ReactTestInstance;

/**
 * Flatten a React Native style value (array or object) into a plain object.
 * Duplicate keys are resolved last-write-wins, matching RN's own behaviour.
 */
function flattenStyle(raw: unknown): Record<string, unknown> {
  if (Array.isArray(raw)) {
    return Object.assign(
      {},
      ...raw
        .filter(Boolean)
        .map((x) => (typeof x === "object" && x !== null ? x : {})),
    );
  }
  if (typeof raw === "object" && raw !== null)
    return raw as Record<string, unknown>;
  return {};
}

/**
 * Resolve a Pressable's style prop. The component passes a function
 * `({ pressed }) => StyleProp<ViewStyle>` — call it with pressed=false to get
 * the idle-state style object.
 */
function resolveStyle(styleProp: unknown): Record<string, unknown> {
  if (typeof styleProp === "function") {
    return flattenStyle((styleProp as (s: { pressed: boolean }) => unknown)({ pressed: false }));
  }
  return flattenStyle(styleProp);
}

/** Find all rn-pressable nodes whose resolved (idle) style contains a key=value match. */
function pressablesWithStyle(
  root: Inst,
  key: string,
  value: unknown,
): Inst[] {
  return root
    .findAll((n) => (n.type as string) === "rn-pressable")
    .filter((n) => {
      const s = resolveStyle((n.props as { style?: unknown }).style);
      return s[key] === value;
    });
}

function makeItem(id: number, binLocations: string[]): InventoryItem {
  return {
    id,
    vendor: "V",
    catalog: `P-${id}`,
    description: `Part ${id}`,
    binLocations,
    aiKeywords: [],
    enrichedAt: null,
  } as unknown as InventoryItem;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// Two aisles so we can verify both the pinned and non-pinned branches.
const INVENTORY: InventoryItem[] = [
  makeItem(1, ["01-01-001"]),
  makeItem(2, ["02-01-001"]),
];

const PINNED_SET = new Set([1]); // only aisle 1 is pinned

const NOOP = jest.fn();

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("WarehouseMapWeb — pinned-aisle highlight styles", () => {
  let tree: renderer.ReactTestRenderer;

  beforeEach(() => {
    jest.clearAllMocks();
    act(() => {
      tree = renderer.create(
        <WarehouseMapWeb
          inventory={INVENTORY}
          onAislePress={NOOP}
          pinnedAisleNums={PINNED_SET}
        />,
      );
    });
  });

  afterEach(() => {
    act(() => {
      tree.unmount();
    });
  });

  // ── Pinned tile ────────────────────────────────────────────────────────────

  it("pinned aisle tile uses borderColor #92400e (dark amber highlight)", () => {
    const tiles = pressablesWithStyle(tree.root, "borderColor", "#92400e");
    expect(tiles.length).toBeGreaterThanOrEqual(1);
  });

  it("pinned aisle tile uses borderWidth 3 (wider ring)", () => {
    // Locate the tile by its highlight borderColor, then confirm borderWidth.
    const tiles = pressablesWithStyle(tree.root, "borderColor", "#92400e");
    expect(tiles.length).toBeGreaterThanOrEqual(1);

    const s = resolveStyle((tiles[0]!.props as { style?: unknown }).style);
    expect(s.borderWidth).toBe(3);
  });

  // ── Non-pinned tile ────────────────────────────────────────────────────────

  it("non-pinned aisle tile uses borderColor #d97706 (standard amber)", () => {
    const tiles = pressablesWithStyle(tree.root, "borderColor", "#d97706");
    expect(tiles.length).toBeGreaterThanOrEqual(1);
  });

  it("non-pinned aisle tile uses borderWidth 2 (standard width)", () => {
    const tiles = pressablesWithStyle(tree.root, "borderColor", "#d97706");
    expect(tiles.length).toBeGreaterThanOrEqual(1);

    const s = resolveStyle((tiles[0]!.props as { style?: unknown }).style);
    expect(s.borderWidth).toBe(2);
  });

  // ── Cardinality ───────────────────────────────────────────────────────────

  it("exactly one aisle tile carries the pinned highlight colour", () => {
    // With pinnedAisleNums = {1} and two aisles, only one tile should be highlighted.
    const pinnedTiles = pressablesWithStyle(tree.root, "borderColor", "#92400e");
    expect(pinnedTiles).toHaveLength(1);
  });

  it("exactly one aisle tile carries the standard (non-pinned) colour", () => {
    const standardTiles = pressablesWithStyle(tree.root, "borderColor", "#d97706");
    expect(standardTiles).toHaveLength(1);
  });
});
