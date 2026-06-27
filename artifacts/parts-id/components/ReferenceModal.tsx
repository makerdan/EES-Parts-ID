import React, { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { ContactSheet } from "@/components/ContactSheet";
import { DismissKeyboard } from "@/components/DismissKeyboard";
import { KeyboardDoneInput } from "@/components/KeyboardDoneInput";
import { useApp } from "@/contexts/AppContext";
import { useColors } from "@/hooks/useColors";
import { secondaryBtnBase } from "@/styles/shared";
import { API_BASE } from "@/utils/apiBase";
import { fetchWithAuth } from "@/utils/appAuth";
import { type CacheEntry,fetchChipAnswer as fetchChipAnswerImpl, prefetchQuickLookups as prefetchQuickLookupsImpl } from "@/utils/chipCache";

type Props = {
  open?: boolean;
  onClose?: () => void;
};

const QUICK_LOOKUP_CHIPS = [
  { label: "1G",               question: "What is a 1-gang electrical box, what devices does it hold, and what are the standard dimensions?" },
  { label: "GFCI",             question: "What does GFCI stand for, how does it work, and where is it required by the NEC?" },
  { label: "AFCI",             question: "What is an AFCI breaker or receptacle, how does it work, and where does the NEC require it?" },
  { label: "TRWR",             question: "What does TRWR mean on a receptacle — what is Tamper Resistant and Weather Resistant, and where is each required?" },
  { label: "Decora",           question: "What is a Decora style switch or receptacle, who makes them, and how do they differ from standard toggle style?" },
  { label: "Romex",            question: "What is Romex (NM-B cable), what do the numbers on the sheath mean, and when is it allowed by code?" },
  { label: "MC Cable",         question: "What is MC cable (Metal Clad armored cable), how does it differ from Romex, and when should it be used?" },
  { label: "EMT",              question: "What is EMT (Electrical Metallic Tubing) conduit, what are its common uses, and how does it differ from rigid conduit?" },
  { label: "Toggle vs Rocker", question: "What is the difference between a toggle switch and a rocker (paddle) switch — are they interchangeable?" },
  { label: "Duplex",           question: "What is a duplex receptacle, how does it differ from simplex and quadplex outlets, and what are standard amperage ratings?" },
  { label: "15A vs 20A",       question: "What is the difference between 15 amp and 20 amp circuits, receptacles, and breakers — how do I tell them apart?" },
  { label: "AWG",              question: "What does AWG mean, how does wire gauge numbering work, and which gauge should I use for common circuits?" },
] as const;

const BREAKER_ATTRIBUTE_CHIPS: Array<{ label: string; answer: string }> = [
  {
    label: "Amp Rating",
    answer: "**Amp Rating** is the maximum continuous current the breaker will carry without tripping. Common residential ratings are **15A** and **20A**; commercial/industrial panels use 30A, 60A, 100A, and higher. Always match the breaker amp rating to the wire gauge — 15A for 14 AWG, 20A for 12 AWG.",
  },
  {
    label: "Poles",
    answer: "**Poles** indicate how many hot conductors the breaker controls.\n- **1-Pole (1P):** 120 V circuits (lights, receptacles)\n- **2-Pole (2P):** 240 V circuits (dryers, HVAC, ranges)\n- **3-Pole (3P):** Three-phase 208/480 V circuits (commercial motors, large equipment)",
  },
  {
    label: "Voltage Rating",
    answer: "**Voltage Rating** is the maximum system voltage the breaker is listed for. Common ratings:\n- **120/240 V** — standard residential single-phase\n- **120/208 V** — commercial three-phase wye\n- **277/480 V** — industrial three-phase\nNever install a breaker in a panel whose voltage exceeds the breaker's rating.",
  },
  {
    label: "Frame Size",
    answer: "**Frame Size** is a physical size classification that determines the maximum ampere rating available in that frame. For example, a 100A frame can hold breakers from 15A up to 100A. Common frame sizes: 100A, 225A, 400A, 600A, 800A. Frame size must match the panel's bus bar mounting.",
  },
  {
    label: "AIC Rating",
    answer: "**AIC (Ampere Interrupting Capacity)** is the maximum fault current the breaker can safely interrupt without damage. Residential panels typically require **10,000 AIC**; commercial applications may need 22,000–65,000 AIC or higher. Under-rated breakers can explode during a fault. Always verify AIC meets the available fault current at the panel.",
  },
  {
    label: "Mount Type",
    answer: "**Mount Type** describes how the breaker attaches to the panel bus:\n- **Plug-in:** Snaps onto bus stabs (most residential panels — Square D QO, Eaton BR, Siemens)\n- **Bolt-on:** Bolted to bus bar (industrial panels, higher vibration applications)\nPlug-in and bolt-on breakers are NOT interchangeable even if they look similar.",
  },
  {
    label: "Physical Footprint",
    answer: "**Physical Footprint** refers to how many panel spaces (slots) the breaker occupies.\n- **Full-size (1\" wide):** Takes 1 slot per pole\n- **Tandem / Twin:** Two 1-pole breakers in one slot space (where panel and local code allow)\n- **Double-pole:** Takes 2 adjacent slots\nAlways check the panel's loadcenter directory for approved tandem positions.",
  },
  {
    label: "Series Codes",
    answer: "**Series Codes** are manufacturer-specific identifiers that indicate the breaker family and compatibility:\n- **Eaton:** BR, CH, BAB, HQP\n- **Square D:** QO, HOM, FA, KA\n- **Siemens/ITE:** QP, QPF, EQ\n- **GE:** THQL, THQP\nBreakers are only listed for specific panel series — mixing series can void listings and create safety hazards.",
  },
  {
    label: "Trade Size",
    answer: "**Trade Size** in the context of breakers refers to the common industry shorthand combining poles and amps, e.g. **1P-20A**, **2P-30A**, **3P-60A**. When ordering, specifying trade size plus series code (e.g., \"BR 1P-20A\") ensures you get the correct breaker for the panel family. Some vendors use it interchangeably with frame size.",
  },
];

export function ReferenceModal({ open, onClose }: Props = {}) {
  "use no memo";
  const colors = useColors();
  const { showToast } = useApp();
  const controlled = open !== undefined;
  const [visible, setVisible] = useState(false);
  const isVisible = controlled ? open : visible;
  const handleClose = controlled ? (onClose ?? (() => {})) : () => setVisible(false);

  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  // `loading` — typed question in flight; drives send-button spinner
  const [loading, setLoading] = useState(false);
  // `chipLoading` — chip tap in flight; never drives the send-button spinner
  const [chipLoading, setChipLoading] = useState(false);
  const [isError, setIsError] = useState(false);
  const [history, setHistory] = useState<Array<{ q: string; a: string }>>([]);
  const [inputCollapsed, setInputCollapsed] = useState(false);
  const [activeBreakerChips, setActiveBreakerChips] = useState<Array<string>>([]);
  const [contactVisible, setContactVisible] = useState(false);

  const scrollRef = useRef<ScrollView>(null);
  const pulse = useRef(new Animated.Value(1)).current;
  const askedQuestionRef = useRef("");
  const answerCacheRef = useRef<Map<string, CacheEntry>>(new Map());
  const lastTapRef = useRef<number>(0);
  // Stores the full chip context needed for retry when a chip call fails
  const failedChipRef = useRef<{ label: string; question: string } | null>(null);

  const isBusy = loading || chipLoading;
  const answerLoading = loading || chipLoading;
  const hasActiveAnswerArea = answer || isError || answerLoading;

  const pulseButton = useCallback(() => {
    Animated.sequence([
      Animated.timing(pulse, { toValue: 1.08, duration: 100, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 1, duration: 100, useNativeDriver: true }),
    ]).start();
  }, [pulse]);

  const prefetchQuickLookups = useCallback(async () => {
    await prefetchQuickLookupsImpl(answerCacheRef.current, API_BASE);
  }, []);

  const handleModalShow = useCallback(() => {
    prefetchQuickLookups();
  }, [prefetchQuickLookups]);

  const fetchChipAnswer = async (label: string, chipQuestion: string): Promise<string> => {
    return fetchChipAnswerImpl(label, chipQuestion, answerCacheRef.current, API_BASE);
  };

  const onChipTap = async (label: string, chipQuestion: string) => {
    if (isBusy) return;
    askedQuestionRef.current = label;
    failedChipRef.current = null;
    setChipLoading(true);
    setIsError(false);
    setAnswer("");
    setQuestion("");

    try {
      const a = await fetchChipAnswer(label, chipQuestion);
      setHistory(h => [...h, { q: label, a }]);
      setAnswer("");
    } catch {
      failedChipRef.current = { label, question: chipQuestion };
      setIsError(true);
    } finally {
      setChipLoading(false);
      scrollRef.current?.scrollToEnd({ animated: true });
    }
  };

  const askQuestion = async (overrideQuestion?: string) => {
    const q = (overrideQuestion ?? question).trim();
    if (!q || isBusy) return;
    askedQuestionRef.current = q;
    failedChipRef.current = null;
    setLoading(true);
    setIsError(false);
    setAnswer("");
    pulseButton();

    try {
      const res = await fetchWithAuth(`${API_BASE}/reference/ask?stream=false`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, history }),
      });

      if (!res.ok) {
        setIsError(true);
        return;
      }

      const data: { answer: string } = await res.json();
      setHistory(h => [...h, { q: askedQuestionRef.current, a: data.answer }]);
      setAnswer("");
      setQuestion("");
      scrollRef.current?.scrollToEnd({ animated: true });
    } catch {
      setIsError(true);
    } finally {
      setLoading(false);
    }
  };

  const retryLastRequest = () => {
    if (failedChipRef.current) {
      // Chip failure — replay the exact chip label + full question
      const { label, question: chipQ } = failedChipRef.current;
      onChipTap(label, chipQ);
    } else {
      // Typed question failure — replay using stored question text
      askQuestion(askedQuestionRef.current);
    }
  };

  const dismissActiveAnswer = () => {
    setAnswer("");
    setIsError(false);
    failedChipRef.current = null;
  };

  const handleAnswerDoubleTap = () => {
    const now = Date.now();
    if (now - lastTapRef.current < 350) {
      setInputCollapsed(c => !c);
    }
    lastTapRef.current = now;
  };

  const clearAll = () => {
    setQuestion("");
    setAnswer("");
    setIsError(false);
    setHistory([]);
    setInputCollapsed(false);
    setActiveBreakerChips([]);
    failedChipRef.current = null;
  };

  /**
   * Strip the leading "*(web)*" marker and return { body, usedWeb }.
   * The marker may appear as the very first characters or on its own line.
   */
  const parseWebMarker = (text: string): { body: string; usedWeb: boolean } => {
    const trimmed = text.trimStart();
    if (trimmed.startsWith("*(web)*")) {
      return { body: trimmed.slice("*(web)*".length).replace(/^\n+/, ""), usedWeb: true };
    }
    return { body: text, usedWeb: false };
  };

  const renderAnswer = (text: string) => {
    const { body, usedWeb } = parseWebMarker(text);
    const parts = body.split(/(\*\*[^*]+\*\*)/g);
    const renderedParts = parts.map((part, i) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return (
          <Text key={i} style={{ fontFamily: "Inter_700Bold", color: colors.foreground }}>
            {part.slice(2, -2)}
          </Text>
        );
      }
      return (
        <Text key={i} style={{ fontFamily: "Inter_400Regular", color: colors.foreground }}>
          {part}
        </Text>
      );
    });

    if (!usedWeb) return <>{renderedParts}</>;

    return (
      <>
        <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 6, gap: 4 }}>
          <Text style={{ fontSize: 13 }}>🌐</Text>
          <Text style={{ fontSize: 11, fontFamily: "Inter_500Medium", color: colors.mutedForeground }}>
            via web search
          </Text>
        </View>
        {renderedParts}
      </>
    );
  };

  return (
    <>
      {!controlled && (
        <Animated.View style={[fabStyles.fab, { transform: [{ scale: pulse }] }]} pointerEvents="box-none">
          <Pressable
            onPress={() => setVisible(true)}
            style={[fabStyles.fabBtn, { backgroundColor: colors.primary }]}
          >
            <Text style={fabStyles.fabIcon}>⚡</Text>
            <Text style={[fabStyles.fabLabel, { color: colors.primaryForeground }]}>REF</Text>
          </Pressable>
        </Animated.View>
      )}

      <Modal
        visible={isVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={handleClose}
        onShow={handleModalShow}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={[modalStyles.container, { backgroundColor: colors.background }]}
        >
          <DismissKeyboard>
          {/* Header */}
          <View style={[modalStyles.header, { borderBottomColor: colors.border }]}>
            <View>
              <Text style={[modalStyles.title, { color: colors.foreground }]}>
                🤖 Ask the AI
              </Text>
              <Text style={[modalStyles.subtitle, { color: colors.mutedForeground }]}>
                Ask anything — parts, codes, or how the app works
              </Text>
            </View>
            <View style={{ flexDirection: "row", gap: 8 }}>
              {history.length > 0 ? (
                <Pressable onPress={clearAll} style={[modalStyles.clearBtn, { borderColor: colors.border }]}>
                  <Text style={[modalStyles.clearText, { color: colors.mutedForeground }]}>Clear</Text>
                </Pressable>
              ) : null}
              <Pressable
                onPress={() => setContactVisible(true)}
                style={[modalStyles.clearBtn, { borderColor: colors.border }]}
              >
                <Text style={[modalStyles.clearText, { color: colors.mutedForeground }]}>Contact</Text>
              </Pressable>
              <Pressable
                onPress={handleClose}
                style={[modalStyles.closeBtn, { backgroundColor: colors.muted }]}
              >
                <Text style={[modalStyles.closeText, { color: colors.foreground }]}>✕</Text>
              </Pressable>
            </View>
          </View>

          {/* Scrollable body */}
          <ScrollView
            ref={scrollRef}
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: 16 }}
            keyboardShouldPersistTaps="handled"
          >
            {/* History bubbles */}
            {history.map((h, i) => (
              <Pressable key={i} onPress={handleAnswerDoubleTap} style={{ marginBottom: 16 }}>
                <View style={[msgStyles.qBubble, { backgroundColor: colors.primary + "22" }]}>
                  <Text style={[msgStyles.qText, { color: colors.foreground }]}>Q: {h.q}</Text>
                </View>
                <View style={[msgStyles.aBubble, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <Text style={{ fontSize: 14, lineHeight: 22 }}>
                    {renderAnswer(h.a)}
                  </Text>
                </View>
              </Pressable>
            ))}

            {/* Active answer bubble */}
            {hasActiveAnswerArea ? (
              <Pressable onPress={handleAnswerDoubleTap} style={{ marginBottom: 16 }}>
                <View style={[msgStyles.qBubble, { backgroundColor: colors.primary + "22" }]}>
                  <Text style={[msgStyles.qText, { color: colors.foreground }]}>
                    Q: {askedQuestionRef.current || question}
                  </Text>
                </View>
                {isError ? (
                  <View style={[msgStyles.aBubble, { backgroundColor: colors.destructive + "0f", borderColor: colors.destructive + "44" }]}>
                    <Text style={{ fontSize: 14, lineHeight: 22, color: colors.destructive }}>
                      No answer — check your connection and try again.
                    </Text>
                    <Pressable
                      onPress={retryLastRequest}
                      style={[msgStyles.retryBtn, { borderColor: colors.primary }]}
                    >
                      <Text style={{ fontSize: 13, color: colors.primary, fontFamily: "Inter_600SemiBold" }}>
                        ↺  Retry
                      </Text>
                    </Pressable>
                  </View>
                ) : answerLoading && !answer ? (
                  <View style={[msgStyles.aBubble, { backgroundColor: colors.card, borderColor: colors.border, alignItems: "center", justifyContent: "center", minHeight: 48 }]}>
                    <ActivityIndicator size="small" color={colors.primary} />
                  </View>
                ) : (
                  <View style={[msgStyles.aBubble, { backgroundColor: colors.card, borderColor: colors.border }]}>
                    <Text style={{ fontSize: 14, lineHeight: 22 }}>
                      {renderAnswer(answer)}
                    </Text>
                    {!answerLoading && answer ? (
                      <Pressable
                        onPress={dismissActiveAnswer}
                        style={[msgStyles.dismissBtn, { backgroundColor: colors.muted }]}
                        hitSlop={8}
                      >
                        <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_500Medium" }}>✕</Text>
                      </Pressable>
                    ) : null}
                  </View>
                )}
              </Pressable>
            ) : null}

            {/* Empty state */}
            {!history.length && !hasActiveAnswerArea ? (
              <View style={emptyStyles.container}>
                <Text style={emptyStyles.emoji}>🤖</Text>
                <Text style={[emptyStyles.title, { color: colors.foreground }]}>Ask the AI</Text>
                <Text style={[emptyStyles.hint, { color: colors.mutedForeground }]}>
                  Ask about parts, electrical codes, how the app works, or any general question. The AI searches the web when it needs to.
                </Text>

                {/* Inline text input in empty state */}
                <View style={[emptyStyles.inputRow, { backgroundColor: colors.muted, borderColor: colors.border }]}>
                  <KeyboardDoneInput
                    value={question}
                    onChangeText={setQuestion}
                    placeholder="Ask about parts, codes, or the app..."
                    placeholderTextColor={colors.mutedForeground}
                    style={[emptyStyles.inlineInput, { color: colors.foreground }]}
                    returnKeyType="send"
                    onSubmitEditing={() => askQuestion()}
                  />
                  <Pressable
                    onPress={() => askQuestion()}
                    disabled={!question.trim()}
                    style={[emptyStyles.inlineSendBtn, { backgroundColor: question.trim() ? colors.primary : colors.border }]}
                  >
                    <Text style={[emptyStyles.inlineSendText, { color: colors.primaryForeground }]}>→</Text>
                  </Pressable>
                </View>

                {/* Quick Lookups — wrapping pill row */}
                <Text style={[emptyStyles.sectionLabel, { color: colors.mutedForeground }]}>QUICK LOOKUPS</Text>
                <View style={emptyStyles.chipRow}>
                  {QUICK_LOOKUP_CHIPS.map(({ label, question: q }) => (
                    <Pressable
                      key={label}
                      onPress={() => onChipTap(label, q)}
                      style={[emptyStyles.chip, { backgroundColor: colors.muted, borderColor: colors.border }]}
                    >
                      <Text style={[emptyStyles.chipText, { color: colors.foreground }]}>{label}</Text>
                    </Pressable>
                  ))}
                </View>

                {/* Breaker Attributes — wrapping pill row with inline expansion */}
                <Text style={[emptyStyles.sectionLabel, { color: colors.mutedForeground, marginTop: 16 }]}>BREAKER ATTRIBUTES</Text>
                <View style={emptyStyles.chipRow}>
                  {BREAKER_ATTRIBUTE_CHIPS.map(({ label }) => {
                    const isActive = activeBreakerChips.includes(label);
                    return (
                      <Pressable
                        key={label}
                        onPress={() => setActiveBreakerChips(prev =>
                          prev.includes(label) ? prev.filter(l => l !== label) : [...prev, label]
                        )}
                        style={[
                          emptyStyles.chip,
                          {
                            backgroundColor: isActive ? colors.primary : colors.muted,
                            borderColor: isActive ? colors.primary : colors.border,
                          },
                        ]}
                      >
                        <Text style={[
                          emptyStyles.chipText,
                          { color: isActive ? colors.primaryForeground : colors.foreground },
                        ]}>
                          {label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                {activeBreakerChips.length > 0 ? (
                  <>
                    {activeBreakerChips.map(label => (
                      <View key={label} style={[breakerStyles.answerBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
                        <Text style={[breakerStyles.answerLabel, { color: colors.mutedForeground }]}>
                          {label}
                        </Text>
                        <Text style={{ fontSize: 14, lineHeight: 22 }}>
                          {renderAnswer(
                            BREAKER_ATTRIBUTE_CHIPS.find(c => c.label === label)?.answer ?? ""
                          )}
                        </Text>
                      </View>
                    ))}
                  </>
                ) : null}
              </View>
            ) : null}
          </ScrollView>

          {/* Persistent bottom input bar — visible once conversation has started */}
          {(history.length > 0 || hasActiveAnswerArea) ? (
            <View style={[inputStyles.bar, { backgroundColor: colors.card, borderTopColor: colors.border }]}>
              <KeyboardDoneInput
                value={question}
                onChangeText={t => { setQuestion(t); if (inputCollapsed) setInputCollapsed(false); }}
                placeholder="Ask about parts, codes, or the app..."
                placeholderTextColor={colors.mutedForeground}
                style={[
                  inputStyles.input,
                  {
                    backgroundColor: colors.muted,
                    color: colors.foreground,
                    borderColor: colors.border,
                  },
                ]}
                multiline={!inputCollapsed}
                numberOfLines={inputCollapsed ? 1 : undefined}
                returnKeyType="send"
                onSubmitEditing={() => askQuestion()}
              />
              <Pressable
                onPress={() => askQuestion()}
                disabled={loading || !question.trim()}
                style={[inputStyles.sendBtn, { backgroundColor: loading ? colors.muted : colors.primary }]}
              >
                {loading ? (
                  <ActivityIndicator size="small" color={colors.primaryForeground} />
                ) : (
                  <Text style={[inputStyles.sendText, { color: colors.primaryForeground }]}>→</Text>
                )}
              </Pressable>
            </View>
          ) : null}
          </DismissKeyboard>
        </KeyboardAvoidingView>
      </Modal>

      <ContactSheet
        visible={contactVisible}
        onClose={() => setContactVisible(false)}
        onSuccess={() => showToast("Message sent to admin")}
      />
    </>
  );
}

const fabStyles = StyleSheet.create({
  fab: {
    position: "absolute",
    bottom: 100,
    right: 16,
    zIndex: 100,
  },
  fabBtn: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 3px 6px rgba(0,0,0,0.25)",
  },
  fabIcon: { fontSize: 20 },
  fabLabel: { fontSize: 9, fontFamily: "Inter_700Bold", letterSpacing: 0.5 },
});

const modalStyles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    paddingTop: 20,
    borderBottomWidth: 1,
  },
  title: { fontSize: 18, fontFamily: "Inter_700Bold" },
  subtitle: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  closeText: { fontSize: 14, fontFamily: "Inter_500Medium" },
  clearBtn: { ...secondaryBtnBase, paddingHorizontal: 10, paddingVertical: 5 },
  clearText: { fontSize: 12, fontFamily: "Inter_500Medium" },
});

const msgStyles = StyleSheet.create({
  qBubble: { padding: 10, borderRadius: 8, marginBottom: 6 },
  qText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  aBubble: { ...secondaryBtnBase, padding: 12 },
  retryBtn: { alignSelf: "flex-start", marginTop: 10, paddingHorizontal: 14, paddingVertical: 7, borderRadius: 6, borderWidth: 1 },
  dismissBtn: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
});

const emptyStyles = StyleSheet.create({
  container: { alignItems: "center", padding: 24 },
  emoji: { fontSize: 40, marginBottom: 12 },
  title: { fontSize: 18, fontFamily: "Inter_700Bold", marginBottom: 8 },
  hint: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20, marginBottom: 16 },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 4,
    marginBottom: 20,
    gap: 8,
  },
  inlineInput: {
    flex: 1,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    paddingVertical: 8,
  },
  inlineSendBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  inlineSendText: { fontSize: 16, fontFamily: "Inter_700Bold" },
  sectionLabel: { fontSize: 11, fontFamily: "Inter_600SemiBold", letterSpacing: 1, textTransform: "uppercase", marginBottom: 10, alignSelf: "flex-start" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, width: "100%", paddingBottom: 4 },
  chip: { ...secondaryBtnBase, paddingHorizontal: 14, paddingVertical: 8 },
  chipText: { fontSize: 13, fontFamily: "Inter_400Regular" },
});

const breakerStyles = StyleSheet.create({
  answerBox: {
    ...secondaryBtnBase,
    width: "100%",
    padding: 14,
    marginTop: 12,
  },
  answerLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    marginBottom: 6,
  },
});

const inputStyles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "flex-end",
    padding: 12,
    gap: 10,
    borderTopWidth: 1,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    maxHeight: 100,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  sendText: { fontSize: 18, fontFamily: "Inter_700Bold" },
});
