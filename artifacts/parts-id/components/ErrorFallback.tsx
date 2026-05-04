/**
 * Visible fallback rendered by `ErrorBoundary` when a tree below it
 * throws. Designed to be obvious on the warehouse floor (large reset
 * button, clear copy) — the worker should always have a way out.
 *
 * Visual identity: Parts ID amber accent + Inter typography. Raw stack
 * traces are hidden behind a collapsible "Details" section so the screen
 * stays clean on the floor while still giving developers the info they need.
 */
import { Feather } from "@expo/vector-icons";
import { reloadAppAsync } from "expo";
import React, { useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";

export type ErrorFallbackProps = {
  error: Error;
  resetError: () => void;
};

export function ErrorFallback({ error, resetError }: ErrorFallbackProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();

  const [detailsOpen, setDetailsOpen] = useState(false);
  const [isModalVisible, setIsModalVisible] = useState(false);

  const handleRestart = async () => {
    try {
      await reloadAppAsync();
    } catch (restartError) {
      console.error("Failed to restart app:", restartError);
      resetError();
    }
  };

  const formatErrorDetails = (): string => {
    let details = `Error: ${error.message}\n\n`;
    if (error.stack) {
      details += `Stack Trace:\n${error.stack}`;
    }
    return details;
  };

  const monoFont = Platform.select({
    ios: "Menlo",
    android: "monospace",
    default: "monospace",
  });

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.background, paddingTop: insets.top + 24 },
      ]}
    >
      {/* Dev shortcut — tap the alert circle to open the full trace modal */}
      {__DEV__ ? (
        <Pressable
          onPress={() => setIsModalVisible(true)}
          accessibilityLabel="View error details"
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.devBtn,
            {
              top: insets.top + 12,
              backgroundColor: colors.card,
              borderColor: colors.border,
              opacity: pressed ? 0.7 : 1,
            },
          ]}
        >
          <Feather name="alert-circle" size={18} color={colors.destructive} />
        </Pressable>
      ) : null}

      <View style={styles.content}>
        {/* Amber accent bar — Parts ID brand mark */}
        <View style={[styles.accentBar, { backgroundColor: colors.primary }]} />

        <Text style={[styles.title, { color: colors.foreground }]}>
          App stopped unexpectedly
        </Text>

        <Text style={[styles.message, { color: colors.mutedForeground }]}>
          Restart the app to continue. Your data is safe.
        </Text>

        <Pressable
          onPress={handleRestart}
          style={({ pressed }) => [
            styles.button,
            {
              backgroundColor: colors.primary,
              opacity: pressed ? 0.88 : 1,
              transform: [{ scale: pressed ? 0.98 : 1 }],
            },
          ]}
        >
          <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>
            Restart App
          </Text>
        </Pressable>

        {/* Collapsible error summary — always available (not gated by __DEV__)
            so a floor worker can tap "Details" and read the error name to
            a support technician without needing dev tools. Stack trace is
            still kept behind the DEV modal to avoid noise in production. */}
        <Pressable
          onPress={() => setDetailsOpen(v => !v)}
          style={styles.detailsToggle}
          hitSlop={8}
        >
          <Text style={[styles.detailsToggleText, { color: colors.mutedForeground }]}>
            {detailsOpen ? "▲ Hide details" : "▼ Details"}
          </Text>
        </Pressable>

        {detailsOpen ? (
          <View
            style={[
              styles.errorSummary,
              { backgroundColor: colors.destructive + "0d", borderColor: colors.destructive + "33" },
            ]}
          >
            <Text
              style={[styles.errorSummaryText, { color: colors.destructive }]}
              selectable
              numberOfLines={__DEV__ ? undefined : 4}
            >
              {error.message || "Unknown error"}
            </Text>
          </View>
        ) : null}
      </View>

      {/* Dev-only full trace modal */}
      {__DEV__ ? (
        <Modal
          visible={isModalVisible}
          animationType="slide"
          transparent={true}
          onRequestClose={() => setIsModalVisible(false)}
        >
          <View style={styles.modalOverlay}>
            <View
              style={[
                styles.modalContainer,
                { backgroundColor: colors.background },
              ]}
            >
              <View
                style={[
                  styles.modalHeader,
                  { borderBottomColor: colors.border },
                ]}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <View style={[styles.modalAccent, { backgroundColor: colors.primary }]} />
                  <Text style={[styles.modalTitle, { color: colors.foreground }]}>
                    Error Details
                  </Text>
                </View>
                <Pressable
                  onPress={() => setIsModalVisible(false)}
                  accessibilityLabel="Close error details"
                  accessibilityRole="button"
                  style={({ pressed }) => [
                    styles.closeButton,
                    { opacity: pressed ? 0.6 : 1 },
                  ]}
                >
                  <Feather name="x" size={24} color={colors.foreground} />
                </Pressable>
              </View>

              <ScrollView
                style={styles.modalScrollView}
                contentContainerStyle={[
                  styles.modalScrollContent,
                  { paddingBottom: insets.bottom + 16 },
                ]}
                showsVerticalScrollIndicator
              >
                <View
                  style={[
                    styles.errorContainer,
                    { backgroundColor: colors.card, borderColor: colors.border },
                  ]}
                >
                  <Text
                    style={[
                      styles.errorText,
                      {
                        color: colors.foreground,
                        fontFamily: monoFont,
                      },
                    ]}
                    selectable
                  >
                    {formatErrorDetails()}
                  </Text>
                </View>
              </ScrollView>
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    width: "100%",
    height: "100%",
    alignItems: "center",
    padding: 24,
  },
  content: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    width: "100%",
    maxWidth: 480,
  },
  accentBar: {
    width: 48,
    height: 4,
    borderRadius: 2,
    marginBottom: 8,
  },
  title: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
    textAlign: "center",
    lineHeight: 32,
  },
  message: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 22,
  },
  devBtn: {
    position: "absolute",
    right: 16,
    width: 44,
    height: 44,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10,
  },
  button: {
    paddingVertical: 15,
    borderRadius: 8,
    paddingHorizontal: 32,
    minWidth: 200,
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 4,
    elevation: 3,
  },
  buttonText: {
    fontFamily: "Inter_700Bold",
    fontSize: 16,
  },
  detailsToggle: {
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  detailsToggleText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  errorSummary: {
    width: "100%",
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
  },
  errorSummaryText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    lineHeight: 18,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    justifyContent: "flex-end",
  },
  modalContainer: {
    width: "100%",
    height: "90%",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  modalAccent: {
    width: 4,
    height: 20,
    borderRadius: 2,
  },
  modalTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
  },
  closeButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  modalScrollView: { flex: 1 },
  modalScrollContent: { padding: 16 },
  errorContainer: {
    width: "100%",
    borderRadius: 8,
    borderWidth: 1,
    overflow: "hidden",
    padding: 16,
  },
  errorText: {
    fontSize: 12,
    lineHeight: 18,
    width: "100%",
  },
});
