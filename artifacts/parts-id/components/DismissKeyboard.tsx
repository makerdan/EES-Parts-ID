import React from "react";
import { Keyboard, Pressable, type StyleProp, type ViewStyle } from "react-native";

type Props = { children: React.ReactNode; style?: StyleProp<ViewStyle> };

export function DismissKeyboard({ children, style }: Props) {
  return (
    <Pressable
      style={[{ flex: 1 }, style]}
      accessible={false}
      onPress={Keyboard.dismiss}
    >
      {children}
    </Pressable>
  );
}
