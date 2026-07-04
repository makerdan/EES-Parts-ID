import { useSignUp } from "@clerk/expo";
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

export default function SignUpScreen() {
  const colors = useColors();
  const router = useRouter();
  const { signUp, errors, fetchStatus } = useSignUp();

  const [emailAddress, setEmailAddress] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const loading = fetchStatus === "fetching";
  const awaitingVerification =
    signUp.status === "missing_requirements" &&
    signUp.unverifiedFields.includes("email_address") &&
    signUp.missingFields.length === 0;

  const handleSubmit = async () => {
    if (loading) return;
    if (!emailAddress.trim() || !password) {
      setLocalError("Email and password are required");
      return;
    }
    setLocalError(null);

    const { error } = await signUp.password({ emailAddress, password });
    if (error) {
      setLocalError(error.message ?? "Sign up failed. Please try again.");
      return;
    }

    if (!error) {
      await signUp.verifications.sendEmailCode();
    }
  };

  const handleVerify = async () => {
    if (loading || !code.trim()) return;
    setLocalError(null);

    await signUp.verifications.verifyEmailCode({ code });

    if (signUp.status === "complete") {
      await signUp.finalize({
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
    (errors?.fields?.emailAddress?.message ||
      errors?.fields?.password?.message ||
      errors?.fields?.code?.message ||
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
    hint: {
      fontSize: 13,
      color: colors.mutedForeground,
      marginBottom: 16,
      fontFamily: "Inter_400Regular",
      lineHeight: 18,
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
    secondaryButton: {
      marginTop: 12,
      borderRadius: colors.radius,
      paddingVertical: 12,
      alignItems: "center",
      borderWidth: 1,
      borderColor: colors.border,
    },
    secondaryButtonText: {
      fontSize: 14,
      color: colors.mutedForeground,
      fontFamily: "Inter_500Medium",
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
    captcha: { height: 0 },
  });

  if (awaitingVerification) {
    return (
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.container}
      >
        <View style={styles.card}>
          <Text style={styles.logo}>📧</Text>
          <Text style={styles.title}>Check your email</Text>
          <Text style={styles.subtitle}>
            We sent a verification code to{"\n"}
            <Text style={{ fontFamily: "Inter_600SemiBold", color: colors.foreground }}>
              {emailAddress}
            </Text>
          </Text>

          <Text style={styles.label}>Verification Code</Text>
          <KeyboardDoneInput
            style={[styles.input, displayError ? styles.inputError : null]}
            value={code}
            onChangeText={setCode}
            placeholder="Enter 6-digit code"
            placeholderTextColor={colors.mutedForeground}
            keyboardType="numeric"
            returnKeyType="go"
            onSubmitEditing={handleVerify}
          />

          {displayError ? <Text style={styles.error}>{displayError}</Text> : null}

          <Pressable
            style={[styles.button, (loading || !code.trim()) && { opacity: 0.6 }]}
            onPress={handleVerify}
            disabled={loading || !code.trim()}
          >
            {loading ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text style={styles.buttonText}>Verify Email →</Text>
            )}
          </Pressable>

          <Pressable
            style={styles.secondaryButton}
            onPress={() => signUp.verifications.sendEmailCode()}
            disabled={loading}
          >
            <Text style={styles.secondaryButtonText}>Resend code</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={styles.container}
    >
      <View style={styles.card}>
        <Text style={styles.logo}>⚡</Text>
        <Text style={styles.title}>Create Account</Text>
        <Text style={styles.subtitle}>
          Request access to Parts ID{"\n"}& warehouse lookup
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
          placeholder="Choose a password"
          placeholderTextColor={colors.mutedForeground}
          autoCapitalize="none"
          returnKeyType="go"
          onSubmitEditing={handleSubmit}
        />

        {displayError ? <Text style={styles.error}>{displayError}</Text> : null}

        <Pressable
          style={[styles.button, (loading || !emailAddress || !password) && { opacity: 0.6 }]}
          onPress={handleSubmit}
          disabled={loading || !emailAddress || !password}
        >
          {loading ? (
            <ActivityIndicator color={colors.primaryForeground} />
          ) : (
            <Text style={styles.buttonText}>Create Account →</Text>
          )}
        </Pressable>

        <OAuthButtons mode="sign-up" />

        <View style={styles.footer}>
          <Text style={styles.footerText}>Already have an account?</Text>
          <Link href="/login">
            <Text style={styles.footerLink}>Sign in</Text>
          </Link>
        </View>

        {/* Required for Clerk bot protection */}
        <View nativeID="clerk-captcha" style={styles.captcha} />
      </View>
    </KeyboardAvoidingView>
  );
}
