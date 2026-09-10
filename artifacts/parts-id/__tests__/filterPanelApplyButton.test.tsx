/**
 * Regression guard: Apply buttons in FilterPanel.
 *
 * Verifies:
 * 1. Both the top Apply button (above the scroll area) and the bottom Apply
 *    button (at the end of the scroll area) call onApply when pressed.
 * 2. No Apply button appears when onApply is not provided.
 * 3. No Apply button appears when the panel is collapsed.
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

// ─── react-native ─────────────────────────────────────────────────────────────

jest.mock("react-native", () => {
  function makeAnimValue() {
    return {
      setValue: jest.fn(),
      interpolate: () => "interpolated",
    };
  }

  const helpers = require("./helpers/mapMocks");
  const rn = helpers.createReactNativeMock();
  const animated = rn.Animated as Record<string, unknown>;
  const layoutAnimation = rn.LayoutAnimation as Record<string, unknown>;
  const uiManager = rn.UIManager as Record<string, unknown>;

  return helpers.createReactNativeMock({
    Animated: {
      ...animated,
      Value: makeAnimValue,
      timing: () => ({ start: jest.fn() }),
    },
    LayoutAnimation: {
      ...layoutAnimation,
      configureNext: jest.fn(),
    },
    UIManager: {
      ...uiManager,
      setLayoutAnimationEnabledExperimental: jest.fn(),
    },
    PanResponder: {
      ...(rn.PanResponder as Record<string, unknown>),
      create: () => ({ panHandlers: {} }),
    },
  });
});

// ─── @expo/vector-icons ────────────────────────────────────────────────────────

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

// ─── @/hooks/useColors ────────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

// ─── @/hooks/useWebHorizontalScroll ───────────────────────────────────────────

jest.mock("@/hooks/useWebHorizontalScroll", () => ({
  useWebHorizontalScroll: jest.fn(),
}));

// ─── @/components/KeyboardAwareScrollViewCompat ───────────────────────────────

jest.mock("@/components/KeyboardAwareScrollViewCompat", () => ({
  KeyboardAwareScrollViewCompat: function KASVC({ children }: { children?: React.ReactNode }) {
    const React = require("react");
    return React.createElement("rn-keyboard-scroll", {}, children);
  },
}));

// ─── @/components/KeyboardDoneInput ───────────────────────────────────────────

jest.mock("@/components/KeyboardDoneInput", () => ({
  KeyboardDoneInput: () => null,
}));

// ─── @/hooks/usePersistedCollapse (controllable) ──────────────────────────────
//
// Mocked so tests can control the dimCollapsed value without touching
// AsyncStorage. The mock returns [collapsed, toggle, setCollapsed, loaded].

const mockUsePersistedCollapse = jest.fn();

jest.mock("@/hooks/usePersistedCollapse", () => ({
  usePersistedCollapse: (...args: unknown[]) => mockUsePersistedCollapse(...args),
}));

// ─── Subject under test ───────────────────────────────────────────────────────

import React from "react";
import { render, act } from "@testing-library/react-native";
import type { RenderResult } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";
import { FilterPanel } from "@/components/FilterPanel";
import type { FilterValues } from "@/components/FilterPanel";

// ─── Helpers ──────────────────────────────────────────────────────────────────

type Inst = TestInstance;

/** Walk the tree and return all pressable elements whose text children include `text`. */
function findPressablesByText(root: Inst, text: string): Inst[] {
  const pressables: Inst[] = [];

  function hasText(node: Inst): boolean {
    if (!node) return false;
    if ((node.type as string) === "Text") {
      const c = (node.props as { children?: unknown }).children;
      if (typeof c === "string" && c.includes(text)) return true;
      if (Array.isArray(c)) return c.some((x) => typeof x === "string" && x.includes(text));
    }
    return node.children.some((ch: TestInstance | string) => typeof ch !== "string" && ch != null && hasText(ch as Inst));
  }

  function walk(node: Inst) {
    if (!node) return;
    if ((node.type as string) === "rn-pressable" && hasText(node)) {
      pressables.push(node);
    }
    node.children.forEach((ch: TestInstance | string) => { if (typeof ch !== "string") walk(ch as Inst); });
  }

  walk(root);
  return pressables;
}

