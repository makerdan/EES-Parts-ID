import { useClerk } from "@clerk/expo";
import { useRouter } from "expo-router";
import React, { useEffect } from "react";
import { ActivityIndicator, Platform, StyleSheet, Text, View } from "react-native";

import { useColors } from "@/hooks/useColors";

/**
 * Dedicated OAuth callback page for web.
 *
 * After the full-page Google/Apple redirect flow (signIn.authenticateWithRedirect
 * in OAuthButtons), Clerk redirects the browser back to this route with the OAuth
 * token params in the URL. We call clerk.handleRedirectCallback() to read those
 * params and finalize the session (it also transfers a first-time OAuth user into
 * a sign-up automatically). While that runs we show the "Completing sign-in…"
 * spinner.
 *
 * AuthGate in _layout.tsx exempts this route from the redirect-to-login guard, so
 * the redirect-to-login logic doesn't fire before Clerk has finished processing
 * the token. Once the session is active (isSignedIn flips to true), AuthGate is
 * the single source of truth for routing the user to the correct screen (tabs,
 * pending, or banned) — we hand navigation back to it via the customNavigate
 * callback below.
 *
 * On native this route is never reached: the native useSSO flow resolves the
 * session in-place, so the effect is a no-op there.
 */
export default function SsoCallback() {
  const colors = useColors();
  const clerk = useClerk();
  const router = useRouter();

  useEffect(() => {
    if (Platform.OS !== "web") return;

    let cancelled = false;
    clerk
      .handleRedirectCallback(
        {
          // Fallbacks if Clerk cannot infer where to go; AuthGate takes over
          // from here and routes based on approval status.
          signInFallbackRedirectUrl: "/",
          signUpFallbackRedirectUrl: "/",
        },
        // Keep navigation inside the expo-router SPA rather than doing a hard
        // page load, then let AuthGate correct the destination.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (to: string) => {
          if (!cancelled) router.replace(to as any);
          return Promise.resolve();
        },
      )
      .catch(() => {
        // Token missing/expired or the user cancelled — send them back to login.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (!cancelled) router.replace("/login" as any);
      });

    return () => {
      cancelled = true;
    };
  }, [clerk, router]);

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
