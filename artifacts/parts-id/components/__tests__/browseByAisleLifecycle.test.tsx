/**
 * Lifecycle regressions for BrowseByAisle.
 *
 * A browse overlay is controlled by its parent, so closing it unmounts the
 * component while a pull-to-refresh request or the delayed section highlight
 * may still be pending. Neither callback may update the closed screen.
 */

// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

import React, { useState } from "react";
import { act, render } from "@testing-library/react-native";
import type { RenderResult } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";
import type { InventoryItem } from "@workspace/api-client-react";

// Keep this suite focused on BrowseByAisle instead of pulling in the rest of
// the app's native component graph.
jest.mock("react-native", () => {
  const R = require("react");
  const make = (tag: string) =>
    function NativeMock({ children, ...props }: Record<string, unknown>) {
      return R.createElement(tag, props, children);
    };

  const AnimatedValue = class {
    _value: number;
    constructor(value: number) { this._value = value; }
    setValue(value: number) { this._value = value; }
    interpolate() { return this; }
  };
  const animation = () => ({ start: (callback?: () => void) => callback?.(), stop: jest.fn() });

  return {
    ActivityIndicator: make("rn-activity"),
    Animated: {
      Value: AnimatedValue,
      View: make("rn-animated-view"),
      timing: animation,
    },
    BackHandler: {
      addEventListener: jest.fn(() => ({ remove: jest.fn() })),
    },
    FlatList: function FlatList({
      data,
      renderItem,
      keyExtractor,
      ListHeaderComponent,
      ListFooterComponent,
      refreshControl,
    }: {
      data?: unknown[];
      renderItem?: (args: { item: unknown; index: number }) => React.ReactNode;
      keyExtractor?: (item: unknown, index: number) => string;
      ListHeaderComponent?: React.ReactNode;
      ListFooterComponent?: React.ReactNode;
      refreshControl?: React.ReactNode;
    }) {
      const children = [
        refreshControl,
        typeof ListHeaderComponent === "function"
          ? R.createElement(ListHeaderComponent as React.ComponentType)
          : ListHeaderComponent,
        ...(data ?? []).map((item, index) => {
          const element = renderItem?.({ item, index });
          return React.isValidElement(element)
            ? R.cloneElement(element, { key: keyExtractor?.(item, index) ?? String(index) })
            : element;
        }),
        typeof ListFooterComponent === "function"
          ? R.createElement(ListFooterComponent as React.ComponentType)
          : ListFooterComponent,
      ];
      return R.createElement("rn-flat-list", null, ...children);
    },
    PanResponder: {
      create: () => ({ panHandlers: {} }),
    },
    Platform: { OS: "ios" },
    Pressable: make("rn-pressable"),
    RefreshControl: make("rn-refresh-control"),
    StyleSheet: {
      create: (styles: unknown) => styles,
      hairlineWidth: 0.5,
    },
    Text: make("Text"),
    View: make("rn-view"),
  };
});


jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("@/components/AddPartModal", () => ({ AddPartModal: () => null }));
jest.mock("@/components/ResultCard", () => ({ ResultCard: () => null }));
jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#fff",
    foreground: "#111",
    card: "#f9f9f9",
    border: "#ddd",
    primary: "#007aff",
    primaryForeground: "#fff",
    muted: "#f0f0f0",
    mutedForeground: "#888",
    success: "#10b981",
    destructive: "#ef4444",
  }),
}));

import { BrowseByAisle } from "../BrowseByAisle";

const inventory = [{
  id: 1,
  catalog: "PART-001",
  vendor: "ACME",
  description: "Lifecycle test part",
  aiKeywords: [],
  binLocations: ["01-02-100"],
  barcodes: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}] as unknown as InventoryItem[];

type Root = NonNullable<RenderResult["root"]>;

function findByType(root: Root, type: string): TestInstance {
  const match = root.queryAll((node: TestInstance) => node.type === type, { includeSelf: true })[0];
  if (!match) throw new Error(`Expected ${type} in rendered tree`);
  return match;
}

function findPressableWithText(root: Root, text: string): TestInstance {
  const match = root.queryAll((node: TestInstance) =>
    node.type === "rn-pressable" &&
    node.queryAll((child: TestInstance) => child.type === "Text", { includeSelf: true })
      .some(child => child.children.includes(text)),
    { includeSelf: true },
  )[0];
  if (!match) throw new Error(`Expected Pressable containing ${text}`);
  return match;
}

function findFirstPressable(root: Root): TestInstance {
  const match = root.queryAll(
    (node: TestInstance) => node.type === "rn-pressable",
    { includeSelf: true },
  )[0];
  if (!match) throw new Error("Expected a Pressable");
  return match;
}

function BrowseHarness({
  onRefresh,
  onClose,
}: {
  onRefresh: () => Promise<void>;
  onClose: jest.Mock;
}) {
  const [open, setOpen] = useState(true);
  return open ? (
    <BrowseByAisle
      inventory={inventory}
      isSyncing={false}
      shelfViewEnabled={false}
      onRefresh={onRefresh}
      onClose={() => {
        onClose();
        setOpen(false);
      }}
    />
  ) : null;
}

describe("BrowseByAisle — callbacks cannot update after close", () => {
  let tree: RenderResult | null = null;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(async () => {
    if (tree) {
      await tree.unmount();
      tree = null;
    }
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it("does not finish a delayed refresh after the overlay closes", async () => {
    let resolveRefresh!: () => void;
    const refresh = new Promise<void>(resolve => { resolveRefresh = resolve; });
    const onRefresh = jest.fn(() => refresh);
    const onClose = jest.fn();

    await act(async () => {
      tree = await render(<BrowseHarness onRefresh={onRefresh} onClose={onClose} />);
    });

    const refreshControl = findByType(tree!.root!, "rn-refresh-control");
    await act(async () => {
      void refreshControl.props.onRefresh();
    });
    expect(refreshControl.props.refreshing).toBe(true);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      findFirstPressable(tree!.root!).props.onPress();
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    resolveRefresh();
    await act(async () => {});

    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Can't perform a React state update on an unmounted component"),
    );
    errorSpy.mockRestore();
  });

  it("clears the delayed section highlight when the overlay closes", async () => {
    const onRefresh = jest.fn().mockResolvedValue(undefined);
    const onClose = jest.fn();
    const setTimeoutSpy = jest.spyOn(global, "setTimeout");

    await act(async () => {
      tree = await render(<BrowseHarness onRefresh={onRefresh} onClose={onClose} />);
    });
    const root = tree!.root!;

    // Enter the only section, return to the section list (which schedules the
    // highlight), then close the overlay from the aisle list.
    await act(async () => { findPressableWithText(root, "Aisle 01").props.onPress(); });
    await act(async () => {
      findPressableWithText(tree!.root!, "Section 02").props.onPress();
    });
    await act(async () => { findFirstPressable(tree!.root!).props.onPress(); });
    const highlightCallIndex = setTimeoutSpy.mock.calls.findIndex(
      call => call[1] === 1400,
    );
    expect(highlightCallIndex).toBeGreaterThanOrEqual(0);
    const highlightTimer = setTimeoutSpy.mock.results[highlightCallIndex]?.value;
    const clearTimeoutSpy = jest.spyOn(global, "clearTimeout");

    await act(async () => {});
    await act(async () => {
      findFirstPressable(tree!.root!).props.onPress();
    });
    await act(async () => {
      findFirstPressable(tree!.root!).props.onPress();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(highlightTimer);
    clearTimeoutSpy.mockRestore();
    setTimeoutSpy.mockRestore();
  });
});