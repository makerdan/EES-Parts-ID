/**
 * @jest-environment node
 *
 * Regression tests for DismissKeyboard keyboard-dismissal behavior.
 *
 * Covers:
 *   - Tapping a TextInput inside DismissKeyboard calls focus(), NOT Keyboard.dismiss
 *   - Tapping a non-input area calls Keyboard.dismiss, NOT focus()
 */

// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

// ─── react-native mock ────────────────────────────────────────────────────────
// We need full control of Keyboard.dismiss so declare it as a jest.fn() here.
// TouchableWithoutFeedback must forward its onPress prop so we can invoke it
// directly from the test.

const mockKeyboardDismiss = jest.fn();

jest.mock("react-native", () => {
  const React = require("react");

  function make(tag: string) {
    return function RNMock({
      children,
      ...props
    }: {
      children?: React.ReactNode;
      [k: string]: unknown;
    }) {
      return React.createElement(tag, props, children);
    };
  }

  return {
    Keyboard: { dismiss: mockKeyboardDismiss },
    TouchableWithoutFeedback: make("rn-twof"),
    View: make("rn-view"),
    StyleSheet: {
      create: (s: unknown) => s,
      flatten: (s: unknown) => s,
    },
    Platform: {
      OS: "ios",
      select: (o: Record<string, unknown>) => o.ios ?? o.default,
    },
  };
});

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import React from "react";
import renderer, { act } from "react-test-renderer";
import { DismissKeyboard } from "../components/DismissKeyboard";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Return the onPress prop of the rendered TouchableWithoutFeedback. */
function getOnPress(tree: renderer.ReactTestRenderer) {
  const twof = tree.root.findByType("rn-twof" as unknown as React.ElementType);
  return twof.props.onPress as (event: unknown) => void;
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("DismissKeyboard — tapping a TextInput", () => {
  it("calls focus() on the target instead of Keyboard.dismiss", async () => {
    const mockFocus = jest.fn();

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <DismissKeyboard>
          <React.Fragment />
        </DismissKeyboard>,
      );
    });

    const onPress = getOnPress(tree);

    // Simulate a press whose target exposes a focus() method (TextInput-like)
    onPress({ target: { focus: mockFocus } });

    expect(mockFocus).toHaveBeenCalledTimes(1);
    expect(mockKeyboardDismiss).not.toHaveBeenCalled();
  });

  it("does not call Keyboard.dismiss when the target has focus()", async () => {
    const mockFocus = jest.fn();

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <DismissKeyboard>
          <React.Fragment />
        </DismissKeyboard>,
      );
    });

    const onPress = getOnPress(tree);
    onPress({ target: { focus: mockFocus } });

    expect(mockKeyboardDismiss).not.toHaveBeenCalled();
  });
});

describe("DismissKeyboard — tapping a non-input area", () => {
  it("calls Keyboard.dismiss when the target has no focus() method", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <DismissKeyboard>
          <React.Fragment />
        </DismissKeyboard>,
      );
    });

    const onPress = getOnPress(tree);

    // Simulate a press on a plain View (no focus method)
    onPress({ target: {} });

    expect(mockKeyboardDismiss).toHaveBeenCalledTimes(1);
  });

  it("calls Keyboard.dismiss when event.target is null", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <DismissKeyboard>
          <React.Fragment />
        </DismissKeyboard>,
      );
    });

    const onPress = getOnPress(tree);
    onPress({ target: null });

    expect(mockKeyboardDismiss).toHaveBeenCalledTimes(1);
  });

  it("calls Keyboard.dismiss when event.target is a number (native view tag)", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <DismissKeyboard>
          <React.Fragment />
        </DismissKeyboard>,
      );
    });

    const onPress = getOnPress(tree);
    // In production RN, nativeEvent.target is a numeric node handle
    onPress({ target: 42 });

    expect(mockKeyboardDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("DismissKeyboard — style prop is forwarded to inner View", () => {
  it("applies the style prop to the wrapper View", async () => {
    const customStyle = { backgroundColor: "red" };

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <DismissKeyboard style={customStyle}>
          <React.Fragment />
        </DismissKeyboard>,
      );
    });

    const view = tree.root.findByType("rn-view" as unknown as React.ElementType);
    const style = view.props.style as Array<unknown>;
    expect(style).toContainEqual(customStyle);
  });
});
