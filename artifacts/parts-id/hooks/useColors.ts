import { useColorScheme } from "react-native";

import colors from "@/constants/colors";
import { useApp } from "@/contexts/AppContext";

/**
 * Returns the design tokens for the current effective color scheme.
 *
 * The effective scheme is resolved in this order:
 *   1. If the user has chosen "light" or "dark" in Settings, use that.
 *   2. If the setting is "system" (default), fall back to the device's
 *      system appearance (`useColorScheme()`).
 *
 * All colour tokens for the active palette are returned, plus the
 * scheme-independent `radius` value.
 */
export function useColors() {
  const systemScheme = useColorScheme();
  const { settings } = useApp();

  const themeMode = settings.themeMode ?? "system";
  const effectiveScheme =
    themeMode === "system" ? systemScheme : themeMode;

  const palette = effectiveScheme === "dark" ? colors.dark : colors.light;
  return { ...palette, radius: colors.radius };
}

/**
 * Returns whether the current effective theme is dark.
 * Useful when a raw boolean is needed (e.g. BlurView tint prop).
 */
export function useIsDark(): boolean {
  const systemScheme = useColorScheme();
  const { settings } = useApp();
  const themeMode = settings.themeMode ?? "system";
  return themeMode === "system" ? systemScheme === "dark" : themeMode === "dark";
}
