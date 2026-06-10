import React from "react";
import { Text } from "react-native";

interface PinIconProps {
  fill?: string;
  stroke?: string;
  size?: number;
}

/**
 * Inline pin icon — renders the 📍 emoji to match the MapPinEmoji marker
 * used on the warehouse map. The `fill` and `stroke` props are accepted for
 * backwards compatibility but are not used.
 */
export function PinIcon({ size = 16 }: PinIconProps) {
  return (
    <Text style={{ fontSize: size, lineHeight: size + 2 }} accessibilityLabel="pin">
      📍
    </Text>
  );
}
