/**
 * @jest-environment node
 *
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
  const React = require("react");

  function makeAnimValue() {
    return {
      setValue: jest.fn(),
      interpolate: () => "interpolated",
    };
  }

  return {
    View: function View({ children, ...props }: { children?: React.ReactNode; [k: string]: unknown }) {
      return React.createElement("rn-view", props, children);
    },
    Text: function Text({ children, ...props }: { children?: React.ReactNode; [k: string]: unknown }) {
      return React.createElement("rn-text", props, children);
    },
    Pressable: function Pressable({ children, onPress, ...props }: { children?: React.ReactNode; onPress?: () => void; [k: string]: unknown }) {
      return React.createElement("rn-pressable", { onPress, ...props }, children);
    },
    ScrollView: function ScrollView({ children, ...props }: { children?: React.ReactNode; [k: string]: unknown }) {
      return React.createElement("rn-scroll-view", props, children);
    },
    StyleSheet: {
      create: (s: unknown) => s,
      flatten: (s: unknown) => s,
    },
    Animated: {
      Value: makeAnimValue,
      timing: () => ({ start: jest.fn() }),
      View: function AnimView({ children, style }: { children?: React.ReactNode; style?: unknown }) {
        return React.createElement("rn-animated-view", { style }, children);
      },
    },
    LayoutAnimation: {
      configureNext: jest.fn(),
      Presets: { easeInEaseOut: {} },
    },
    UIManager: {
      setLayoutAnimationEnabledExperimental: jest.fn(),
    },
    Platform: { OS: "ios" },
    PanResponder: {
      create: () => ({ panHandlers: {} }),
    },
  };
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
import renderer, { act } from "react-test-renderer";
import { FilterPanel } from "@/components/FilterPanel";
import type { FilterValues } from "@/components/FilterPanel";

// ─── Helpers ──────────────────────────────────────────────────────────────────

type Inst = ReturnType<typeof renderer.create>["root"];

/** Walk the tree and return all pressable elements whose text children include `text`. */
function findPressablesByText(root: Inst, text: string): Inst[] {
  const pressables: Inst[] = [];

  function hasText(node: Inst): boolean {
    if ((node.type as string) === "rn-text") {
      const c = (node.props as { children?: unknown }).children;
      if (typeof c === "string" && c.includes(text)) return true;
      if (Array.isArray(c)) return c.some((x) => typeof x === "string" && x.includes(text));
    }
    return node.children.some((ch) => typeof ch !== "string" && hasText(ch as Inst));
  }

  function walk(node: Inst) {
    if ((node.type as string) === "rn-pressable" && hasText(node)) {
      pressables.push(node);
    }
    node.children.forEach((ch) => { if (typeof ch !== "string") walk(ch as Inst); });
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
function renderExpanded(onApply?: () => void) {
  mockUsePersistedCollapse.mockReturnValue([false, jest.fn(), jest.fn(), true]);
  let root!: renderer.ReactTestRenderer;
  act(() => {
    root = renderer.create(
      <FilterPanel
        values={DEFAULT_VALUES}
        onChange={jest.fn()}
        {...(onApply !== undefined ? { onApply } : {})}
      />,
    );
  });
  return root;
}

/** Render FilterPanel with the panel collapsed (dimCollapsed = true, the default). */
function renderCollapsed(onApply?: () => void) {
  mockUsePersistedCollapse.mockReturnValue([true, jest.fn(), jest.fn(), true]);
  let root!: renderer.ReactTestRenderer;
  act(() => {
    root = renderer.create(
      <FilterPanel
        values={DEFAULT_VALUES}
        onChange={jest.fn()}
        {...(onApply !== undefined ? { onApply } : {})}
      />,
    );
  });
  return root;
}

// ─── Suppress react-test-renderer deprecation noise ──────────────────────────

let origConsoleError: typeof console.error;
beforeAll(() => {
  origConsoleError = console.error.bind(console);
  jest.spyOn(console, "error").mockImplementation(
    (msg: unknown, ...rest: unknown[]) => {
      if (
        typeof msg === "string" &&
        (msg.includes("react-test-renderer is deprecated") || msg.includes("Warning:"))
      ) return;
      origConsoleError(msg, ...rest);
    },
  );
});
afterAll(() => {
  (console.error as jest.Mock).mockRestore?.();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("FilterPanel — Apply buttons", () => {

  // ── 1. Both buttons call onApply ───────────────────────────────────────────

  it("top Apply button calls onApply when pressed (panel expanded)", () => {
    const onApply = jest.fn();
    const root = renderExpanded(onApply);

    const applyButtons = findPressablesByText(root.root, "Apply");
    // Expect at least 2 (top + bottom)
    expect(applyButtons.length).toBeGreaterThanOrEqual(2);

    // Press the first one (top position)
    act(() => {
      (applyButtons[0]!.props as { onPress?: () => void }).onPress?.();
    });
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("bottom Apply button calls onApply when pressed (panel expanded)", () => {
    const onApply = jest.fn();
    const root = renderExpanded(onApply);

    const applyButtons = findPressablesByText(root.root, "Apply");
    expect(applyButtons.length).toBeGreaterThanOrEqual(2);

    // Press the last one (bottom position)
    act(() => {
      (applyButtons[applyButtons.length - 1]!.props as { onPress?: () => void }).onPress?.();
    });
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("both Apply buttons are distinct pressable elements", () => {
    const onApply = jest.fn();
    const root = renderExpanded(onApply);

    const applyButtons = findPressablesByText(root.root, "Apply");
    expect(applyButtons.length).toBeGreaterThanOrEqual(2);
    expect(applyButtons[0]).not.toBe(applyButtons[applyButtons.length - 1]);
  });

  it("pressing top Apply button does not call onApply more than once", () => {
    const onApply = jest.fn();
    const root = renderExpanded(onApply);

    const applyButtons = findPressablesByText(root.root, "Apply");
    act(() => {
      (applyButtons[0]!.props as { onPress?: () => void }).onPress?.();
    });
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("pressing bottom Apply button does not call onApply more than once", () => {
    const onApply = jest.fn();
    const root = renderExpanded(onApply);

    const applyButtons = findPressablesByText(root.root, "Apply");
    act(() => {
      (applyButtons[applyButtons.length - 1]!.props as { onPress?: () => void }).onPress?.();
    });
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  // ── 2. Buttons absent when onApply is not provided ─────────────────────────

  it("no Apply button appears when onApply is not provided (panel expanded)", () => {
    const root = renderExpanded(undefined);

    const applyButtons = findPressablesByText(root.root, "Apply");
    expect(applyButtons).toHaveLength(0);
  });

  // ── 3. Buttons absent when the panel is collapsed ──────────────────────────

  it("no Apply button appears when the panel is collapsed (onApply provided)", () => {
    const onApply = jest.fn();
    const root = renderCollapsed(onApply);

    const applyButtons = findPressablesByText(root.root, "Apply");
    expect(applyButtons).toHaveLength(0);
  });

  it("no Apply button appears when panel is collapsed and onApply is absent", () => {
    const root = renderCollapsed(undefined);

    const applyButtons = findPressablesByText(root.root, "Apply");
    expect(applyButtons).toHaveLength(0);
  });
});
