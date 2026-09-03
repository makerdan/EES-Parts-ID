import { useAuth } from "@clerk/expo";
import { Feather } from "@expo/vector-icons";
import { HELP_ERROR_CODE, type HelpErrorCode } from "@workspace/api-zod";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { ContactSheet } from "@/components/ContactSheet";
import { KeyboardDoneInput } from "@/components/KeyboardDoneInput";
import { ReferenceModal } from "@/components/ReferenceModal";
import { useApp } from "@/contexts/AppContext";
import { useColors } from "@/hooks/useColors";
import { askHelpQuestion, fetchHelpRecords,HelpApiError } from "@/utils/helpApi";
import {
  type HelpRecord,
  readCachedGeneralHelp,
  readHelpOrientationDismissed,
  saveHelpOrientationDismissed,
  writeCachedGeneralHelp,
} from "@/utils/helpStorage";

type AssistantState = "idle" | "loading" | "success" | "unsupported" | "rate-limited" | "timeout" | "provider-outage";
type AssistantFailureState = Exclude<AssistantState, "idle" | "loading" | "success">;

const HELP_ERROR_STATE_BY_CODE: Record<HelpErrorCode, AssistantFailureState> = {
  [HELP_ERROR_CODE.UNSUPPORTED]: "unsupported",
  [HELP_ERROR_CODE.RATE_LIMITED]: "rate-limited",
  [HELP_ERROR_CODE.AUTHORIZATION_UNAVAILABLE]: "provider-outage",
  [HELP_ERROR_CODE.TIMEOUT]: "timeout",
  [HELP_ERROR_CODE.PROVIDER_UNAVAILABLE]: "provider-outage",
  [HELP_ERROR_CODE.PROVIDER_RATE_LIMITED]: "rate-limited",
  [HELP_ERROR_CODE.INVALID_REQUEST]: "provider-outage",
};

function errorState(error: unknown): AssistantFailureState {
  if (error instanceof HelpApiError) {
    return HELP_ERROR_STATE_BY_CODE[error.code];
  }
  return "provider-outage";
}

function errorTitle(state: AssistantState): string {
  switch (state) {
    case "unsupported": return "That topic is outside Help";
    case "rate-limited": return "Help is receiving a lot of questions";
    case "timeout": return "Help took too long to respond";
    default: return "Help assistant unavailable";
  }
}

function errorBody(state: AssistantState): string {
  switch (state) {
    case "unsupported": return "Try asking about a Parts ID workflow, or contact support if you need help with something else.";
    case "rate-limited": return "Wait a moment and try again. Contact support if the issue is urgent.";
    case "timeout": return "The request did not finish in time. Try again or contact support.";
    default: return "Check your connection and try again. Contact support if the provider is unavailable.";
  }
}

