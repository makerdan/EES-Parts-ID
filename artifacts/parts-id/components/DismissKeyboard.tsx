import React from "react";
import {
  type GestureResponderEvent,
  Keyboard,
  Platform,
  type StyleProp,
  TouchableWithoutFeedback,
  View,
  type ViewStyle,
} from "react-native";

type Props = {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /**
   * Pass a ref whose `.current` can be set to `true` to suppress keyboard
   * dismissal for the next tap. Useful for custom pickers, date pickers, or
   * third-party input wrappers whose native targets do not expose `focus()`.
   *
   * Example:
   *   const noDissmiss = useRef(false);
   *   <DismissKeyboard suppressDismissRef={noDissmiss}>
   *     <MyCustomPicker onOpen={() => { noDissmiss.current = true; }} />
   *   </DismissKeyboard>
   */
  suppressDismissRef?: React.RefObject<boolean>;
};

export function DismissKeyboard({ children, style, suppressDismissRef }: Props) {
  const handlePress = React.useCallback(
    (event: GestureResponderEvent): void => {
      if (suppressDismissRef?.current === true) {
        return;
      }
      const maybeInput = event.target as unknown as { focus?: () => void } | null;
      if (maybeInput && typeof maybeInput.focus === "function") {
        maybeInput.focus();
      } else {
        Keyboard.dismiss();
      }
    },
    [suppressDismissRef],
  );

  if (Platform.OS === "web") {
    return <View style={[{ flex: 1 }, style]}>{children}</View>;
  }
  return (
    <TouchableWithoutFeedback accessible={false} onPress={handlePress}>
      <View style={[{ flex: 1 }, style]}>{children}</View>
    </TouchableWithoutFeedback>
  );
}
