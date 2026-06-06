import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { KeyboardDoneInput } from "@/components/KeyboardDoneInput";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useColors } from "@/hooks/useColors";
import { DismissKeyboard } from "@/components/DismissKeyboard";

const DEVICE_TOKEN_KEY = "contact_device_token";

function makeDeviceToken(): string {
  const rand = () => Math.random().toString(36).slice(2, 9);
  return `dev_${rand()}${rand()}`;
}

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : "";

type Props = {
  visible: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  senderToken?: string;
};

export function ContactSheet({ visible, onClose, onSuccess, senderToken }: Props) {
  const colors = useColors();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deviceToken, setDeviceToken] = useState<string>("anonymous");

  useEffect(() => {
    AsyncStorage.getItem(DEVICE_TOKEN_KEY)
      .then((stored) => {
        if (stored) {
          setDeviceToken(stored);
        } else {
          const fresh = makeDeviceToken();
          setDeviceToken(fresh);
          AsyncStorage.setItem(DEVICE_TOKEN_KEY, fresh).catch(() => {});
        }
      })
      .catch(() => {});
  }, []);

  const subjectEmpty = !subject.trim();
  const bodyEmpty = !body.trim();
  const canSubmit = !subjectEmpty && !bodyEmpty && !submitting;

  const handleClose = () => {
    if (submitting) return;
    setSubject("");
    setBody("");
    setError(null);
    onClose();
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/contact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: subject.trim(),
          body: body.trim(),
          senderToken: senderToken ?? deviceToken,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Server error ${res.status}`);
      }
      setSubject("");
      setBody("");
      setError(null);
      onSuccess?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send — please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={[styles.container, { backgroundColor: colors.background }]}
      >
        <DismissKeyboard>
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <View>
            <Text style={[styles.title, { color: colors.foreground }]}>Contact Admin</Text>
            <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
              Send a message or report an issue
            </Text>
          </View>
          <Pressable
            onPress={handleClose}
            style={[styles.closeBtn, { backgroundColor: colors.muted }]}
            disabled={submitting}
          >
            <Text style={[styles.closeText, { color: colors.foreground }]}>✕</Text>
          </Pressable>
        </View>

        {/* Form */}
        <View style={styles.form}>
          <Text style={[styles.label, { color: colors.mutedForeground }]}>SUBJECT</Text>
          <KeyboardDoneInput
            value={subject}
            onChangeText={setSubject}
            placeholder="Brief description of your issue or question"
            placeholderTextColor={colors.mutedForeground}
            style={[
              styles.input,
              {
                backgroundColor: colors.muted,
                color: colors.foreground,
                borderColor: subjectEmpty && error ? colors.destructive : colors.border,
              },
            ]}
            returnKeyType="next"
            editable={!submitting}
          />

          <Text style={[styles.label, { color: colors.mutedForeground, marginTop: 16 }]}>
            MESSAGE
          </Text>
          <KeyboardDoneInput
            value={body}
            onChangeText={setBody}
            placeholder="Describe what you need or what went wrong…"
            placeholderTextColor={colors.mutedForeground}
            style={[
              styles.textarea,
              {
                backgroundColor: colors.muted,
                color: colors.foreground,
                borderColor: bodyEmpty && error ? colors.destructive : colors.border,
              },
            ]}
            multiline
            numberOfLines={5}
            textAlignVertical="top"
            editable={!submitting}
          />

          {error ? (
            <Text style={[styles.errorText, { color: colors.destructive }]}>⚠ {error}</Text>
          ) : null}

          <Pressable
            onPress={handleSubmit}
            disabled={!canSubmit}
            style={[
              styles.submitBtn,
              {
                backgroundColor: canSubmit ? colors.primary : colors.border,
                opacity: canSubmit ? 1 : 0.7,
              },
            ]}
          >
            {submitting ? (
              <ActivityIndicator size="small" color={colors.primaryForeground} />
            ) : (
              <Text style={[styles.submitText, { color: colors.primaryForeground }]}>
                Send Message
              </Text>
            )}
          </Pressable>
        </View>
        </DismissKeyboard>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
  },
  title: { fontSize: 18, fontFamily: "Inter_700Bold" },
  subtitle: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  closeText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  form: { padding: 20, gap: 6, flex: 1 },
  label: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  textarea: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    minHeight: 120,
  },
  errorText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    marginTop: 8,
  },
  submitBtn: {
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 24,
  },
  submitText: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
});
