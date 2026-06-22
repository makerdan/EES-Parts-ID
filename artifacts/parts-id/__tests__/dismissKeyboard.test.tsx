/**
 * @jest-environment node
 *
 * Regression tests for DismissKeyboard keyboard-dismissal behavior.
 *
 * DismissKeyboard now uses react-native-gesture-handler's Gesture.Tap()
 * instead of TouchableWithoutFeedback, so we simulate a tap by invoking
 * the onEnd callback captured by the RNGH mock.
 *
 * Covers:
 *   - Tapping calls Keyboard.dismiss()
 *   - suppressDismissRef suppresses Keyboard.dismiss()
 *   - style prop is forwarded to the inner View
 */

// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

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
import { __resetTap, __simulateTap } from "../__mocks__/react-native-gesture-handler";
import { DismissKeyboard } from "../components/DismissKeyboard";

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  __resetTap();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("DismissKeyboard — tap dismisses keyboard", () => {
  it("calls Keyboard.dismiss when a tap fires", async () => {
    await act(async () => {
      renderer.create(
        <DismissKeyboard>
          <React.Fragment />
        </DismissKeyboard>,
      );
    });

    __simulateTap();

    expect(mockKeyboardDismiss).toHaveBeenCalledTimes(1);
  });

  it("calls Keyboard.dismiss on each tap", async () => {
    await act(async () => {
      renderer.create(
        <DismissKeyboard>
          <React.Fragment />
        </DismissKeyboard>,
      );
    });

    __simulateTap();
    __simulateTap();

    expect(mockKeyboardDismiss).toHaveBeenCalledTimes(2);
  });
});

describe("DismissKeyboard — suppressDismissRef opt-out", () => {
  it("suppresses Keyboard.dismiss when suppressDismissRef.current is true", async () => {
    const suppressRef = { current: true };

    await act(async () => {
      renderer.create(
        <DismissKeyboard suppressDismissRef={suppressRef as React.RefObject<boolean>}>
          <React.Fragment />
        </DismissKeyboard>,
      );
    });

    __simulateTap();

    expect(mockKeyboardDismiss).not.toHaveBeenCalled();
  });

  it("allows Keyboard.dismiss when suppressDismissRef.current is false", async () => {
    const suppressRef = { current: false };

    await act(async () => {
      renderer.create(
        <DismissKeyboard suppressDismissRef={suppressRef as React.RefObject<boolean>}>
          <React.Fragment />
        </DismissKeyboard>,
      );
    });

    __simulateTap();

    expect(mockKeyboardDismiss).toHaveBeenCalledTimes(1);
  });

  it("behaves normally when no suppressDismissRef is provided", async () => {
    await act(async () => {
      renderer.create(
        <DismissKeyboard>
          <React.Fragment />
        </DismissKeyboard>,
      );
    });

    __simulateTap();

    expect(mockKeyboardDismiss).toHaveBeenCalledTimes(1);
  });

  it("respects suppressDismissRef.current at tap time, not at render time", async () => {
    const suppressRef = { current: false };

    await act(async () => {
      renderer.create(
        <DismissKeyboard suppressDismissRef={suppressRef as React.RefObject<boolean>}>
          <React.Fragment />
        </DismissKeyboard>,
      );
    });

    suppressRef.current = true;
    __simulateTap();
    expect(mockKeyboardDismiss).not.toHaveBeenCalled();

    suppressRef.current = false;
    __simulateTap();
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
