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
  TouchableHighlight: make("rn-touchable-highlight"),
  TouchableWithoutFeedback: make("rn-touchable-nofeedback"),
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
  /**
   * SectionList — renders all sections and their items so child components
   * are mounted and their props captured during tests.
   */
  SectionList: function SectionList({ sections, renderItem, renderSectionHeader, keyExtractor, ListHeaderComponent, ListFooterComponent }) {
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
    const children = (sections || []).flatMap((section, si) => {
      const sectionHeader = renderSectionHeader
        ? renderSectionHeader({ section })
        : null;
      const items = (section.data || []).map((item, ii) => {
        const key = keyExtractor ? keyExtractor(item, ii) : `${si}-${ii}`;
        const el = renderItem ? renderItem({ item, index: ii, section, separators: {} }) : null;
        if (!el || !React.isValidElement(el)) return null;
        return React.cloneElement(el, { key });
      }).filter(Boolean);
      return [sectionHeader, ...items].filter(Boolean);
    });
    return React.createElement("rn-section-list", null, header, ...children, footer);
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
  KeyboardAvoidingView: make("rn-keyboard-avoiding-view"),
  InputAccessoryView: make("rn-input-accessory-view"),
  NativeModules: {},
  UIManager: {
    setLayoutAnimationEnabledExperimental: noop,
    getViewManagerConfig: () => null,
  },
  useColorScheme: () => "light",
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 2, fontScale: 1 }),
  PixelRatio: {
    get: () => 2,
    roundToNearestPixel: (v) => Math.round(v),
  },
  Appearance: {
    getColorScheme: () => "light",
    addChangeListener: () => ({ remove: noop }),
  },
  Linking: {
    openURL: jest.fn(() => Promise.resolve()),
    canOpenURL: jest.fn(() => Promise.resolve(true)),
    getInitialURL: jest.fn(() => Promise.resolve(null)),
    addEventListener: () => ({ remove: noop }),
  },
  BackHandler: {
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
    removeEventListener: jest.fn(),
    exitApp: noop,
  },
  LayoutAnimation: {
    configureNext: noop,
    easeInEaseOut: noop,
    spring: noop,
    linear: noop,
    Presets: {
      easeInEaseOut: {},
      linear: {},
      spring: {},
    },
    Properties: { opacity: "opacity", scaleX: "scaleX", scaleY: "scaleY" },
    Types: { spring: "spring", linear: "linear", easeInEaseOut: "easeInEaseOut", keyboard: "keyboard" },
  },
  PanResponder: {
    create: (config) => ({
      panHandlers: {},
      getInteractionHandle: () => null,
    }),
  },
  StatusBar: Object.assign(make("rn-status-bar"), {
    setBarStyle: noop,
    setBackgroundColor: noop,
    setHidden: noop,
    setTranslucent: noop,
    currentHeight: 44,
  }),
};
