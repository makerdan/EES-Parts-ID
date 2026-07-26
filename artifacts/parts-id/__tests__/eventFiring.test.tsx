/**
 * Regression guard: fireEvent must be used instead of raw props.onPress() calls.
 *
 * WHY THIS EXISTS
 * ---------------
 * Raw `node.props.onPress()` calls bypass React's event-batching machinery and
 * can bleed state into neighbouring tests, causing flaky failures that are hard
 * to trace.  `fireEvent.press(node)` from @testing-library/react-native goes
 * through act() and respects React's batching.
 *
 * This test renders a real Pressable and asserts:
 *   (a) the handler is called exactly once when fireEvent.press fires — proving
 *       the Pressable mock is wired correctly and fireEvent reaches it.
 *   (b) the handler is NOT called without a fireEvent.press — proving the mock
 *       does not auto-fire on mount.
 *
 * HOW TO FIX A FAILURE
 * --------------------
 * If "btn not found" fails: check that the react-native Pressable mock renders
 * an element with type "rn-pressable" so root!.queryAll() can find it.
 * If "handler not called" fails: check that the Pressable mock forwards
 * onPress as a prop on the rendered element.
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { render, fireEvent } from "@testing-library/react-native";

// ─── react-native mock (minimal — only Pressable + Text needed) ───────────────

jest.mock("react-native", () => ({
  Platform:          { OS: "ios", select: (o: Record<string, unknown>) => o.ios ?? o.default },
  StyleSheet:        { create: (s: unknown) => s, flatten: (s: unknown) => s },
  View:              ({ children }: { children?: React.ReactNode }) =>
                       React.createElement("rn-view", {}, children),
  Text:              ({ children }: { children?: React.ReactNode }) =>
                       React.createElement("Text", {}, children),
  Pressable:         ({ children, onPress }: { children?: React.ReactNode; onPress?: () => void }) =>
                       React.createElement("rn-pressable", { onPress }, children),
  ActivityIndicator: () => null,
  PixelRatio:        { get: () => 3 },
  useColorScheme:    () => "light",
  LayoutChangeEvent: {},
}));

// =============================================================================
// Smoke test
// =============================================================================

describe("fireEvent.press smoke test", () => {
  /**
   * Single-test guard: render → find pressable via root tree → fire → assert.
   * Uses the same `root!.queryAll()` pattern as every other test in this suite.
   */
  it("calls the onPress handler exactly once and does not fire before press", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Pressable, Text } = require("react-native") as {
      Pressable: React.ComponentType<{ children?: React.ReactNode; onPress?: () => void }>;
      Text:      React.ComponentType<{ children?: React.ReactNode }>;
    };

    const handler = jest.fn();

    const result = await render(
      React.createElement(
        Pressable,
        { onPress: handler },
        React.createElement(Text, {}, "Tap me"),
      ),
    );

    const btn = result.root!.queryAll(
      (n) => (n.type as string) === "rn-pressable",
      { includeSelf: true },
    )[0];

    // Sanity: the mock must render the element with type "rn-pressable".
    expect(btn).toBeDefined();

    // Handler must NOT fire without an explicit gesture.
    expect(handler).not.toHaveBeenCalled();

    // Fire the press — this is the ONLY allowed idiom in this suite.
    fireEvent.press(btn!);

    expect(handler).toHaveBeenCalledTimes(1);

    await result.unmount();
  });
});