function HelpRecordCard({
  record,
  expanded,
  onToggle,
  fontScale,
}: {
  record: HelpRecord;
  expanded: boolean;
  onToggle: () => void;
  fontScale: number;
}) {
  const colors = useColors();
  return (
    <View style={[styles.recordCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${record.title}`}
        accessibilityState={{ expanded }}
        style={styles.recordHeader}
      >
        <View style={{ flex: 1 }}>
          <Text style={[styles.recordTitle, { color: colors.foreground, fontSize: 16 * fontScale }]}>{record.title}</Text>
          <Text style={[styles.recordSummary, { color: colors.mutedForeground, fontSize: 13 * fontScale }]}>{record.summary}</Text>
        </View>
        <Feather name={expanded ? "chevron-up" : "chevron-down"} size={18} color={colors.mutedForeground} />
      </Pressable>
      {expanded ? (
        <View style={[styles.recordBody, { borderTopColor: colors.border }]}>
          <Text style={[styles.bodyText, { color: colors.foreground, fontSize: 14 * fontScale }]}>{record.body}</Text>
          {[
            ["Before you start", record.prerequisites],
            ["Steps", record.steps],
            ["What to expect", record.outcomes],
            ["If something goes wrong", record.recovery],
            ["Keep in mind", record.limitations],
          ].map(([label, items]) => (
            <View key={label as string} style={styles.listSection}>
              <Text style={[styles.listLabel, { color: colors.primary, fontSize: 11 * fontScale }]}>{label as string}</Text>
              {(items as Array<string>).map((item) => (
                <Text key={item} style={[styles.listItem, { color: colors.foreground, fontSize: 13 * fontScale }]}>
                  {"• "}{item}
                </Text>
              ))}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export default function HelpScreen() {
  "use no memo";
  const colors = useColors();
  const { userId } = useAuth();
  const { isAdmin, textFontScale, registerLogoutHandler } = useApp();
  const [generalRecords, setGeneralRecords] = useState<Array<HelpRecord>>([]);
  const [adminRecords, setAdminRecords] = useState<Array<HelpRecord>>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [orientationDismissed, setOrientationDismissed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [offline, setOffline] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [conversation, setConversation] = useState<Array<{ q: string; a: string }>>([]);
  const [assistantState, setAssistantState] = useState<AssistantState>("idle");
  const [assistantError, setAssistantError] = useState<HelpApiError | null>(null);
  const [contactVisible, setContactVisible] = useState(false);
  const [referenceVisible, setReferenceVisible] = useState(false);
  const lastQuestionRef = useRef("");
  const requestControllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  const clearPrivilegedState = useCallback(() => {
    generationRef.current += 1;
    requestControllerRef.current?.abort();
    setAdminRecords([]);
    setConversation([]);
    setQuestion("");
    setAssistantState("idle");
    setAssistantError(null);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      requestControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => registerLogoutHandler(clearPrivilegedState), [clearPrivilegedState, registerLogoutHandler]);

  const loadContent = useCallback(async () => {
    const generation = ++generationRef.current;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setLoading(true);
    setLoadError(null);
    setOffline(false);
    setAdminRecords([]);

    const cached = await readCachedGeneralHelp();
    if (controller.signal.aborted || generation !== generationRef.current || !mountedRef.current) return;

    try {
      const general = await fetchHelpRecords("general", controller.signal);
      if (controller.signal.aborted || generation !== generationRef.current || !mountedRef.current) return;
      setGeneralRecords(general.records);
      setExpanded((current) => current ?? general.records[0]?.id ?? null);
      await writeCachedGeneralHelp(general);
    } catch {
      if (controller.signal.aborted || generation !== generationRef.current || !mountedRef.current) return;
      if (cached) {
        setGeneralRecords(cached.records);
        setExpanded((current) => current ?? cached.records[0]?.id ?? null);
        setOffline(true);
      } else {
        setLoadError("Help content could not be loaded. Check your connection and retry.");
      }
    }

    if (isAdmin) {
      try {
        const admin = await fetchHelpRecords("admin", controller.signal);
        if (controller.signal.aborted || generation !== generationRef.current || !mountedRef.current) return;
        setAdminRecords(admin.records);
      } catch {
        // Admin content is never read from local storage. A failed authorization
        // or network check must leave the privileged section empty.
        if (!controller.signal.aborted && generation === generationRef.current && mountedRef.current) {
          setAdminRecords([]);
        }
      }
    }
    if (mountedRef.current && generation === generationRef.current) setLoading(false);
  }, [isAdmin]);

  useEffect(() => {
    setAdminRecords([]);
    setGeneralRecords([]);
    setExpanded(null);
    clearPrivilegedState();
    void loadContent();
    readHelpOrientationDismissed().then((dismissed) => {
      if (mountedRef.current) setOrientationDismissed(dismissed);
    });
  }, [clearPrivilegedState, loadContent, userId]);

  const retryContent = () => {
    setRefreshing(true);
    loadContent().finally(() => {
      if (mountedRef.current) setRefreshing(false);
    });
  };

  const dismissOrientation = () => {
    setOrientationDismissed(true);
    void saveHelpOrientationDismissed();
  };

  const askQuestion = async (override?: string) => {
    const value = (override ?? question).trim();
    if (!value || assistantState === "loading") return;
    lastQuestionRef.current = value;
    const generation = generationRef.current;
    const controller = new AbortController();
    requestControllerRef.current?.abort();
    requestControllerRef.current = controller;
    setAssistantState("loading");
    setAssistantError(null);
    try {
      const answer = await askHelpQuestion(value, conversation, controller.signal);
      if (!mountedRef.current || generation !== generationRef.current || controller.signal.aborted) return;
      setConversation((previous) => [...previous, { q: value, a: answer }].slice(-8));
      setQuestion("");
      setAssistantState("success");
    } catch (error) {
      if (!mountedRef.current || generation !== generationRef.current || controller.signal.aborted) return;
      const apiError = error instanceof HelpApiError
        ? error
        : new HelpApiError(HELP_ERROR_CODE.PROVIDER_UNAVAILABLE, "The Help assistant is unavailable right now.");
      setAssistantError(apiError);
      setAssistantState(errorState(apiError));
    }
  };

  const assistantFailure = assistantState !== "idle" && assistantState !== "loading" && assistantState !== "success";

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.headerTitle, { color: colors.foreground, fontSize: 22 * textFontScale }]}>Help</Text>
          <Text style={[styles.headerSubtitle, { color: colors.mutedForeground, fontSize: 12 * textFontScale }]}>
            Practical guidance for using Parts ID
          </Text>
        </View>
        <Pressable
          onPress={() => setOrientationDismissed(false)}
          accessibilityRole="button"
          accessibilityLabel="Show Help introduction"
          style={[styles.headerAction, { borderColor: colors.border, backgroundColor: colors.muted }]}
        >
          <Feather name="compass" size={15} color={colors.primary} />
          <Text style={[styles.headerActionText, { color: colors.foreground }]}>Intro</Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={retryContent} tintColor={colors.primary} />}
        keyboardShouldPersistTaps="handled"
      >
        {!orientationDismissed ? (
          <View style={[styles.orientation, { backgroundColor: colors.primary + "12", borderColor: colors.primary + "55" }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.orientationTitle, { color: colors.foreground, fontSize: 17 * textFontScale }]}>Start here</Text>
              <Text style={[styles.orientationText, { color: colors.foreground, fontSize: 13 * textFontScale }]}>
                Open a topic below for step-by-step guidance. Help works from the keyboard, touch, and screen readers, and you can return here any time.
              </Text>
            </View>
            <Pressable
              onPress={dismissOrientation}
              accessibilityRole="button"
              accessibilityLabel="Dismiss Help introduction"
              style={[styles.dismissButton, { backgroundColor: colors.primary }]}
            >
              <Text style={[styles.dismissText, { color: colors.primaryForeground }]}>Got it</Text>
            </Pressable>
          </View>
        ) : null}

        {offline ? (
          <View style={[styles.statusBanner, { backgroundColor: colors.warning + "18", borderColor: colors.warning + "44" }]}>
            <Feather name="wifi-off" size={15} color={colors.warning} />
            <Text style={[styles.statusText, { color: colors.warning, flex: 1 }]}>
              You’re offline — showing recently cached Help.
            </Text>
            <Pressable onPress={retryContent} accessibilityRole="button" accessibilityLabel="Retry Help content">
              <Text style={[styles.retryText, { color: colors.warning }]}>Retry</Text>
            </Pressable>
          </View>
        ) : null}

        {loading && generalRecords.length === 0 ? (
          <View style={styles.centerState}>
            <ActivityIndicator color={colors.primary} />
            <Text style={[styles.centerText, { color: colors.mutedForeground }]}>Loading Help…</Text>
          </View>
        ) : loadError ? (
          <View style={[styles.errorCard, { backgroundColor: colors.destructive + "12", borderColor: colors.destructive + "44" }]}>
            <Text style={[styles.errorTitle, { color: colors.destructive }]}>Help is unavailable</Text>
            <Text style={[styles.errorText, { color: colors.foreground }]}>{loadError}</Text>
            <Pressable onPress={retryContent} accessibilityRole="button" style={[styles.primaryButton, { backgroundColor: colors.primary }]}>
              <Text style={[styles.primaryButtonText, { color: colors.primaryForeground }]}>Retry Help</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <Text style={[styles.sectionTitle, { color: colors.foreground, fontSize: 18 * textFontScale }]}>Using Parts ID</Text>
            {generalRecords.map((record) => (
              <HelpRecordCard
                key={record.id}
                record={record}
                expanded={expanded === record.id}
                onToggle={() => setExpanded((current) => current === record.id ? null : record.id)}
                fontScale={textFontScale}
              />
            ))}

            {isAdmin && adminRecords.length > 0 ? (
              <>
                <View style={[styles.adminHeading, { borderTopColor: colors.border }]}>
                  <Feather name="shield" size={16} color={colors.primary} />
                  <View>
                    <Text style={[styles.sectionTitle, { color: colors.foreground, fontSize: 18 * textFontScale }]}>Administrator guidance</Text>
                    <Text style={[styles.adminHint, { color: colors.mutedForeground, fontSize: 12 * textFontScale }]}>
                      Available for this current, server-authorized admin session.
                    </Text>
                  </View>
                </View>
                {adminRecords.map((record) => (
                  <HelpRecordCard
                    key={record.id}
                    record={record}
                    expanded={expanded === record.id}
                    onToggle={() => setExpanded((current) => current === record.id ? null : record.id)}
                    fontScale={textFontScale}
                  />
                ))}
              </>
            ) : null}

            <View style={[styles.referenceCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.referenceTitle, { color: colors.foreground, fontSize: 16 * textFontScale }]}>Electrical Reference</Text>
                <Text style={[styles.referenceText, { color: colors.mutedForeground, fontSize: 13 * textFontScale }]}>
                  A separate tool for electrical terms, codes, and quick lookups.
                </Text>
              </View>
              <Pressable
                onPress={() => setReferenceVisible(true)}
                accessibilityRole="button"
                accessibilityLabel="Open Electrical Reference"
                style={[styles.secondaryButton, { borderColor: colors.primary }]}
              >
                <Text style={[styles.secondaryButtonText, { color: colors.primary }]}>Open Ref</Text>
              </Pressable>
            </View>

            <View style={[styles.assistantCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.sectionTitle, { color: colors.foreground, fontSize: 18 * textFontScale }]}>Ask Help</Text>
              <Text style={[styles.assistantHint, { color: colors.mutedForeground, fontSize: 13 * textFontScale }]}>
                App-only Q&A grounded in the approved Help guide. This does not search the web or inventory.
              </Text>
              {conversation.map((turn, index) => (
                <View key={`${turn.q}-${index}`} style={styles.turn}>
                  <Text style={[styles.questionText, { color: colors.primary }]}>Q: {turn.q}</Text>
                  <Text style={[styles.answerText, { color: colors.foreground }]}>{turn.a}</Text>
                </View>
              ))}
              {assistantState === "loading" ? (
                <View style={styles.loadingRow}>
                  <ActivityIndicator size="small" color={colors.primary} />
                  <Text style={[styles.centerText, { color: colors.mutedForeground }]}>Checking the Help guide…</Text>
                </View>
              ) : null}
              {assistantFailure ? (
                <View style={[styles.assistantError, { backgroundColor: colors.destructive + "10", borderColor: colors.destructive + "44" }]}>
                  <Text style={[styles.errorTitle, { color: colors.destructive }]}>{errorTitle(assistantState)}</Text>
                  <Text style={[styles.errorText, { color: colors.foreground }]}>{errorBody(assistantState)}</Text>
                  {assistantError?.message ? (
                    <Text style={[styles.errorText, { color: colors.mutedForeground }]}>{assistantError.message}</Text>
                  ) : null}
                  <View style={styles.errorActions}>
                    <Pressable onPress={() => askQuestion(lastQuestionRef.current)} accessibilityRole="button" style={[styles.primaryButton, { backgroundColor: colors.primary }]}>
                      <Text style={[styles.primaryButtonText, { color: colors.primaryForeground }]}>Retry</Text>
                    </Pressable>
                    <Pressable onPress={() => setContactVisible(true)} accessibilityRole="button" style={[styles.secondaryButton, { borderColor: colors.primary }]}>
                      <Text style={[styles.secondaryButtonText, { color: colors.primary }]}>Contact support</Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}
              <View style={[styles.questionRow, { backgroundColor: colors.muted, borderColor: colors.border }]}>
                <KeyboardDoneInput
                  value={question}
                  onChangeText={setQuestion}
                  placeholder="How do I use a Parts ID feature?"
                  placeholderTextColor={colors.mutedForeground}
                  style={[styles.questionInput, { color: colors.foreground }]}
                  returnKeyType="send"
                  onSubmitEditing={() => { void askQuestion(); }}
                  editable={assistantState !== "loading"}
                  accessibilityLabel="Ask a Help question"
                />
                <Pressable
                  onPress={() => { void askQuestion(); }}
                  disabled={!question.trim() || assistantState === "loading"}
                  accessibilityRole="button"
                  accessibilityLabel="Send Help question"
                  style={[styles.sendButton, { backgroundColor: question.trim() && assistantState !== "loading" ? colors.primary : colors.border }]}
                >
                  <Feather name="arrow-up" size={17} color={colors.primaryForeground} />
                </Pressable>
              </View>
            </View>
          </>
        )}
      </ScrollView>

      <ContactSheet visible={contactVisible} onClose={() => setContactVisible(false)} />
      <ReferenceModal open={referenceVisible} onClose={() => setReferenceVisible(false)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 18, paddingVertical: 14, borderBottomWidth: 1 },
  headerTitle: { fontFamily: "Inter_700Bold" },
  headerSubtitle: { fontFamily: "Inter_400Regular", marginTop: 2 },
  headerAction: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
  headerActionText: { fontFamily: "Inter_600SemiBold", fontSize: 12 },
  content: { padding: 16, gap: 12, paddingBottom: 36 },
  orientation: { flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, borderRadius: 12, padding: 14 },
  orientationTitle: { fontFamily: "Inter_700Bold", marginBottom: 4 },
  orientationText: { fontFamily: "Inter_400Regular", lineHeight: 19 },
  dismissButton: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9 },
  dismissText: { fontFamily: "Inter_600SemiBold", fontSize: 12 },
  statusBanner: { flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderRadius: 8, padding: 10 },
  statusText: { fontFamily: "Inter_500Medium", fontSize: 12 },
  retryText: { fontFamily: "Inter_700Bold", fontSize: 12 },
  centerState: { alignItems: "center", gap: 8, paddingVertical: 36 },
  centerText: { fontFamily: "Inter_400Regular", fontSize: 12 },
  sectionTitle: { fontFamily: "Inter_700Bold" },
  recordCard: { borderWidth: 1, borderRadius: 10, overflow: "hidden" },
  recordHeader: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, minHeight: 70 },
  recordTitle: { fontFamily: "Inter_700Bold", lineHeight: 21 },
  recordSummary: { fontFamily: "Inter_400Regular", lineHeight: 18, marginTop: 4 },
  recordBody: { borderTopWidth: 1, padding: 14 },
  bodyText: { fontFamily: "Inter_400Regular", lineHeight: 21 },
  listSection: { marginTop: 13 },
  listLabel: { fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 },
  listItem: { fontFamily: "Inter_400Regular", lineHeight: 20, marginTop: 3 },
  adminHeading: { flexDirection: "row", alignItems: "flex-start", gap: 9, borderTopWidth: 1, paddingTop: 20, marginTop: 8 },
  adminHint: { fontFamily: "Inter_400Regular", marginTop: 3 },
  referenceCard: { flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, borderRadius: 10, padding: 14, marginTop: 8 },
  referenceTitle: { fontFamily: "Inter_700Bold" },
  referenceText: { fontFamily: "Inter_400Regular", lineHeight: 18, marginTop: 4 },
  secondaryButton: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9 },
  secondaryButtonText: { fontFamily: "Inter_600SemiBold", fontSize: 12 },
  assistantCard: { borderWidth: 1, borderRadius: 10, padding: 14, marginTop: 4 },
  assistantHint: { fontFamily: "Inter_400Regular", lineHeight: 19, marginTop: 5 },
  turn: { borderLeftWidth: 3, borderLeftColor: "#999", paddingLeft: 10, marginTop: 12, gap: 4 },
  questionText: { fontFamily: "Inter_600SemiBold", fontSize: 13, lineHeight: 19 },
  answerText: { fontFamily: "Inter_400Regular", fontSize: 14, lineHeight: 21 },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 12 },
  assistantError: { borderWidth: 1, borderRadius: 8, padding: 10, marginTop: 12 },
  errorTitle: { fontFamily: "Inter_700Bold", fontSize: 13 },
  errorText: { fontFamily: "Inter_400Regular", fontSize: 13, lineHeight: 19, marginTop: 4 },
  errorActions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  primaryButton: { borderRadius: 8, paddingHorizontal: 13, paddingVertical: 9, alignSelf: "flex-start" },
  primaryButtonText: { fontFamily: "Inter_600SemiBold", fontSize: 12 },
  questionRow: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderRadius: 9, marginTop: 14, paddingLeft: 10 },
  questionInput: { flex: 1, minHeight: 42, fontFamily: "Inter_400Regular", fontSize: 14 },
  sendButton: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center", marginRight: 5 },
  errorCard: { borderWidth: 1, borderRadius: 10, padding: 14 },
});