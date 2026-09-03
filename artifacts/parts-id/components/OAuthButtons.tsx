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

import { useApp } from "@/contexts/AppContext";
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
  const { showToast } = useApp();

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

  // Single shared loading flag so only one OAuth provider can be in flight at a
  // time, and both buttons are disabled while the flow is running (F-046).
  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
  // Per-attempt token: incremented each time a new attempt starts so that a
  // stale attempt that resolves after the 60s timeout (or after a new attempt
  // begins) cannot mutate the state owned by the current attempt (F-046).
  const attemptTokenRef = React.useRef(0);
  const oauthTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const runOAuth = useCallback(
    async (strategy: "oauth_google" | "oauth_apple") => {
      // Build the /sso-callback URL. Prefer EXPO_PUBLIC_APP_URL (the canonical
      // origin registered in Clerk's "Allowed redirect URLs") so the callback
      // URL is predictable regardless of which proxy domain Replit assigns;
      // fall back to the current origin for local dev.
      if (Platform.OS === "web") {
        const signIn = clerk.client?.signIn;
        if (!signIn || typeof signIn.authenticateWithRedirect !== "function") {
          throw new Error("Web sign-in is unavailable. Please try again.");
        }
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

  // Shared handler: sets the single oauthLoading flag, arms a 60s timeout that
  // clears loading and shows an error if the flow never resolves (F-046).
  // A per-attempt token prevents a stale attempt that resolves after the timeout
  // (or after a new attempt has started) from mutating state it no longer owns.
  const handleOAuth = useCallback(
    async (strategy: "oauth_google" | "oauth_apple") => {
      if (oauthLoading) return;
      setOauthError(null);
      setOauthLoading(true);

      // Mint a token for this attempt. Any callback that sees a different token
      // knows it is stale and must not touch loading/error state.
      attemptTokenRef.current += 1;
      const myToken = attemptTokenRef.current;

      // Start 60s timeout — fires only if this token is still the active one.
      oauthTimeoutRef.current = setTimeout(() => {
        if (attemptTokenRef.current !== myToken) return; // stale
        setOauthLoading(false);
        const timeoutMsg = "Sign-in timed out. Please try again.";
        setOauthError(timeoutMsg);
        // Persist via toast so the message survives navigation to sign-up/login.
        showToast(timeoutMsg, "error");
      }, 60_000);

      try {
        await runOAuth(strategy);
      } catch (err) {
        if (attemptTokenRef.current !== myToken) return; // stale
        const msg = err instanceof Error ? err.message : null;
        if (msg && !msg.toLowerCase().includes("cancel")) {
          const provider = strategy === "oauth_google" ? "Google" : "Apple";
          const failMsg = `${provider} sign-in failed. Please try again.`;
          setOauthError(failMsg);
          // Persist via toast so the message survives navigation to sign-up/login.
          showToast(failMsg, "error");
        }
      } finally {
        if (attemptTokenRef.current === myToken) {
          // This attempt still owns the UI — cancel the timeout and clear loading.
          if (oauthTimeoutRef.current !== null) {
            clearTimeout(oauthTimeoutRef.current);
            oauthTimeoutRef.current = null;
          }
          setOauthLoading(false);
        }
      }
    },
    [oauthLoading, runOAuth, showToast],
  );

  const handleGoogle = useCallback(
    () => handleOAuth("oauth_google"),
    [handleOAuth],
  );

  const handleApple = useCallback(
    () => handleOAuth("oauth_apple"),
    [handleOAuth],
  );

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
        style={[s.oauthButton, oauthLoading && { opacity: 0.6 }]}
        onPress={handleGoogle}
        disabled={oauthLoading}
      >
        {oauthLoading ? (
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
          style={[s.oauthButton, oauthLoading && { opacity: 0.6 }]}
          onPress={handleApple}
          disabled={oauthLoading}
        >
          {oauthLoading ? (
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
