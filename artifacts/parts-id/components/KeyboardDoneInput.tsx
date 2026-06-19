import React, { useMemo } from "react";
import {
  InputAccessoryView,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from "react-native";

import { useColors } from "@/hooks/useColors";

let _counter = 0;
function nextId() {
  _counter += 1;
  return `kbd-done-${_counter}`;
}

export function KeyboardDoneInput(props: TextInputProps) {
  const colors = useColors();
  const nativeId = useMemo(() => nextId(), []);

  if (Platform.OS !== "ios") {
    return <TextInput {...props} />;
  }

  return (
    <>
      <TextInput {...props} inputAccessoryViewID={nativeId} />
      <InputAccessoryView nativeID={nativeId}>
        <View
          style={[
            styles.toolbar,
            { backgroundColor: colors.card, borderTopColor: colors.border },
          ]}
        >
          <Pressable onPress={Keyboard.dismiss} style={styles.doneBtn} hitSlop={8}>
            <Text style={[styles.doneText, { color: colors.primary }]}>Done</Text>
          </Pressable>
        </View>
      </InputAccessoryView>
    </>
  );
}

const styles = StyleSheet.create({
  toolbar: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  doneBtn: {
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  doneText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
});
