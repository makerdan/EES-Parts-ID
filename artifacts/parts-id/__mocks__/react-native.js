/**
 * Minimal react-native mock for Jest.
 * Maps each RN primitive to a lowercase custom-element tag so that
 * react-test-renderer records them as host nodes and toJSON() returns a
 * navigable tree.  Props are forwarded as-is; unknown ones are simply ignored
 * by the test renderer — they never reach a real DOM.
 */
const React = require("react");

function make(tag) {
  const C = function RNMock({ children }) {
    return React.createElement(tag, {}, children);
  };
  C.displayName = tag;
  return C;
}

module.exports = {
  View: make("rn-view"),
  Text: make("rn-text"),
  Pressable: make("rn-pressable"),
  TouchableOpacity: make("rn-touchable"),
  SafeAreaView: make("rn-safe-area"),
  ScrollView: make("rn-scroll"),
  FlatList: make("rn-flat-list"),
  ActivityIndicator: make("rn-activity"),
  Image: function Image() { return null; },
  TextInput: make("rn-text-input"),
  StyleSheet: {
    create: (styles) => styles,
    hairlineWidth: 0.5,
    flatten: (s) => s,
  },
  Platform: {
    OS: "ios",
    select: (opts) => (opts.ios !== undefined ? opts.ios : opts.default),
  },
  Dimensions: {
    get: () => ({ width: 390, height: 844 }),
    addEventListener: () => ({ remove: () => {} }),
  },
};
