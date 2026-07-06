import React from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { useColors } from "@/hooks/useColors";

/**
 * Dedicated OAuth callback page for web.
 *
 * After the full-page Google/Apple redirect flow, Clerk redirects the browser
 * back to this route with OAuth token params in the URL.  @clerk/clerk-js
 * (which backs @clerk/expo on web) automatically detects and processes those
 * params as soon as ClerkProvider mounts.  We simply show a loading spinner
 * while that happens.  AuthGate in _layout.tsx is configured to leave this
 * route alone so the redirect-to-login logic doesn't fire before Clerk has
 * finished processing the token.
 *
 * Once isSignedIn flips to true, AuthGate handles routing the user to the
 * correct screen (tabs, pending, or banned) — it is the single source of
 * truth for post-sign-in navigation.
 */
export default function SsoCallback() {
  const colors = useColors();

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ActivityIndicator size="large" color={colors.primary} />
      <Text style={[styles.label, { color: colors.mutedForeground }]}>
        Completing sign-in…
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
  label: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
  },
});
