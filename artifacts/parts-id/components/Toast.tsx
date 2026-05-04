/**
 * Branded toast notification — auto-dismissing overlay that maps a message
 * type to the Parts ID amber/red/green palette. Never use raw white system
 * toasts; always use this component for ephemeral feedback.
 *
 * Types:
 *   success  — amber border / icon (neutral confirmation on the warehouse floor)
 *   warning  — amber, higher contrast
 *   error    — destructive red
 *   info     — muted, low-emphasis
 */
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useColors } from "@/hooks/useColors";

export type ToastType = "success" | "warning" | "error" | "info";

interface ToastProps {
  message: string;
  type?: ToastType;
}

export function Toast({ message, type = "success" }: ToastProps) {
  const colors = useColors();

  const config = {
    success: {
      bg: colors.primary + "18",
      border: colors.primary,
      text: colors.foreground,
      icon: "⚡",
    },
    warning: {
      bg: colors.warning + "22",
      border: colors.warning,
      text: colors.foreground,
      icon: "⚠",
    },
    error: {
      bg: colors.destructive + "1a",
      border: colors.destructive,
      text: colors.destructive,
      icon: "✕",
    },
    info: {
      bg: colors.muted,
      border: colors.border,
      text: colors.mutedForeground,
      icon: "ℹ",
    },
  }[type];

  return (
    <View
      style={[
        styles.wrap,
        {
          backgroundColor: config.bg,
          borderColor: config.border,
          shadowColor: config.border,
        },
      ]}
      pointerEvents="none"
      accessibilityLiveRegion="polite"
    >
      <Text style={[styles.icon, { color: config.border }]}>{config.icon}</Text>
      <Text style={[styles.text, { color: config.text }]} numberOfLines={2}>
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    bottom: 100,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: 1.5,
    maxWidth: 340,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 6,
    elevation: 6,
    zIndex: 999,
  },
  icon: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    flexShrink: 0,
  },
  text: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    flexShrink: 1,
    lineHeight: 20,
  },
});
