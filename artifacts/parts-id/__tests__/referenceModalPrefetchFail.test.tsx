/**
 * Guards the prefetch-failure handling added to ReferenceModal (F-057).
 *
 * When `prefetchQuickLookupsImpl` throws, the component must:
 *   1. Set `prefetchFailed = true`.
 *   2. Render a "(tap to load)" label next to the QUICK LOOKUPS heading so
 *      the user knows the chips are not pre-populated.
 *
 * When prefetch succeeds, the label must NOT appear.
 *
 * NOTE: The react-native Modal mock ignores the `onShow` prop by default.
 * This file overrides the Modal mock to call `onShow` via useEffect so the
 * prefetch path is exercised.
 */

// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

// ─── chipCache mock ───────────────────────────────────────────────────────────

const mockPrefetchQuickLookups = jest.fn();
const mockFetchChipAnswer      = jest.fn();

jest.mock("@/utils/chipCache", () => ({
  BoundedLruMap:        jest.fn().mockImplementation(() => new Map()),
  prefetchQuickLookups: (...a: unknown[]) => mockPrefetchQuickLookups(...a),
  fetchChipAnswer:      (...a: unknown[]) => mockFetchChipAnswer(...a),
}));

// ─── react-native override — Modal calls onShow when visible ──────────────────
// The global mock ignores onShow; we override it here so the prefetch path
// is exercised in these tests.

jest.mock("react-native", () => {
  const React = require("react");
  const noop  = () => {};

  function make(tag: string) {
    return function RNMock({ children, ...props }: Record<string, unknown>) {
      return React.createElement(tag, props, children);
    };
  }

  const Animated = {
    Value: class {
      _value: unknown;
      constructor(v: unknown) { this._value = v; }
      setValue(v: unknown) { this._value = v; }
      interpolate() { return this; }
    },
    View: make("rn-animated-view"),
    loop: () => ({ start: noop, stop: noop, reset: noop }),
    sequence: () => ({ start: noop, stop: noop, reset: noop }),
    timing: () => ({ start: noop, stop: noop, reset: noop }),
  };

  function Modal({ children, visible, onShow }: {
    children?: unknown;
    visible?: boolean;
    onShow?: () => void;
  }) {
    React.useEffect(() => {
      if (visible && onShow) onShow();
    }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
    if (!visible) return null;
    return React.createElement("rn-modal", {}, children);
  }

  return {
    View:                    make("rn-view"),
    Animated,
    Text:                    make("Text"),
    Pressable:               make("rn-pressable"),
    TouchableOpacity:        make("rn-touchable"),
    SafeAreaView:            make("rn-safe-area"),
    ScrollView:              make("rn-scroll"),
    Modal,
    Alert:                   { alert: jest.fn() },
    StyleSheet:              { create: (s: unknown) => s, hairlineWidth: 0.5, flatten: (s: unknown) => s, absoluteFill: {} },
    Platform:                { OS: "ios", select: (opts: Record<string, unknown>) => opts.ios ?? opts.default },
    Dimensions:              { get: () => ({ width: 390, height: 844 }), addEventListener: () => ({ remove: noop }) },
    KeyboardAvoidingView:    make("rn-keyboard-avoiding-view"),
    Keyboard:                { dismiss: noop, addListener: () => ({ remove: noop }) },
    useColorScheme:          () => "light",
    useWindowDimensions:     () => ({ width: 390, height: 844, scale: 2, fontScale: 1 }),
    PixelRatio:              { get: () => 2, roundToNearestPixel: (v: number) => Math.round(v) },
    Linking:                 { openURL: jest.fn(() => Promise.resolve()) },
    BackHandler:             { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
    ActivityIndicator:       make("rn-activity"),
    FlatList:                make("rn-flat-list"),
    TextInput:               make("rn-text-input"),
    NativeModules:           {},
    AppState:                { currentState: "active", addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
  };
});

// ─── Other mocks ──────────────────────────────────────────────────────────────

jest.mock("@/contexts/AppContext", () => ({
  useApp: jest.fn(() => ({
    showToast: jest.fn(),
  })),
}));

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

jest.mock("@/utils/apiBase", () => ({
  API_BASE:   "http://localhost:8080/api",
  API_ORIGIN: "http://localhost:8080",
}));

jest.mock("@/utils/appAuth", () => ({
  fetchWithAuth: jest.fn().mockResolvedValue({ ok: false }),
}));

jest.mock("@/components/ContactSheet", () => ({
  ContactSheet: () => null,
}));

jest.mock("@/components/DismissKeyboard", () => ({
  DismissKeyboard: ({ children }: { children: React.ReactNode }) => children as React.ReactElement,
}));

jest.mock("@/components/KeyboardDoneInput", () => {
  const Rct = require("react");
  return {
    KeyboardDoneInput: (props: { [k: string]: unknown }) =>
      Rct.createElement("rn-textinput", { ...props }),
  };
});

jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import React from "react";
import { render, act } from "@testing-library/react-native";
import { ReferenceModal } from "../components/ReferenceModal";

const flushPromises = () =>
  act(async () => {
    await new Promise<void>(r => setTimeout(r, 0));
    await new Promise<void>(r => setTimeout(r, 0));
    await new Promise<void>(r => setTimeout(r, 0));
  });

// ─── Per-test teardown ────────────────────────────────────────────────────────

let activeTree: Awaited<ReturnType<typeof render>> | null = null;

afterEach(async () => {
  if (activeTree) {
    await activeTree.unmount();
    activeTree = null;
  }
  jest.clearAllMocks();
  // Restore prefetch mock after clearAllMocks.
  mockPrefetchQuickLookups.mockResolvedValue(undefined);
});

// =============================================================================
// F-057 — prefetch failure handling
// =============================================================================

describe("ReferenceModal — prefetch failure (F-057)", () => {
  it("does NOT show '(tap to load)' when prefetch succeeds", async () => {
    mockPrefetchQuickLookups.mockResolvedValue(undefined); // success

    const result = await render(<ReferenceModal open={true} onClose={jest.fn()} />);
    activeTree = result;
    await flushPromises();

    expect(result.queryByText(/tap to load/i)).toBeNull();
  });

  it("shows '(tap to load)' label when prefetchQuickLookupsImpl throws", async () => {
    mockPrefetchQuickLookups.mockRejectedValue(new Error("network error"));

    const result = await render(<ReferenceModal open={true} onClose={jest.fn()} />);
    activeTree = result;
    await flushPromises();

    expect(result.queryByText(/tap to load/i)).not.toBeNull();
  });

  it("resets prefetchFailed to false on a subsequent modal show", async () => {
    // First show — prefetch fails.
    mockPrefetchQuickLookups.mockRejectedValue(new Error("first error"));

    const result = await render(<ReferenceModal open={true} onClose={jest.fn()} />);
    activeTree = result;
    await flushPromises();
    expect(result.queryByText(/tap to load/i)).not.toBeNull();

    // Second show — prefetch succeeds; label must clear.
    mockPrefetchQuickLookups.mockResolvedValue(undefined);
    // Re-mount the modal (toggle visible off then on) so onShow fires again.
    await result.rerender(<ReferenceModal open={false} onClose={jest.fn()} />);
    await result.rerender(<ReferenceModal open={true} onClose={jest.fn()} />);
    await flushPromises();

    expect(result.queryByText(/tap to load/i)).toBeNull();
  });
});
