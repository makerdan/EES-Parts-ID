/**
 * Branded inline error banner — left-accented red bar with an icon and
 * concise message. Use wherever an operation fails and the worker needs
 * immediate, in-context feedback (login, upload, scan, search).
 *
 * Keep messages direct and action-oriented. Never use filler phrases like
 * "Oops" or "Something went wrong" without a specific follow-up action.
 */
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useColors } from "@/hooks/useColors";

interface ErrorBannerProps {
  message: string;
  style?: object;
}

export function ErrorBanner({ message, style }: ErrorBannerProps) {
  const colors = useColors();

  return (
    <View
      style={[
        styles.banner,
        {
          backgroundColor: colors.destructive + "12",
          borderLeftColor: colors.destructive,
        },
        style,
      ]}
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
    >
      <Text style={[styles.icon, { color: colors.destructive }]}>✕</Text>
      <Text style={[styles.text, { color: colors.destructive }]} numberOfLines={4}>
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    borderLeftWidth: 3,
    borderRadius: 6,
    paddingVertical: 10,
    paddingLeft: 12,
    paddingRight: 14,
    marginVertical: 8,
  },
  icon: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    marginTop: 1,
    flexShrink: 0,
  },
  text: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    lineHeight: 19,
    flexShrink: 1,
  },
});
