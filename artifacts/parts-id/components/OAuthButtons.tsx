import { useOAuth } from "@clerk/expo";
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
// WebBrowser.maybeCompleteAuthSession() is called at app startup in _layout.tsx —
// no need to call it again here.

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

  const { startOAuthFlow: startGoogle } = useOAuth({ strategy: "oauth_google" });
  const { startOAuthFlow: startApple } = useOAuth({ strategy: "oauth_apple" });

  const [googleLoading, setGoogleLoading] = useState(false);
  const [appleLoading, setAppleLoading] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);

  const handleGoogle = useCallback(async () => {
    if (googleLoading) return;
    setOauthError(null);
    setGoogleLoading(true);
    try {
      const { createdSessionId, setActive } = await startGoogle();
      if (createdSessionId) {
        await setActive!({ session: createdSessionId });
        router.replace("/(tabs)");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : null;
      if (msg && !msg.toLowerCase().includes("cancel")) {
        setOauthError("Google sign-in failed. Please try again.");
      }
    } finally {
      setGoogleLoading(false);
    }
  }, [googleLoading, startGoogle, router]);

  const handleApple = useCallback(async () => {
    if (appleLoading) return;
    setOauthError(null);
    setAppleLoading(true);
    try {
      const { createdSessionId, setActive } = await startApple();
      if (createdSessionId) {
        await setActive!({ session: createdSessionId });
        router.replace("/(tabs)");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : null;
      if (msg && !msg.toLowerCase().includes("cancel")) {
        setOauthError("Apple sign-in failed. Please try again.");
      }
    } finally {
      setAppleLoading(false);
    }
  }, [appleLoading, startApple, router]);

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
