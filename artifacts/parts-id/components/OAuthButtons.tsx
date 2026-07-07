import { useClerk, useSSO } from "@clerk/expo";
import * as AuthSession from "expo-auth-session";
import { useRouter } from "expo-router";
import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useColors } from "@/hooks/useColors";

// NOTE: Before OAuth buttons work, you must enable Google and/or Apple as
// social providers in your Clerk Dashboard:
// Dashboard → User & Authentication → Social Connections → Enable Google / Apple
// For Apple: also configure your Apple Developer team ID, key ID, and private key.
//
// PLATFORM SPLIT — this is deliberate and important:
//
//  • Web uses a true full-page redirect via signIn.authenticateWithRedirect()
//    (@clerk/clerk-js, which backs @clerk/expo on web). The whole tab navigates
//    to the provider and back to /sso-callback, where clerk.handleRedirectCallback()
//    finalizes the session. We do NOT use useSSO()/startSSOFlow() on web because
//    it calls expo-web-browser's openAuthSessionAsync(), which opens a POPUP
//    window on web; the popup logs in but cannot hand the session back to the
//    main tab (especially inside an embedded iframe), so the user never appears
//    signed in. The full-page redirect avoids the popup entirely.
//
//  • Native (iOS/Android) uses useSSO()/startSSOFlow(), which opens the in-app
//    browser and resolves with createdSessionId in the same JS context. We
//    activate that session and let AuthGate route the user.
//
// AuthGate in _layout.tsx exempts /sso-callback from its redirect-to-login guard
// so Clerk has time to process the token before any navigation fires.
//
// REDIRECT URL CONFIGURATION (web):
// The web OAuth callback URL is built from EXPO_PUBLIC_APP_URL (set this env var
// in production to the canonical app origin, e.g. https://your-app.replit.app).
// It falls back to window.location.origin for local dev where the origin is stable.
// In Clerk Dashboard → Paths → "Allowed redirect URLs", add:
//   https://your-app.replit.app/sso-callback
// Without this entry, Google will reject the redirect and the user sees a blank page.

interface OAuthButtonsProps {
  mode: "sign-in" | "sign-up";
}

function GoogleIcon({ color }: { color: string }) {
  return <Text style={[styles.googleIcon, { color }]}>G</Text>;
}

function AppleIcon({ color }: { color: string }) {
  // U+F8FF is the Apple logo glyph in the San Francisco PUA range (renders on iOS/macOS).
  // On Android this button is never shown; on web it falls back to a plain circle.
  return <Text style={[styles.appleIcon, { color }]}>{"\uF8FF"}</Text>;
}

