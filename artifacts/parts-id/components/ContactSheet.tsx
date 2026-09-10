import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { DismissKeyboard } from "@/components/DismissKeyboard";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { KeyboardDoneInput } from "@/components/KeyboardDoneInput";
import { useColors } from "@/hooks/useColors";
import { API_BASE } from "@/utils/apiBase";
import { fetchWithAuth } from "@/utils/appAuth";

const DEVICE_TOKEN_KEY = "contact_device_token";

const MAX_SUBJECT_LENGTH = 200;
function makeDeviceToken(): string {
  const rand = () => Math.random().toString(36).slice(2, 9);
  return `dev_${rand()}${rand()}`;
}

async function getOrCreateDeviceToken(): Promise<DeviceTokenResult> {
  const stored = await AsyncStorage.getItem(DEVICE_TOKEN_KEY);
  if (stored) return { token: stored, persisted: true };

  const token = makeDeviceToken();
  try {
    await AsyncStorage.setItem(DEVICE_TOKEN_KEY, token);
    return { token, persisted: true };
  } catch {
    return { token, persisted: false };
  }
}
type Props = {
  visible: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  senderToken?: string;
  initialSubject?: string;
  initialBody?: string;
};

type ContactResponse = {
  id?: number | string;
  error?: string;
  retryAfterMs?: number;
};
export function ContactSheet({
  visible,
  onClose,
  onSuccess,
  senderToken,
  initialSubject,
  initialBody,
}: Props) {
  "use no memo";

  const colors = useColors();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deviceToken, setDeviceToken] = useState<string>("anonymous");
  const [deviceTokenWarning, setDeviceTokenWarning] = useState(false);
  const [validationAttempted, setValidationAttempted] = useState(false);
  const [successReference, setSuccessReference] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const submitInFlightRef = useRef(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (senderToken) return;
    getOrCreateDeviceToken()
      .then(({ token, persisted }) => {
        if (!isMountedRef.current) return;
        setDeviceToken(token);
        setDeviceTokenWarning(!persisted);
      })
      .catch(() => {
        if (!isMountedRef.current) return;
        setDeviceToken("anonymous");
        setDeviceTokenWarning(true);
      });
  }, [senderToken]);

  useEffect(() => {
    if (!visible) return;
    setSubject(initialSubject?.trim() ?? "");
    setBody(initialBody?.trim() ?? "");
    setError(null);
  }, [initialBody, initialSubject, visible]);

  const subjectEmpty = !subject.trim();
  const bodyEmpty = !body.trim();
  const canSubmit = !submitting;

  const handleClose = () => {
    if (submitting) return;
    if (successReference) {
      setSubject("");
      setBody("");
      setError(null);
      setValidationAttempted(false);
      setSuccessReference(null);
    }
    onClose();
  };

  const handleSubmit = async () => {
    if (submitInFlightRef.current) return;
    setValidationAttempted(true);
    if (subjectEmpty || bodyEmpty) {
      setError("Enter a subject and message before sending.");
      return;
    }

    submitInFlightRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      let token = senderToken ?? deviceToken;
      if (!senderToken && (token === "anonymous" || deviceTokenWarning)) {
        try {
          const tokenResult = await getOrCreateDeviceToken();
          token = tokenResult.token;
          if (isMountedRef.current) {
            setDeviceToken(tokenResult.token);
            setDeviceTokenWarning(!tokenResult.persisted);
          }
        } catch {
          token = "anonymous";
          if (isMountedRef.current) setDeviceTokenWarning(true);
        }
      }

      const res = await fetchWithAuth(`${API_BASE}/contact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: subject.trim(),
          body: body.trim(),
          senderToken: token,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as ContactResponse;
        if (res.status === 429) {
          throw new Error(
            `Support is receiving a lot of messages. Please wait before trying again.${retryAfterLabel(data.retryAfterMs)}`,
          );
        }
        if (res.status >= 500) {
          throw new Error("Support is temporarily unavailable. Your message is still here — try again.");
        }
        if (res.status === 401 || res.status === 403) {
          throw new Error("Your session could not be verified. Please sign in again and retry.");
        }
        throw new Error(data.error ?? "We couldn’t send your message. Please check it and try again.");
      }

      const data = (await res.json().catch(() => ({}))) as ContactResponse;
      if (!isMountedRef.current) return;
      setSubject("");
      setBody("");
      setError(null);
      setValidationAttempted(false);
      setSuccessReference(data.id != null ? `#${data.id}` : "received");
      onSuccess?.();
    } catch (err) {
      if (!isMountedRef.current) return;
      if (err instanceof Error && err.message) {
        const message = err.message.toLowerCase();
        const isNetworkFailure =
          message.includes("network") ||
          message.includes("fetch") ||
          message.includes("offline") ||
          message.includes("failed to connect") ||
          message.includes("timeout") ||
          message.includes("abort");
        setError(isNetworkFailure ? networkErrorMessage(err) : err.message);
      } else {
        setError(networkErrorMessage(err));
      }
    } finally {
      submitInFlightRef.current = false;
      if (isMountedRef.current) setSubmitting(false);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <DismissKeyboard>
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <View>
              <Text style={[styles.title, { color: colors.foreground }]}>Contact Admin</Text>
              <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
                Send a message or report an issue
              </Text>
            </View>
            <Pressable
              onPress={handleClose}
              accessibilityRole="button"
              accessibilityLabel={successReference ? "Close contact confirmation" : "Close Contact"}
              style={[styles.closeBtn, { backgroundColor: colors.muted }]}
              disabled={submitting}
            >
              <Text style={[styles.closeText, { color: colors.foreground }]}>✕</Text>
            </Pressable>
          </View>

          <KeyboardAwareScrollViewCompat
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            bottomOffset={24}
          >
            {successReference ? (
              <View
                accessible
                accessibilityLiveRegion="polite"
                style={[
                  styles.successCard,
                  { backgroundColor: colors.success + "15", borderColor: colors.success + "55" },
                ]}
              >
                <Text style={[styles.successTitle, { color: colors.success }]}>Message sent to support</Text>
                <Text style={[styles.successText, { color: colors.foreground }]}>
                  Your message was received. Support can follow up in the admin inbox.
                </Text>
                <Text style={[styles.successReference, { color: colors.mutedForeground }]}>
                  Reference {successReference}
                </Text>
                <Pressable
                  onPress={handleClose}
                  accessibilityRole="button"
                  style={[styles.submitBtn, { backgroundColor: colors.primary }]}
                >
                  <Text style={[styles.submitText, { color: colors.primaryForeground }]}>Done</Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.form}>
                {deviceTokenWarning ? (
                  <View
                    style={[
                      styles.notice,
                      { backgroundColor: colors.warning + "15", borderColor: colors.warning + "55" },
                    ]}
                  >
                    <Text style={[styles.noticeText, { color: colors.warning }]}>
                      Message grouping is temporarily unavailable, but you can still send this message.
                    </Text>
                  </View>
                ) : null}

                <Text style={[styles.label, { color: colors.mutedForeground }]}>SUBJECT</Text>
                <KeyboardDoneInput
                  value={subject}
                  onChangeText={(value) => {
                    setSubject(value);
                    if (error && value.trim()) setError(null);
                  }}
                  placeholder="Brief description of your issue or question"
                  placeholderTextColor={colors.mutedForeground}
                  maxLength={MAX_SUBJECT_LENGTH}
                  accessibilityLabel="Contact subject"
                  style={[
                    styles.input,
                    {
                      backgroundColor: colors.muted,
                      color: colors.foreground,
                      borderColor: subjectEmpty && validationAttempted ? colors.destructive : colors.border,
                    },
                  ]}
                  returnKeyType="next"
                  editable={!submitting}
                />
                {subjectEmpty && validationAttempted ? (
                  <Text style={[styles.fieldError, { color: colors.destructive }]}>Enter a subject.</Text>
                ) : null}

                <Text style={[styles.label, { color: colors.mutedForeground, marginTop: 16 }]}>
                  MESSAGE
                </Text>
                <KeyboardDoneInput
                  value={body}
                  onChangeText={(value) => {
                    setBody(value);
                    if (error && value.trim()) setError(null);
                  }}
                  placeholder="Describe what you need or what went wrong…"
                  placeholderTextColor={colors.mutedForeground}
                  maxLength={MAX_BODY_LENGTH}
                  accessibilityLabel="Contact message"
                  style={[
                    styles.textarea,
                    {
                      backgroundColor: colors.muted,
                      color: colors.foreground,
                      borderColor: bodyEmpty && validationAttempted ? colors.destructive : colors.border,
                    },
                  ]}
                  multiline
                  numberOfLines={5}
                  textAlignVertical="top"
                  editable={!submitting}
                />
                {bodyEmpty && validationAttempted ? (
                  <Text style={[styles.fieldError, { color: colors.destructive }]}>Enter a message.</Text>
                ) : null}

                {error ? (
                  <Text accessibilityLiveRegion="polite" style={[styles.errorText, { color: colors.destructive }]}>
                    ⚠ {error}
                  </Text>
                ) : null}

                <Pressable
                  onPress={handleSubmit}
                  disabled={!canSubmit}
                  accessibilityRole="button"
                  accessibilityLabel="Send Contact message"
                  accessibilityState={{ disabled: !canSubmit, busy: submitting }}
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
            )}
          </KeyboardAwareScrollViewCompat>
        </DismissKeyboard>
      </View>
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
  scrollContent: { flexGrow: 1 },
  form: { padding: 20, gap: 6 },
  notice: { borderWidth: 1, borderRadius: 8, padding: 10, marginBottom: 6 },
  noticeText: { fontSize: 12, fontFamily: "Inter_400Regular", lineHeight: 18 },
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
  fieldError: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  errorText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 19,
    marginTop: 8,
  },
  successCard: {
    margin: 20,
    borderWidth: 1,
    borderRadius: 12,
    padding: 18,
  },
  successTitle: { fontSize: 18, fontFamily: "Inter_700Bold" },
  successText: { fontSize: 14, fontFamily: "Inter_400Regular", lineHeight: 21, marginTop: 8 },
  successReference: { fontSize: 12, fontFamily: "Inter_500Medium", marginTop: 12 },
  submitBtn: {
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 24,
  },
  submitText: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
});

type DeviceTokenResult = {
  token: string;
  persisted: boolean;
};

const MAX_BODY_LENGTH = 5_000;

function retryAfterLabel(retryAfterMs: number | undefined): string {
  if (!retryAfterMs || retryAfterMs <= 0) return "";
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1_000));
  return ` Try again in about ${seconds} second${seconds === 1 ? "" : "s"}.`;
}

function networkErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("abort") || message.includes("timeout")) {
    return "The request took too long to finish. Your message is still here — try again.";
  }
  if (
    message.includes("network") ||
    message.includes("fetch") ||
    message.includes("offline") ||
    message.includes("failed to connect")
  ) {
    return "You appear to be offline. Reconnect and try again — your message is still here.";
  }
  return "We couldn’t send your message. Your message is still here — try again.";
}
