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

const StyleSheet = {
  create: (obj) => obj,
  flatten: (style) => {
    if (Array.isArray(style)) return Object.assign({}, ...style.filter(Boolean));
    return style ?? {};
  },
  hairlineWidth: 1,
  absoluteFill: {},
};

module.exports = {
  View,
  Text,
  ScrollView,
  TextInput,
  Pressable,
  StyleSheet,
  Platform: { OS: 'web', select: (o) => o.web ?? o.default },
};
