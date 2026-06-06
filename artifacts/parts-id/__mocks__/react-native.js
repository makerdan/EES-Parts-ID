/**
 * Minimal react-native mock for Jest.
 * Maps each RN primitive to a lowercase custom-element tag so that
 * react-test-renderer records them as host nodes and toJSON() returns a
 * navigable tree.  Props are forwarded as-is; unknown ones are simply ignored
 * by the test renderer — they never reach a real DOM.
 *
 * FlatList calls renderItem for each data item so that child components (e.g.
 * ResultCard) are actually instantiated and their props can be captured in
 * component-level tests.
 */
const React = require("react");

function make(tag) {
  const C = function RNMock({ children, ...props }) {
    return React.createElement(tag, props, children);
  };
  C.displayName = tag;
  return C;
}

const noop = () => {};
const Animated = {
  Value: class {
    constructor(v) { this._value = v; }
    setValue(v) { this._value = v; }
    interpolate() { return this; }
  },
  View: make("rn-animated-view"),
  loop: (a) => ({ start: noop, stop: noop, reset: noop }),
  sequence: (a) => ({ start: noop, stop: noop, reset: noop }),
  timing: () => ({ start: noop, stop: noop, reset: noop }),
};

module.exports = {
  View: make("rn-view"),
  Animated,
  Text: make("rn-text"),
  Pressable: make("rn-pressable"),
  TouchableOpacity: make("rn-touchable"),
  SafeAreaView: make("rn-safe-area"),
  ScrollView: make("rn-scroll"),
  ActivityIndicator: make("rn-activity"),
  Image: function Image() { return null; },
  TextInput: make("rn-text-input"),
  Switch: function Switch() { return null; },
  RefreshControl: function RefreshControl() { return null; },
  Keyboard: { dismiss: noop, addListener: () => ({ remove: noop }) },
  Modal: function Modal({ children, visible }) {
    if (!visible) return null;
    return React.createElement("rn-modal", {}, children);
  },
  /**
   * FlatList — calls renderItem for every entry in data so that child
   * components are mounted and their props captured during tests.
   */
  FlatList: function FlatList({ data, renderItem, keyExtractor, ListHeaderComponent, ListFooterComponent }) {
    const header = ListHeaderComponent
      ? React.createElement(
          typeof ListHeaderComponent === "function" ? ListHeaderComponent : () => ListHeaderComponent,
          null
        )
      : null;
    const footer = ListFooterComponent
      ? React.createElement(
          typeof ListFooterComponent === "function" ? ListFooterComponent : () => ListFooterComponent,
          null
        )
      : null;
    const items = (data || []).map((item, index) => {
      const key = keyExtractor ? keyExtractor(item, index) : String(index);
      const el = renderItem ? renderItem({ item, index, separators: {} }) : null;
      if (!el || !React.isValidElement(el)) return null;
      return React.cloneElement(el, { key });
    }).filter(Boolean);
    return React.createElement("rn-flat-list", null, header, ...items, footer);
  },
  Alert: {
    alert: jest.fn(),
  },
  StyleSheet: {
    create: (styles) => styles,
    hairlineWidth: 0.5,
    flatten: (s) => s,
    absoluteFill: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
  },
  Platform: {
    OS: "ios",
    select: (opts) => (opts.ios !== undefined ? opts.ios : opts.default),
  },
  Dimensions: {
    get: () => ({ width: 390, height: 844 }),
    addEventListener: () => ({ remove: () => {} }),
  },
  AppState: {
    currentState: "active",
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
};
