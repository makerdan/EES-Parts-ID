import React from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useColors } from "@/hooks/useColors";

export interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const colors = useColors();
  const confirmBg = destructive ? colors.destructive : colors.primary;
  const confirmFg = destructive ? colors.destructiveForeground : colors.primaryForeground;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <View style={[dialogStyles.overlay, { backgroundColor: colors.overlay }]}>
        <View style={[dialogStyles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[dialogStyles.title, { color: colors.foreground }]}>{title}</Text>
          {message ? (
            <Text style={[dialogStyles.message, { color: colors.mutedForeground }]}>{message}</Text>
          ) : null}
          <View style={dialogStyles.actions}>
            <Pressable
              onPress={onCancel}
              style={[dialogStyles.cancelBtn, { borderColor: colors.border, backgroundColor: colors.muted }]}
            >
              <Text style={[dialogStyles.cancelText, { color: colors.foreground }]}>{cancelLabel}</Text>
            </Pressable>
            <Pressable
              onPress={onConfirm}
              style={[dialogStyles.confirmBtn, { backgroundColor: confirmBg }]}
            >
              <Text style={[dialogStyles.confirmText, { color: confirmFg }]}>{confirmLabel}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

export interface InfoDialogProps {
  visible: boolean;
  title: string;
  message?: string;
  dismissLabel?: string;
  onDismiss: () => void;
}

export function InfoDialog({
  visible,
  title,
  message,
  dismissLabel = "OK",
  onDismiss,
}: InfoDialogProps) {
  const colors = useColors();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onDismiss}
    >
      <View style={[dialogStyles.overlay, { backgroundColor: colors.overlay }]}>
        <View style={[dialogStyles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[dialogStyles.title, { color: colors.foreground }]}>{title}</Text>
          {message ? (
            <Text style={[dialogStyles.message, { color: colors.mutedForeground }]}>{message}</Text>
          ) : null}
          <View style={dialogStyles.actions}>
            <Pressable
              onPress={onDismiss}
              style={[dialogStyles.confirmBtn, { flex: 1, backgroundColor: colors.primary }]}
            >
              <Text style={[dialogStyles.confirmText, { color: colors.primaryForeground }]}>{dismissLabel}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const dialogStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
  card: {
    width: "100%",
    maxWidth: 380,
    borderRadius: 8,
    borderWidth: 1,
    padding: 24,
    gap: 12,
  },
  title: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    lineHeight: 24,
  },
  message: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
  },
  actions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  cancelBtn: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
  },
  cancelText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  confirmBtn: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
  },
  confirmText: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
  },
});
