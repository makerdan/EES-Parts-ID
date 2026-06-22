import React from "react";
import {
  Keyboard,
  Platform,
  type StyleProp,
  View,
  type ViewStyle,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

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
  if (Platform.OS === "web") {
    return <View style={[{ flex: 1 }, style]}>{children}</View>;
  }

  const tap = Gesture.Tap()
    .runOnJS(true)
    .onEnd(() => {
      if (suppressDismissRef?.current === true) {
        return;
      }
      Keyboard.dismiss();
    });

  return (
    <GestureDetector gesture={tap}>
      <View style={[{ flex: 1 }, style]}>{children}</View>
    </GestureDetector>
  );
}
