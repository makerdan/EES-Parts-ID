const React = require('react');

function makeHost(tag) {
  return React.forwardRef((props, ref) => {
    const { children, style, accessibilityLabel, accessibilityRole, accessibilityState, ...rest } =
      props;
    const a11y = {};
    if (accessibilityLabel != null) a11y['aria-label'] = accessibilityLabel;
    if (accessibilityRole != null) a11y['role'] = accessibilityRole;
    if (accessibilityState && accessibilityState.selected != null) {
      a11y['aria-selected'] = accessibilityState.selected;
    }
    return React.createElement(tag, { ref, ...a11y, ...rest }, children);
  });
}

const View = makeHost('div');
const Text = makeHost('span');
const ScrollView = makeHost('div');
const KeyboardAvoidingView = makeHost('div');

const TextInput = React.forwardRef((props, ref) => {
  const { value, onChangeText, onChange, placeholder, accessibilityLabel, ...rest } = props;
  const handleChange = (e) => {
    if (onChangeText) onChangeText(e.target.value);
    if (onChange) onChange(e);
  };
  return React.createElement('input', {
    ref,
    value: value ?? '',
    onChange: handleChange,
    placeholder,
    'aria-label': accessibilityLabel,
    ...rest,
  });
});

const Pressable = React.forwardRef((props, ref) => {
  const { onPress, children, accessibilityLabel, accessibilityRole, accessibilityState, ...rest } =
    props;
  const a11y = { 'aria-label': accessibilityLabel };
  if (accessibilityState && accessibilityState.selected != null) {
    a11y['aria-selected'] = accessibilityState.selected;
  }
  return React.createElement(
    'button',
    {
      ref,
      type: 'button',
      onClick: onPress,
      role: accessibilityRole ?? 'button',
      ...a11y,
      ...rest,
    },
    typeof children === 'function' ? children({ pressed: false }) : children
  );
});

const Modal = ({ visible, children, onRequestClose, onShow, ...rest }) => {
  React.useEffect(() => {
    if (visible && onShow) onShow();
  }, [visible, onShow]);
  if (!visible) return null;
  return React.createElement('div', { role: 'dialog', ...rest }, children);
};

const Switch = ({ value, onValueChange, accessibilityLabel, accessibilityRole, ...rest }) => {
  return React.createElement('input', {
    type: 'checkbox',
    checked: !!value,
    onChange: (e) => onValueChange && onValueChange(e.target.checked),
    'aria-label': accessibilityLabel,
    role: accessibilityRole,
    ...rest,
  });
};

const ActivityIndicator = () =>
  React.createElement('span', { 'data-testid': 'activity-indicator' });

const StyleSheet = {
  create: (obj) => obj,
  flatten: (style) => {
    if (Array.isArray(style)) return Object.assign({}, ...style.filter(Boolean));
    return style ?? {};
  },
  hairlineWidth: 1,
  absoluteFill: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  absoluteFillObject: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
};

// Animated: minimal stub — tests render animated components but don't assert
// on timing/spring values. Plain objects and no-op callbacks are sufficient.
const animationStub = {
  start: (cb) => cb && cb({ finished: true }),
  stop: () => {},
  reset: () => {},
};

class AnimatedValue {
  constructor(val) {
    this._value = val;
  }
  setValue(val) {
    this._value = val;
  }
  interpolate() {
    return this;
  }
}

const Animated = {
  Value: AnimatedValue,
  View: makeHost('div'),
  Text: makeHost('span'),
  spring: () => animationStub,
  timing: () => animationStub,
  decay: () => animationStub,
  sequence: () => animationStub,
  parallel: () => animationStub,
  loop: () => animationStub,
  event: () => () => {},
  createAnimatedComponent: (C) => C,
};

// PanResponder: returns empty panHandlers so spreading into View props is safe.
const PanResponder = {
  create: () => ({ panHandlers: {} }),
};

const useWindowDimensions = () => ({ width: 375, height: 812, scale: 2, fontScale: 1 });

module.exports = {
  View,
  Text,
  ScrollView,
  KeyboardAvoidingView,
  TextInput,
  Pressable,
  Modal,
  Switch,
  ActivityIndicator,
  StyleSheet,
  Animated,
  PanResponder,
  useWindowDimensions,
  Platform: { OS: 'web', select: (o) => o.web ?? o.default },
};
