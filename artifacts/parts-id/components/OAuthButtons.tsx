import { useSSO } from "@clerk/expo";
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
// On web, Google OAuth uses a full-page redirect (authenticateWithRedirect) to
// avoid the popup flow that expo-web-browser opens. The redirect lands back at
// /sso-callback where Clerk's JS SDK processes the OAuth token params, then
// AuthGate in _layout.tsx routes the user to the correct screen. AuthGate
// exempts /sso-callback from the redirect-to-login guard so Clerk has time to
// process the token before any navigation fires.
//
// On native, the existing useOAuth / startOAuthFlow in-app browser flow is used.
//
// REDIRECT URL CONFIGURATION:
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

  // useSSO()/startSSOFlow() is the canonical Clerk Core v3 flow and works on
  // BOTH web and native. On web it performs a full-page redirect to the OAuth
  // provider and back to redirectUrl (/sso-callback), where Clerk's JS SDK
  // processes the token params and AuthGate routes the user. On native it opens
  // the in-app browser and resolves with createdSessionId in the same JS
  // context, which we activate below.
  const { startSSOFlow } = useSSO();

  const [googleLoading, setGoogleLoading] = useState(false);
  const [appleLoading, setAppleLoading] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);

  const runSSO = useCallback(
    async (strategy: "oauth_google" | "oauth_apple") => {
      // On web, redirect back to the dedicated /sso-callback route, which is
      // exempt from AuthGate's redirect-to-login guard so Clerk has time to
      // process the OAuth token params before any navigation fires. Prefer
      // EXPO_PUBLIC_APP_URL (the canonical origin registered in Clerk's
      // "Allowed redirect URLs") so the callback URL is predictable regardless
      // of which proxy domain Replit assigns; fall back to the current origin.
      // On native, AuthSession.makeRedirectUri() builds the app-scheme deep link.
      const redirectUrl =
        Platform.OS === "web"
          ? `${
              process.env.EXPO_PUBLIC_APP_URL ||
              (typeof window !== "undefined" ? window.location.origin : "")
            }/sso-callback`
          : AuthSession.makeRedirectUri();

      const { createdSessionId, setActive } = await startSSOFlow({
        strategy,
        redirectUrl,
      });

      // Native only — on web the full-page redirect above navigates away, so no
      // further code in this promise runs. If a session was created, activate it
      // and let AuthGate route the user.
      if (createdSessionId) {
        await setActive!({ session: createdSessionId });
        router.replace("/(tabs)");
      }
    },
    [startSSOFlow, router],
  );

  const handleGoogle = useCallback(async () => {
    if (googleLoading) return;
    setOauthError(null);
    setGoogleLoading(true);
    try {
      await runSSO("oauth_google");
    } catch (err) {
      const msg = err instanceof Error ? err.message : null;
      if (msg && !msg.toLowerCase().includes("cancel")) {
        setOauthError("Google sign-in failed. Please try again.");
      }
    } finally {
      setGoogleLoading(false);
    }
  }, [googleLoading, runSSO]);

  const handleApple = useCallback(async () => {
    if (appleLoading) return;
    setOauthError(null);
    setAppleLoading(true);
    try {
      await runSSO("oauth_apple");
    } catch (err) {
      const msg = err instanceof Error ? err.message : null;
      if (msg && !msg.toLowerCase().includes("cancel")) {
        setOauthError("Apple sign-in failed. Please try again.");
      }
    } finally {
      setAppleLoading(false);
    }
  }, [appleLoading, runSSO]);

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
