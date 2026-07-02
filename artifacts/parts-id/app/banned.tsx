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

export default function BannedScreen() {
  const colors = useColors();
  const { logout } = useApp();
  const [signingOut, setSigningOut] = React.useState(false);

  const handleSignOut = async () => {
    setSigningOut(true);
    await logout();
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
      borderColor: colors.destructive + "44",
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
      backgroundColor: colors.destructive + "20",
      borderRadius: 20,
      paddingHorizontal: 14,
      paddingVertical: 6,
      borderWidth: 1,
      borderColor: colors.destructive + "44",
    },
    badgeText: {
      fontSize: 12,
      fontFamily: "Inter_600SemiBold",
      color: colors.destructive,
      textTransform: "uppercase",
      letterSpacing: 1,
    },
    button: {
      marginTop: 8,
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
  });

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.icon}>🚫</Text>
        <Text style={styles.title}>Account Disabled</Text>
        <Text style={styles.body}>
          Your account has been disabled and you no longer have access to Parts ID.
          Contact an administrator if you believe this is an error.
        </Text>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>Access Revoked</Text>
        </View>
        <Pressable
          style={[styles.button, signingOut && { opacity: 0.6 }]}
          onPress={handleSignOut}
          disabled={signingOut}
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
