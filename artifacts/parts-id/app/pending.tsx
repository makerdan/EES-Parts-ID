import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useApp } from "@/contexts/AppContext";
import { useColors } from "@/hooks/useColors";

const POLL_INTERVAL_MS = 30_000;

export default function PendingScreen() {
  const colors = useColors();
  const { logout, recheckApprovalStatus, approvalStatus, showToast } = useApp();
  const [signingOut, setSigningOut] = React.useState(false);
  const [checkError, setCheckError] = React.useState(false);

  // F-049: inFlight ref prevents concurrent poll calls.
  const inFlight = React.useRef(false);

  // Wrap recheckApprovalStatus with the overlap guard.
  const safeRecheck = React.useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await recheckApprovalStatus();
      setCheckError(false);
    } catch {
      setCheckError(true);
    } finally {
      inFlight.current = false;
    }
  }, [recheckApprovalStatus]);

  // F-049: Fire one immediate check on mount (shown via the existing "loading"
  // approvalStatus indicator), then poll every 30s.
  React.useEffect(() => {
    // Immediate check on mount.
    safeRecheck();

    const id = setInterval(() => {
      safeRecheck();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(id);
    // safeRecheck is stable (useCallback with stable recheckApprovalStatus dep).
  }, [safeRecheck]);

  const checking = approvalStatus === "loading";

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await logout();
    } catch {
      showToast("Sign out failed. Please try again.", "error");
    } finally {
      setSigningOut(false);
    }
  };

  const handleCheckAgain = async () => {
    setCheckError(false);
    await safeRecheck();
  };

  const styles = StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
      justifyContent: "center",
      alignItems: "center",
      padding: 32,
    },
    card: {
      width: "100%",
      maxWidth: 380,
      backgroundColor: colors.card,
      borderRadius: 12,
      padding: 32,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: "center",
      gap: 12,
    },
    icon: { fontSize: 48 },
    title: {
      fontSize: 22,
      fontFamily: "Inter_700Bold",
      color: colors.foreground,
      textAlign: "center",
    },
    body: {
      fontSize: 15,
      fontFamily: "Inter_400Regular",
      color: colors.mutedForeground,
      textAlign: "center",
      lineHeight: 22,
    },
    badge: {
      backgroundColor: colors.accent,
      borderRadius: 20,
      paddingHorizontal: 14,
      paddingVertical: 6,
    },
    badgeText: {
      fontSize: 12,
      fontFamily: "Inter_600SemiBold",
      color: colors.accentForeground,
      textTransform: "uppercase",
      letterSpacing: 1,
    },
    checkButton: {
      marginTop: 8,
      width: "100%",
      borderRadius: 8,
      paddingVertical: 14,
      alignItems: "center",
      backgroundColor: colors.primary,
    },
    checkButtonText: {
      fontSize: 14,
      fontFamily: "Inter_600SemiBold",
      color: colors.primaryForeground,
    },
    button: {
      width: "100%",
      borderRadius: 8,
      paddingVertical: 14,
      alignItems: "center",
      borderWidth: 1,
      borderColor: colors.border,
    },
    buttonText: {
      fontSize: 14,
      fontFamily: "Inter_500Medium",
      color: colors.mutedForeground,
    },
    error: {
      fontSize: 13,
      fontFamily: "Inter_400Regular",
      color: colors.destructive,
      textAlign: "center",
    },
  });

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.icon}>⏳</Text>
        <Text style={styles.title}>Account Pending Approval</Text>
        <Text style={styles.body}>
          Your account has been created and is awaiting administrator approval.
          You'll be able to access Parts ID once an admin reviews your request.
        </Text>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>Pending Review</Text>
        </View>
        {checkError ? <Text style={styles.error}>Check failed — tap to retry</Text> : null}
        <Pressable
          style={[styles.checkButton, checking && { opacity: 0.6 }]}
          onPress={handleCheckAgain}
          disabled={checking || signingOut}
        >
          {checking ? (
            <ActivityIndicator size="small" color={colors.primaryForeground} />
          ) : (
            <Text style={styles.checkButtonText}>Check Again</Text>
          )}
        </Pressable>
        <Pressable
          style={[styles.button, signingOut && { opacity: 0.6 }]}
          onPress={handleSignOut}
          disabled={signingOut || checking}
        >
          {signingOut ? (
            <ActivityIndicator size="small" color={colors.mutedForeground} />
          ) : (
            <Text style={styles.buttonText}>Sign Out</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}
