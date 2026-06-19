import { router } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { KeyboardDoneInput } from "@/components/KeyboardDoneInput";
import { useApp } from "@/contexts/AppContext";
import { useColors } from "@/hooks/useColors";

export default function LoginScreen() {
  const colors = useColors();
  const { login } = useApp();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (loading) return;
    if (!password.trim()) {
      setError("Password required");
      return;
    }
    setLoading(true);
    setError(null);
    const result = await login(password);
    setLoading(false);
    if (result.success) {
      router.replace("/(tabs)");
    } else {
      setError(result.error ?? "Incorrect password");
    }
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
      borderTopLeftRadius: 10,
      borderTopRightRadius: 10,
      borderBottomRightRadius: 10,
      borderBottomLeftRadius: 10,
      padding: 32,
      borderWidth: 1,
      borderColor: colors.border,
    },
    logo: {
      fontSize: 40,
      textAlign: "center",
      marginBottom: 8,
    },
    title: {
      fontSize: 26,
      fontWeight: "700",
      color: colors.foreground,
      textAlign: "center",
      fontFamily: "Inter_700Bold",
      letterSpacing: -0.5,
    },
    subtitle: {
      fontSize: 14,
      color: colors.mutedForeground,
      textAlign: "center",
      marginTop: 6,
      marginBottom: 28,
      fontFamily: "Inter_400Regular",
    },
    label: {
      fontSize: 13,
      fontWeight: "600",
      color: colors.foreground,
      marginBottom: 8,
      fontFamily: "Inter_600SemiBold",
      letterSpacing: 0.5,
      textTransform: "uppercase",
    },
    input: {
      borderWidth: 1,
      borderColor: colors.input,
      backgroundColor: colors.muted,
      borderRadius: colors.radius,
      paddingHorizontal: 16,
      paddingVertical: 14,
      fontSize: 16,
      color: colors.foreground,
      fontFamily: "Inter_400Regular",
    },
    error: {
      fontSize: 13,
      color: colors.destructive,
      marginTop: 8,
      fontFamily: "Inter_400Regular",
    },
    button: {
      marginTop: 20,
      backgroundColor: colors.primary,
      borderRadius: colors.radius,
      paddingVertical: 15,
      alignItems: "center",
    },
    buttonText: {
      fontSize: 15,
      fontWeight: "700",
      color: colors.primaryForeground,
      fontFamily: "Inter_700Bold",
    },
    badge: {
      marginTop: 24,
      backgroundColor: colors.accent,
      borderRadius: colors.radius,
      paddingHorizontal: 12,
      paddingVertical: 6,
      alignSelf: "center",
    },
    badgeText: {
      fontSize: 11,
      color: colors.accentForeground,
      fontFamily: "Inter_500Medium",
      textTransform: "uppercase",
      letterSpacing: 1,
    },
  });

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={styles.container}
    >
      <View style={styles.card}>
        <Text style={styles.logo}>⚡</Text>
        <Text style={styles.title}>Parts ID</Text>
        <Text style={styles.subtitle}>
          Electrical parts identification{"\n"}& warehouse lookup
        </Text>
        <Text style={styles.label}>Password</Text>
        <KeyboardDoneInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          placeholder="Enter warehouse password"
          placeholderTextColor={colors.mutedForeground}
          autoCapitalize="none"
          onSubmitEditing={handleLogin}
          returnKeyType="go"
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Pressable
          style={[styles.button, loading && { opacity: 0.6 }]}
          onPress={handleLogin}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color={colors.primaryForeground} />
          ) : (
            <Text style={styles.buttonText}>Unlock →</Text>
          )}
        </Pressable>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>🔒 Warehouse Access Only</Text>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
