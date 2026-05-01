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
  TextInput,
  View,
} from "react-native";
import { useColors } from "@/hooks/useColors";

const API_BASE =
  process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
    : "";

export function ReferenceModal() {
  const colors = useColors();
  const [visible, setVisible] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<Array<{ q: string; a: string }>>([]);
  const scrollRef = useRef<ScrollView>(null);
  const pulse = useRef(new Animated.Value(1)).current;

  const pulseButton = useCallback(() => {
    Animated.sequence([
      Animated.timing(pulse, { toValue: 1.08, duration: 100, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 1, duration: 100, useNativeDriver: true }),
    ]).start();
  }, [pulse]);

  const askQuestion = async () => {
    if (!question.trim() || loading) return;
    setLoading(true);
    setAnswer("");
    pulseButton();

    try {
      const res = await fetch(`${API_BASE}/ai/reference`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: question.trim() }),
      });

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let fullText = "";

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const data = JSON.parse(line.slice(6));
              if (data.content) {
                fullText += data.content;
                setAnswer(fullText);
                scrollRef.current?.scrollToEnd({ animated: true });
              }
            } catch {}
          }
        }
      }

      if (fullText) {
        setHistory(h => [...h, { q: question.trim(), a: fullText }]);
      }
    } catch (err) {
      setAnswer("Failed to get answer. Check connection.");
    } finally {
      setLoading(false);
    }
  };

  const clearAll = () => {
    setQuestion("");
    setAnswer("");
    setHistory([]);
  };

  // Simple markdown bold renderer
  const renderAnswer = (text: string) => {
    const parts = text.split(/(\*\*[^*]+\*\*)/g);
    return parts.map((part, i) => {
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
  };

  return (
    <>
      {/* Floating button */}
      <Animated.View style={[fabStyles.fab, { transform: [{ scale: pulse }] }]}>
        <Pressable
          onPress={() => setVisible(true)}
          style={[fabStyles.fabBtn, { backgroundColor: colors.primary }]}
        >
          <Text style={fabStyles.fabIcon}>⚡</Text>
          <Text style={[fabStyles.fabLabel, { color: colors.primaryForeground }]}>REF</Text>
        </Pressable>
      </Animated.View>

      {/* Modal */}
      <Modal
        visible={visible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={[modalStyles.container, { backgroundColor: colors.background }]}
        >
          {/* Header */}
          <View style={[modalStyles.header, { borderBottomColor: colors.border }]}>
            <View>
              <Text style={[modalStyles.title, { color: colors.foreground }]}>
                ⚡ Reference AI
              </Text>
              <Text style={[modalStyles.subtitle, { color: colors.mutedForeground }]}>
                Ask about electrical terms & codes
              </Text>
            </View>
            <View style={{ flexDirection: "row", gap: 8 }}>
              {history.length > 0 ? (
                <Pressable onPress={clearAll} style={[modalStyles.clearBtn, { borderColor: colors.border }]}>
                  <Text style={[modalStyles.clearText, { color: colors.mutedForeground }]}>Clear</Text>
                </Pressable>
              ) : null}
              <Pressable
                onPress={() => setVisible(false)}
                style={[modalStyles.closeBtn, { backgroundColor: colors.muted }]}
              >
                <Text style={[modalStyles.closeText, { color: colors.foreground }]}>✕</Text>
              </Pressable>
            </View>
          </View>

          {/* History */}
          <ScrollView
            ref={scrollRef}
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: 16 }}
            keyboardShouldPersistTaps="handled"
          >
            {history.map((h, i) => (
              <View key={i} style={{ marginBottom: 16 }}>
                <View style={[msgStyles.qBubble, { backgroundColor: colors.primary + "22" }]}>
                  <Text style={[msgStyles.qText, { color: colors.foreground }]}>Q: {h.q}</Text>
                </View>
                <View style={[msgStyles.aBubble, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <Text style={{ fontSize: 14, lineHeight: 22 }}>
                    {renderAnswer(h.a)}
                  </Text>
                </View>
              </View>
            ))}

            {answer ? (
              <View style={{ marginBottom: 16 }}>
                <View style={[msgStyles.qBubble, { backgroundColor: colors.primary + "22" }]}>
                  <Text style={[msgStyles.qText, { color: colors.foreground }]}>Q: {question}</Text>
                </View>
                <View style={[msgStyles.aBubble, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <Text style={{ fontSize: 14, lineHeight: 22 }}>
                    {renderAnswer(answer)}
                  </Text>
                  {loading ? (
                    <ActivityIndicator size="small" color={colors.primary} style={{ marginTop: 4 }} />
                  ) : null}
                </View>
              </View>
            ) : null}

            {!history.length && !answer ? (
              <View style={emptyStyles.container}>
                <Text style={emptyStyles.emoji}>📖</Text>
                <Text style={[emptyStyles.title, { color: colors.foreground }]}>Electrical Reference</Text>
                <Text style={[emptyStyles.hint, { color: colors.mutedForeground }]}>
                  Ask about NEMA codes, wire gauges, breaker ratings, conduit types, or any electrical term.
                </Text>
                {[
                  "What is the difference between THHN and THWN?",
                  "What does GFCI stand for and when is it required?",
                  "What breaker do I need for a 20A 240V circuit?",
                ].map((q) => (
                  <Pressable key={q} onPress={() => setQuestion(q)} style={[emptyStyles.chip, { backgroundColor: colors.muted, borderColor: colors.border }]}>
                    <Text style={[emptyStyles.chipText, { color: colors.foreground }]}>{q}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </ScrollView>

          {/* Input bar */}
          <View style={[inputStyles.bar, { backgroundColor: colors.card, borderTopColor: colors.border }]}>
            <TextInput
              value={question}
              onChangeText={setQuestion}
              placeholder="Ask about any electrical term..."
              placeholderTextColor={colors.mutedForeground}
              style={[inputStyles.input, { backgroundColor: colors.muted, color: colors.foreground, borderColor: colors.border }]}
              multiline
              returnKeyType="send"
              onSubmitEditing={askQuestion}
            />
            <Pressable
              onPress={askQuestion}
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
        </KeyboardAvoidingView>
      </Modal>
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
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 6,
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
  clearBtn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  clearText: { fontSize: 12, fontFamily: "Inter_500Medium" },
});

const msgStyles = StyleSheet.create({
  qBubble: { padding: 10, borderRadius: 8, marginBottom: 6 },
  qText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  aBubble: { padding: 12, borderRadius: 8, borderWidth: 1 },
});

const emptyStyles = StyleSheet.create({
  container: { alignItems: "center", padding: 24 },
  emoji: { fontSize: 40, marginBottom: 12 },
  title: { fontSize: 18, fontFamily: "Inter_700Bold", marginBottom: 8 },
  hint: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20, marginBottom: 16 },
  chip: { width: "100%", padding: 12, borderRadius: 8, borderWidth: 1, marginBottom: 8 },
  chipText: { fontSize: 13, fontFamily: "Inter_400Regular" },
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
