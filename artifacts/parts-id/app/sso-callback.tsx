import { useClerk } from "@clerk/expo";
import { useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useColors } from "@/hooks/useColors";

const SSO_TIMEOUT_MS = 30_000;

function getSsoErrorMessage(error: unknown): {
  title: string;
  body: string;
} {
  const rawMessage =
    error && typeof error === "object" && "errors" in error
      ? ((error as { errors?: Array<{ message?: unknown; code?: unknown }> }).errors?.[0]
          ?.message ?? "")
      : error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "";
  const message = String(rawMessage).toLowerCase();

  if (message.includes("cancel")) {
    return {
      title: "Sign-in cancelled",
      body: "Sign-in was cancelled. Please try again when you're ready.",
    };
  }
  if (message.includes("expired") || message.includes("session")) {
    return {
      title: "Sign-in session expired",
      body: "Your sign-in session expired. Please go back and try again.",
    };
  }
  if (
    message.includes("provider") ||
    message.includes("oauth") ||
    message.includes("redirect") ||
    message.includes("network") ||
    message.includes("connection")
  ) {
    return {
      title: "Sign-in provider error",
      body: "The sign-in provider couldn't complete the request. Please try again.",
    };
  }
  return {
    title: "Unable to complete sign-in",
    body: "We couldn't complete sign-in. Please go back and try again.",
  };
}

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
 *
 * F-047: Detects missing/invalid OAuth params on mount and shows an immediate
 * error rather than an infinite spinner. Also arms a 30s timeout that replaces
 * the spinner with a recoverable error if handleRedirectCallback never resolves.
 */
export default function SsoCallback() {
  const colors = useColors();
  const clerk = useClerk();
  const router = useRouter();

  // "timedOut" = callback never resolved within SSO_TIMEOUT_MS
  // "missingParams" = URL arrived without the required OAuth params (F-047)
  const [errorKind, setErrorKind] = useState<
    "timedOut" | "missingParams" | "callbackError" | null
  >(null);
  const [callbackError, setCallbackError] = useState<{
    title: string;
    body: string;
  } | null>(null);

  useEffect(() => {
    if (Platform.OS !== "web") return;

    // F-047: Check for required OAuth params before attempting the callback.
    // A URL with no `code` or `state` query param (e.g. a direct navigation to
    // /sso-callback) would cause handleRedirectCallback to spin forever.
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const hasCode = params.has("code") || params.has("state");
      if (!hasCode) {
        setErrorKind("missingParams");
        return;
      }
    }

    let cancelled = false;

    // F-047: 30s timeout — show a recoverable error state if the flow hangs.
    const timeoutId = setTimeout(() => {
      if (!cancelled) setErrorKind("timedOut");
    }, SSO_TIMEOUT_MS);

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
        (to: string) => {
          // @ts-ignore — Clerk passes arbitrary strings; expo-router typed routes
          // require a const literal, but the runtime behaviour is identical.
          if (!cancelled) router.replace(to);
          return Promise.resolve();
        },
      )
      .catch((error: unknown) => {
        // Keep callback failures visible instead of silently redirecting away.
        if (!cancelled) {
          setCallbackError(getSsoErrorMessage(error));
          setErrorKind("callbackError");
        }
      })
      .finally(() => {
        clearTimeout(timeoutId);
      });

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [clerk, router]);

  const s = StyleSheet.create({
    container: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: 16,
      padding: 32,
    },
    label: {
      fontSize: 15,
      fontFamily: "Inter_400Regular",
    },
    errorTitle: {
      fontSize: 17,
      fontFamily: "Inter_600SemiBold",
      textAlign: "center",
    },
    errorBody: {
      fontSize: 14,
      fontFamily: "Inter_400Regular",
      textAlign: "center",
      lineHeight: 20,
    },
    button: {
      marginTop: 8,
      paddingHorizontal: 24,
      paddingVertical: 12,
      borderRadius: 8,
      alignItems: "center",
    },
    buttonText: {
      fontSize: 14,
      fontFamily: "Inter_600SemiBold",
    },
  });

  if (errorKind) {
    const callbackErrorContent =
      errorKind === "callbackError" ? callbackError : null;
    const title =
      callbackErrorContent?.title ??
      (errorKind === "timedOut"
        ? "Sign-in taking too long"
        : "Sign-in link invalid");
    const body =
      callbackErrorContent?.body ??
      (errorKind === "timedOut"
        ? "The sign-in process didn't complete in time. Please go back and try again."
        : "This link doesn't contain valid sign-in parameters. Please go back and try again.");

    return (
      <View style={[s.container, { backgroundColor: colors.background }]}>
        <Text style={[s.errorTitle, { color: colors.foreground }]}>{title}</Text>
        <Text style={[s.errorBody, { color: colors.mutedForeground }]}>{body}</Text>
        <Pressable
          style={[s.button, { backgroundColor: colors.primary }]}
          onPress={() => router.replace({ pathname: "/login" })}
        >
          <Text style={[s.buttonText, { color: colors.primaryForeground }]}>
            Go back to sign-in
          </Text>
        </Pressable>
      </View>
    );
  }

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
