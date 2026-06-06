import React from "react";
import {
  Keyboard,
  Platform,
  TouchableWithoutFeedback,
  View,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";

type Props = { children: React.ReactNode; style?: StyleProp<ViewStyle> };

function handlePress(event: GestureResponderEvent): void {
  // If the tapped element exposes a focus() method (e.g. a TextInput), call it
  // so the field receives focus instead of the keyboard being dismissed.
  const maybeInput = event.target as unknown as { focus?: () => void } | null;
  if (maybeInput && typeof maybeInput.focus === "function") {
    maybeInput.focus();
  } else {
    Keyboard.dismiss();
  }
}

export function DismissKeyboard({ children, style }: Props) {
  if (Platform.OS === "web") {
    return <View style={[{ flex: 1 }, style]}>{children}</View>;
  }
  return (
    <TouchableWithoutFeedback accessible={false} onPress={handlePress}>
      <View style={[{ flex: 1 }, style]}>{children}</View>
    </TouchableWithoutFeedback>
  );
}