export function OAuthButtons({ mode }: OAuthButtonsProps) {
  const colors = useColors();
  const router = useRouter();

  // Native (iOS/Android): useSSO()/startSSOFlow() opens the in-app browser and
  // resolves with createdSessionId in the same JS context, which we activate
  // below. Not used on web (it opens a popup there — see the header comment).
  const { startSSOFlow } = useSSO();

  // Web: the Clerk instance's classic client.signIn resource exposes
  // authenticateWithRedirect(), which performs a true full-page redirect. We
  // reach it through useClerk() rather than useSignIn() because in this Clerk
  // version useSignIn() returns the newer signals API whose signIn resource has
  // no authenticateWithRedirect. Calling the hook is safe on native too (we
  // just never touch the web resource there).
  const clerk = useClerk();

  const [googleLoading, setGoogleLoading] = useState(false);
  const [appleLoading, setAppleLoading] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);

  const runOAuth = useCallback(
    async (strategy: "oauth_google" | "oauth_apple") => {
      // Build the /sso-callback URL. Prefer EXPO_PUBLIC_APP_URL (the canonical
      // origin registered in Clerk's "Allowed redirect URLs") so the callback
      // URL is predictable regardless of which proxy domain Replit assigns;
      // fall back to the current origin for local dev.
      if (Platform.OS === "web") {
        const signIn = clerk.client?.signIn;
        if (!signIn) return;
        const origin =
          process.env.EXPO_PUBLIC_APP_URL ||
          (typeof window !== "undefined" ? window.location.origin : "");
        const callbackUrl = `${origin}/sso-callback`;
        // Full-page redirect: navigates the whole tab to the provider and back
        // to /sso-callback, where clerk.handleRedirectCallback() finalizes the
        // session. Nothing after this line runs on success (the page unloads).
        await signIn.authenticateWithRedirect({
          strategy,
          redirectUrl: callbackUrl,
          redirectUrlComplete: callbackUrl,
        });
        return;
      }

      // Native: AuthSession.makeRedirectUri() builds the app-scheme deep link.
      const { createdSessionId, setActive } = await startSSOFlow({
        strategy,
        redirectUrl: AuthSession.makeRedirectUri(),
      });

      // If a session was created, activate it and let AuthGate route the user.
      if (createdSessionId) {
        await setActive!({ session: createdSessionId });
        router.replace("/(tabs)");
      }
    },
    [clerk, startSSOFlow, router],
  );

  const handleGoogle = useCallback(async () => {
    if (googleLoading) return;
    setOauthError(null);
    setGoogleLoading(true);
    try {
      await runOAuth("oauth_google");
    } catch (err) {
      const msg = err instanceof Error ? err.message : null;
      if (msg && !msg.toLowerCase().includes("cancel")) {
        setOauthError("Google sign-in failed. Please try again.");
      }
    } finally {
      setGoogleLoading(false);
    }
  }, [googleLoading, runOAuth]);

  const handleApple = useCallback(async () => {
    if (appleLoading) return;
    setOauthError(null);
    setAppleLoading(true);
    try {
      await runOAuth("oauth_apple");
    } catch (err) {
      const msg = err instanceof Error ? err.message : null;
      if (msg && !msg.toLowerCase().includes("cancel")) {
        setOauthError("Apple sign-in failed. Please try again.");
      }
    } finally {
      setAppleLoading(false);
    }
  }, [appleLoading, runOAuth]);

  const s = StyleSheet.create({
    dividerRow: {
      flexDirection: "row",
      alignItems: "center",
      marginTop: 20,
      marginBottom: 16,
      gap: 10,
    },
    dividerLine: {
      flex: 1,
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.border,
    },
    dividerText: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
    },
    oauthButton: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: colors.radius,
      paddingVertical: 13,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
      marginBottom: 10,
      gap: 10,
    },
    oauthButtonText: {
      fontSize: 15,
      color: colors.foreground,
      fontFamily: "Inter_500Medium",
    },
    oauthError: {
      fontSize: 13,
      color: colors.destructive,
      fontFamily: "Inter_400Regular",
      textAlign: "center",
      marginBottom: 8,
    },
    approvalNote: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
      textAlign: "center",
      marginTop: 4,
      lineHeight: 17,
    },
  });

  const dividerLabel =
    mode === "sign-in" ? "or continue with" : "or sign up with";

  return (
    <>
      <View style={s.dividerRow}>
        <View style={s.dividerLine} />
        <Text style={s.dividerText}>{dividerLabel}</Text>
        <View style={s.dividerLine} />
      </View>

      {oauthError ? <Text style={s.oauthError}>{oauthError}</Text> : null}

      <Pressable
        style={[s.oauthButton, googleLoading && { opacity: 0.6 }]}
        onPress={handleGoogle}
        disabled={googleLoading}
      >
        {googleLoading ? (
          <ActivityIndicator color={colors.foreground} size="small" />
        ) : (
          <>
            <GoogleIcon color={colors.foreground} />
            <Text style={s.oauthButtonText}>Continue with Google</Text>
          </>
        )}
      </Pressable>

      {Platform.OS !== "android" && (
        <Pressable
          style={[s.oauthButton, appleLoading && { opacity: 0.6 }]}
          onPress={handleApple}
          disabled={appleLoading}
        >
          {appleLoading ? (
            <ActivityIndicator color={colors.foreground} size="small" />
          ) : (
            <>
              <AppleIcon color={colors.foreground} />
              <Text style={s.oauthButtonText}>Continue with Apple</Text>
            </>
          )}
        </Pressable>
      )}

      {mode === "sign-up" && (
        <Text style={s.approvalNote}>
          You'll still need admin approval after signing up
        </Text>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  googleIcon: {
    fontSize: 16,
    fontWeight: "700",
  },
  appleIcon: {
    fontSize: 18,
    fontWeight: "400",
  },
});