const DEFAULT_VALUES: FilterValues = {
  keywords: "",
  catalog: "",
  vendor: "",
  color: "",
  size: "",
  material: "",
  textNumbers: "",
  confidenceThreshold: 0,
  minLength: "",
  maxLength: "",
  minWidth: "",
  maxWidth: "",
  minHeight: "",
  maxHeight: "",
  minDiameter: "",
  maxDiameter: "",
  includeNullDimensions: true,
  minWeight: "",
  maxWeight: "",
  category: "",
  amperage: "",
  colorChip: "",
  manufacturer: "",
  sizeChip: "",
  rating: "",
  wireType: "",
  wireGauge: "",
  conduitType: "",
  conduitSize: "",
  boxType: "",
  boxGangCount: "",
  mountingType: "",
  environment: "",
  voltage: "",
  poleCount: "",
};

/** Render FilterPanel with the panel expanded (dimCollapsed = false). */
async function renderExpanded(onApply?: () => void) {
  mockUsePersistedCollapse.mockReturnValue([false, jest.fn(), jest.fn(), true]);
  return await render(
    <FilterPanel
      values={DEFAULT_VALUES}
      onChange={jest.fn()}
      onApply={onApply}
    />,
  );
}

/** Render FilterPanel with the panel collapsed (dimCollapsed = true, the default). */
async function renderCollapsed(onApply?: () => void) {
  mockUsePersistedCollapse.mockReturnValue([true, jest.fn(), jest.fn(), true]);
  return await render(
    <FilterPanel
      values={DEFAULT_VALUES}
      onChange={jest.fn()}
      onApply={onApply}
    />,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("FilterPanel — Apply buttons", () => {

  // ── 1. Both buttons call onApply ───────────────────────────────────────────

  it("top Apply button calls onApply when pressed (panel expanded)", async () => {
    const onApply = jest.fn();
    const result = await renderExpanded(onApply);

    const applyButtons = findPressablesByText(result.root!, "Apply");
    // Expect at least 2 (top + bottom)
    expect(applyButtons.length).toBeGreaterThanOrEqual(2);

    // Press the first one (top position)
    await act(async () => {
      (applyButtons[0]!.props as { onPress?: () => void }).onPress?.();
    });
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("bottom Apply button calls onApply when pressed (panel expanded)", async () => {
    const onApply = jest.fn();
    const result = await renderExpanded(onApply);

    const applyButtons = findPressablesByText(result.root!, "Apply");
    expect(applyButtons.length).toBeGreaterThanOrEqual(2);

    // Press the last one (bottom position)
    await act(async () => {
      (applyButtons[applyButtons.length - 1]!.props as { onPress?: () => void }).onPress?.();
    });
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("both Apply buttons are distinct pressable elements", async () => {
    const onApply = jest.fn();
    const result = await renderExpanded(onApply);

    const applyButtons = findPressablesByText(result.root!, "Apply");
    expect(applyButtons.length).toBeGreaterThanOrEqual(2);
    expect(applyButtons[0]).not.toBe(applyButtons[applyButtons.length - 1]);
  });

  it("pressing top Apply button does not call onApply more than once", async () => {
    const onApply = jest.fn();
    const result = await renderExpanded(onApply);

    const applyButtons = findPressablesByText(result.root!, "Apply");
    await act(async () => {
      (applyButtons[0]!.props as { onPress?: () => void }).onPress?.();
    });
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("pressing bottom Apply button does not call onApply more than once", async () => {
    const onApply = jest.fn();
    const result = await renderExpanded(onApply);

    const applyButtons = findPressablesByText(result.root!, "Apply");
    await act(async () => {
      (applyButtons[applyButtons.length - 1]!.props as { onPress?: () => void }).onPress?.();
    });
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  // ── 2. Buttons absent when onApply is not provided ─────────────────────────

  it("no Apply button appears when onApply is not provided (panel expanded)", async () => {
    const result = await renderExpanded(undefined);

    const applyButtons = findPressablesByText(result.root!, "Apply");
    expect(applyButtons).toHaveLength(0);
  });

  // ── 3. Buttons absent when the panel is collapsed ──────────────────────────

  it("no Apply button appears when the panel is collapsed (onApply provided)", async () => {
    const onApply = jest.fn();
    const result = await renderCollapsed(onApply);

    const applyButtons = findPressablesByText(result.root!, "Apply");
    expect(applyButtons).toHaveLength(0);
  });

  it("no Apply button appears when panel is collapsed and onApply is absent", async () => {
    const result = await renderCollapsed(undefined);

    const applyButtons = findPressablesByText(result.root!, "Apply");
    expect(applyButtons).toHaveLength(0);
  });
});
