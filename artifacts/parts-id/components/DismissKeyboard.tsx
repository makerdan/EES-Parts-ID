import React from "react";
import { Keyboard, TouchableWithoutFeedback, View, type StyleProp, type ViewStyle } from "react-native";

type Props = { children: React.ReactNode; style?: StyleProp<ViewStyle> };

export function DismissKeyboard({ children, style }: Props) {
  return (
    <TouchableWithoutFeedback accessible={false} onPress={Keyboard.dismiss}>
      <View style={[{ flex: 1 }, style]}>{children}</View>
    </TouchableWithoutFeedback>
  );
}
