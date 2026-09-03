import { useAuth } from "@clerk/expo";
import { useRouter, useSegments } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { useApp } from "@/contexts/AppContext";

const AUTH_GATE_TIMEOUT_MS = 15_000;

/**
 * Handles all post-auth navigation decisions.
 *
 * Exempt routes (never redirected away from):
 *   - /login, /sign-up  — unauthenticated entry points
 *   - /sso-callback     — Clerk is still processing the OAuth token; redirecting
 *                         here would cause a double-redirect bug
 *
 * Once isSignedIn flips to true, the user is sent to the appropriate screen
 * based on their approvalStatus.
 *
 * F-048: If isLoaded never becomes true or approvalStatus stays idle/loading for
 * more than 15 seconds, renders an error card with a "Try again" button that
 * resets the timer and re-triggers the Clerk session check.
 */
export function AuthGate() {
  const { isSignedIn, isLoaded: clerkLoaded } = useAuth();
  const { approvalStatus, recheckApprovalStatus } = useApp();
  const segments = useSegments();
  const router = useRouter();

  // F-048: Track whether the gate has timed out waiting for Clerk / approval.
  const [timedOut, setTimedOut] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Increment to restart the timeout after the user taps "Try again".
  const [retryKey, setRetryKey] = useState(0);

  // Arm (or re-arm) the 15s timeout whenever loading state resets.
  useEffect(() => {
    // Clear any previous timer first.
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setTimedOut(false);

    // If we're still waiting for Clerk or approval status, start the countdown.
    const stillWaiting =
      !clerkLoaded ||
      (isSignedIn && (approvalStatus === "idle" || approvalStatus === "loading"));

    if (stillWaiting) {
      timeoutRef.current = setTimeout(() => {
        setTimedOut(true);
      }, AUTH_GATE_TIMEOUT_MS);
    }

    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
    // retryKey is included so the timer re-arms when the user taps "Try again".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clerkLoaded, isSignedIn, approvalStatus, retryKey]);

  useEffect(() => {
    if (!clerkLoaded) return;

    const seg0 = segments[0] as string | undefined;
    const inTabs = seg0 === "(tabs)";
    const atLogin = seg0 === "login";
    const atSignUp = seg0 === "sign-up";
    const atPending = seg0 === "pending";
    const atBanned = seg0 === "banned";
    // Leave this route alone — Clerk is still processing the OAuth token params.
    const atSsoCallback = seg0 === "sso-callback";
    // Stack-level screens that are valid destinations for approved users.
    const atAdmin = seg0 === "admin";
    const atAdminInbox = seg0 === "admin-inbox";
    const atAdminAuditLog = seg0 === "admin-audit-log";
    const atAiLog = seg0 === "ai-log";
    const atCatalogReview = seg0 === "catalog-review";
    const atEditItem = seg0 === "edit-item";

    if (!isSignedIn) {
      if (!atLogin && !atSignUp && !atSsoCallback) router.replace({ pathname: "/login" });
    } else {
      if (approvalStatus === "loading" || approvalStatus === "idle") return;
      if (approvalStatus === "pending" && !atPending) {
        router.replace({ pathname: "/pending" });
      } else if (approvalStatus === "banned" && !atBanned) {
        router.replace({ pathname: "/banned" });
      } else if (
        approvalStatus === "approved" &&
        !inTabs &&
        !atAdmin &&
        !atAdminInbox &&
        !atAdminAuditLog &&
        !atAiLog &&
        !atCatalogReview &&
        !atEditItem
      ) {
        router.replace("/(tabs)");
      }
    }
  }, [isSignedIn, clerkLoaded, approvalStatus, segments, router]);

  // F-048: Show a timeout error card if Clerk or approval status never resolved.
  if (timedOut) {
    return (
      <View style={styles.overlay}>
        <View style={styles.card}>
          <Text style={[styles.title, { color: "#111" }]}>
            Taking too long to load
          </Text>
          <Text style={[styles.body, { color: "#555" }]}>
            We couldn't verify your account in time. Please try again.
          </Text>
          <Pressable
            style={styles.button}
            onPress={() => {
              if (!clerkLoaded) {
                // Clerk itself never initialized — the only real recovery is
                // returning to the login screen so Clerk re-mounts fresh.
                router.replace({ pathname: "/login" });
              } else {
                // Clerk is loaded but approval status is stuck — re-fetch and
                // restart the timeout.
                recheckApprovalStatus();
                setRetryKey((k) => k + 1);
              }
            }}
          >
            <Text style={styles.buttonText}>Try again</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // Keep protected routes covered while Clerk or the approval check settles.
  // Returning null here lets the stack's previous screen flash for one render.
  const waitingForAuth =
    !clerkLoaded ||
    (isSignedIn && (approvalStatus === "idle" || approvalStatus === "loading"));
  if (waitingForAuth) {
    return (
      <View style={styles.overlay}>
        <ActivityIndicator size="large" color="#2563eb" />
        <Text style={[styles.body, { color: "#555" }]}>Loading…</Text>
      </View>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.95)",
    padding: 32,
    zIndex: 999,
  },
  card: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 28,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    alignItems: "center",
    gap: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  title: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    textAlign: "center",
  },
  body: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 20,
  },
  button: {
    marginTop: 8,
    backgroundColor: "#2563eb",
    borderRadius: 8,
    paddingHorizontal: 24,
    paddingVertical: 12,
    alignItems: "center",
    width: "100%",
  },
  buttonText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: "#fff",
  },
});
