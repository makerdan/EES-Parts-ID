import { useSignIn } from "@clerk/expo";
import { Link, useRouter } from "expo-router";
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
import { OAuthButtons } from "@/components/OAuthButtons";
import { useColors } from "@/hooks/useColors";

export default function LoginScreen() {
  const colors = useColors();
  const router = useRouter();
  const { signIn, errors, fetchStatus } = useSignIn();

  const [emailAddress, setEmailAddress] = useState("");
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const loading = fetchStatus === "fetching";

  const handleSubmit = async () => {
    if (loading) return;
    if (!emailAddress.trim() || !password) {
      setLocalError("Email and password are required");
      return;
    }
    setLocalError(null);

    const { error } = await signIn.password({ emailAddress, password });
    if (error) {
      setLocalError(error.message ?? "Sign in failed. Please try again.");
      return;
    }

    if (signIn.status === "complete") {
      await signIn.finalize({
        navigate: ({ decorateUrl }) => {
          const url = decorateUrl("/");
          if (typeof window !== "undefined" && url.startsWith("http")) {
            window.location.href = url;
          } else {
            router.replace("/(tabs)");
          }
        },
      });
    }
  };

  const displayError =
    localError ??
    (errors?.fields?.identifier?.message ||
      errors?.fields?.password?.message ||
      null);

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
      borderRadius: 10,
      padding: 32,
      borderWidth: 1,
      borderColor: colors.border,
    },
    logo: { fontSize: 40, textAlign: "center", marginBottom: 8 },
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
      marginBottom: 16,
    },
    inputError: { borderColor: colors.destructive },
    error: {
      fontSize: 13,
      color: colors.destructive,
      marginBottom: 8,
      fontFamily: "Inter_400Regular",
    },
    button: {
      marginTop: 4,
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
    footer: {
      marginTop: 20,
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "center",
      gap: 4,
    },
    footerText: {
      fontSize: 13,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
    },
    footerLink: {
      fontSize: 13,
      color: colors.primary,
      fontFamily: "Inter_600SemiBold",
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

        <Text style={styles.label}>Email</Text>
        <KeyboardDoneInput
          style={[styles.input, displayError ? styles.inputError : null]}
          value={emailAddress}
          onChangeText={setEmailAddress}
          placeholder="Enter your email"
          placeholderTextColor={colors.mutedForeground}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
          returnKeyType="next"
        />

        <Text style={styles.label}>Password</Text>
        <KeyboardDoneInput
          style={[styles.input, displayError ? styles.inputError : null]}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          placeholder="Enter your password"
          placeholderTextColor={colors.mutedForeground}
          autoCapitalize="none"
          returnKeyType="go"
          onSubmitEditing={handleSubmit}
        />

        {displayError ? <Text style={styles.error}>{displayError}</Text> : null}

        <Pressable
          style={[styles.button, loading && { opacity: 0.6 }]}
          onPress={handleSubmit}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color={colors.primaryForeground} />
          ) : (
            <Text style={styles.buttonText}>Sign In →</Text>
          )}
        </Pressable>

        <OAuthButtons mode="sign-in" />

        <View style={styles.footer}>
          <Text style={styles.footerText}>Don&apos;t have an account?</Text>
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          <Link href={"/sign-up" as any}>
            <Text style={styles.footerLink}>Sign up</Text>
          </Link>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
