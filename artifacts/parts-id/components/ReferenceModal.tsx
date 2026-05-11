/**
 * Reference modal — quick-lookup of electrical abbreviations,
 * vendor full names, synonyms, common misspellings, and trade slang, plus
 * an SSE-streamed AI chat for free-form questions.
 *
 * Dictionaries are fetched from /dictionaries/* and cached in React Query;
 * the AI chat hits /ai/reference (Server-Sent Events) so the answer
 * streams in token-by-token.
 *
 * The trigger button that opens this modal lives in the Search screen's
 * top bar (next to Scan). This component only renders the modal itself;
 * open/close state is owned by the parent.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useColors } from '@/hooks/useColors';
import { secondaryBtnBase } from '@/styles/shared';
import { ErrorBanner } from '@/components/ErrorBanner';

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : '';

const QUICK_LOOKUP_CHIPS = [
  {
    label: '1G',
    question:
      'What is a 1-gang electrical box, what devices does it hold, and what are the standard dimensions?',
  },
  {
    label: 'GFCI',
    question: 'What does GFCI stand for, how does it work, and where is it required by the NEC?',
  },
  {
    label: 'AFCI',
    question:
      'What is an AFCI breaker or receptacle, how does it work, and where does the NEC require it?',
  },
  {
    label: 'TRWR',
    question:
      'What does TRWR mean on a receptacle — what is Tamper Resistant and Weather Resistant, and where is each required?',
  },
  {
    label: 'Decora',
    question:
      'What is a Decora style switch or receptacle, who makes them, and how do they differ from standard toggle style?',
  },
  {
    label: 'Romex',
    question:
      'What is Romex (NM-B cable), what do the numbers on the sheath mean, and when is it allowed by code?',
  },
  {
    label: 'MC Cable',
    question:
      'What is MC cable (Metal Clad armored cable), how does it differ from Romex, and when should it be used?',
  },
  {
    label: 'EMT',
    question:
      'What is EMT (Electrical Metallic Tubing) conduit, what are its common uses, and how does it differ from rigid conduit?',
  },
  {
    label: 'Toggle vs Rocker',
    question:
      'What is the difference between a toggle switch and a rocker (paddle) switch — are they interchangeable?',
  },
  {
    label: 'Duplex',
    question:
      'What is a duplex receptacle, how does it differ from simplex and quadplex outlets, and what are standard amperage ratings?',
  },
  {
    label: '15A vs 20A',
    question:
      'What is the difference between 15 amp and 20 amp circuits, receptacles, and breakers — how do I tell them apart?',
  },
  {
    label: 'AWG',
    question:
      'What does AWG mean, how does wire gauge numbering work, and which gauge should I use for common circuits?',
  },
] as const;

// ── Breaker Attributes — static inline answers (no AI call) ──────────────────
// Each entry has a label shown on the chip and a static answer that expands
// inline when the chip is tapped. No server round-trip is needed.
const BREAKER_HELP_CHIPS: { label: string; answer: string }[] = [
  {
    label: 'Amp Rating',
    answer:
      '**Amp Rating** is the trip current of the breaker — the maximum continuous load before it trips to protect the circuit.\n\nFor example, a 20 A breaker trips at 20 amperes. The amp rating is encoded as the 2–3-digit suffix after the pole digit in most catalog numbers:\n• `BR120` → 20 A (BR series, 1-pole, 20 A)\n• `QO220` → 20 A (QO series, 2-pole, 20 A)\n• `CH3100` → 100 A (CH series, 3-pole, 100 A)\n\nCommon residential ratings: **15 A** (lighting/general), **20 A** (kitchen/bath), **30 A** (dryer/HVAC), **50 A** (range/EV charger).',
  },
  {
    label: 'Poles',
    answer:
      '**Poles** is the number of circuits the breaker controls simultaneously.\n\n• **1-Pole** — controls one hot wire; used for 120 V branch circuits (lights, outlets). The first digit after the series code in most catalog numbers, e.g. `BR**1**20` = 1-pole.\n• **2-Pole** — controls two hot wires; used for 240 V loads (dryers, water heaters, A/C, EV chargers). e.g. `QO**2**30`.\n• **3-Pole** — controls three hot wires; used for 480 V / 3-phase industrial equipment. e.g. `CH**3**60`.\n\nA 2-pole breaker takes two adjacent slots in the panel and protects both legs of a 240 V circuit.',
  },
  {
    label: 'Voltage Rating',
    answer:
      '**Voltage Rating** is the maximum system voltage the breaker is certified to interrupt safely.\n\nCommon ratings:\n• **120/240 V** — standard North American residential single-phase\n• **277 V** — commercial lighting circuits (common in office buildings)\n• **480 V** — industrial 3-phase systems\n• **600 V** — heavy industrial and Canadian systems\n\nThe voltage rating must equal or exceed the system voltage. Using a 120 V–rated breaker on a 240 V circuit is a safety violation.',
  },
  {
    label: 'Frame Size (AF)',
    answer:
      '**Frame Size (AF — Ampere Frame)** is the maximum ampere capacity of the physical breaker body, regardless of the installed trip setting.\n\nA 100 AF frame can hold trip units from 15 A up to 100 A. You can swap the trip setting without replacing the physical frame.\n\nCommon frame sizes:\n• **100 AF** — residential and light commercial (15–100 A trips)\n• **225 AF** — commercial feeders (70–225 A trips)\n• **400 AF** — large commercial/industrial feeders\n• **800 AF / 1200 AF** — main service breakers\n\nThe frame size determines the physical slot size required in the panel.',
  },
  {
    label: 'AIC Rating',
    answer:
      '**AIC Rating (Ampere Interrupting Capacity)** is the maximum fault current the breaker can safely clear without failing or causing a hazard.\n\nIf a fault occurs and the available fault current exceeds the breaker\'s AIC rating, the breaker may arc, explode, or fail to interrupt — a serious fire and shock hazard.\n\nCommon ratings:\n• **10 kAIC** — standard residential (most homes have < 10 kA available)\n• **22 kAIC** — commercial panels near large utility transformers\n• **65 kAIC** — industrial switchgear\n• **200 kAIC** — high-fault industrial breakers\n\nAlways verify available fault current at the panel before selecting a breaker.',
  },
  {
    label: 'Mount Type',
    answer:
      '**Mount Type** describes how the breaker physically attaches to the panel bus bar.\n\n• **Plug-in** — the breaker snaps onto a stab-type bus bar. Used in most residential and light commercial load centers (Eaton BR/BRN, Square D QO/HOM, GE THQL). Quick to install and remove.\n• **Bolt-on** — the breaker is bolted directly to the bus bar with a screw or bolt. Used in commercial and industrial panels (Eaton CH, Square D I-Line, Siemens). More secure; required in many commercial specs.\n• **DIN Rail** — the breaker clips onto a standard 35 mm DIN rail. Used in control panels, machine enclosures, and European-style distribution boards. Not interchangeable with load center buses.',
  },
  {
    label: 'Physical Footprint',
    answer:
      '**Physical Footprint** refers to the width and slot count a breaker occupies in the panel.\n\n• **Standard (full-size)** — 1 inch wide; occupies 1 panel slot (1-pole) or 2 slots (2-pole). The most common residential format.\n• **Tandem / Duplex** — two 1-pole circuits in a single 1-inch slot (e.g., Eaton BD/BRD, Square D QO-T). Used when the panel is full and you need an extra circuit. Not all panels accept tandems — check the panel\'s approved breaker list.\n• **3/4-inch slim** — slightly narrower than standard; some manufacturers offer these for density.\n• **Commercial full-size** — wider frames (CH, I-Line) that do not fit residential load centers.',
  },
  {
    label: 'Series Codes',
    answer:
      '**Common Breaker Series Codes** decoded by manufacturer:\n\n**Eaton:** `BR` / `BRN` = BR residential plug-in · `CH` / `CHF` = CH commercial · `BAB` = bolt-on · `GFCB` / `GFTCB` = GFCI/AFCI variant\n**Square D:** `QO` = QO residential plug-in · `HOM` = Homeline economy · `I-Line` = commercial bolt-on\n**Siemens/GE:** `GHB` / `GHQ` = Siemens residential · `THQL` = GE residential · `BJ` / `BJH` = Siemens commercial\n**Other:** `MP` = Murray (Siemens-compatible) · `SWD` = switching duty\n\n**Common variant suffixes:**\n`GF` = GFCI protection · `AF` = AFCI protection · `PC` = plug-on neutral · `WHI` = white handle · `H` = high-interrupt · `SP` = surge protection',
  },
  {
    label: 'Trade Size (N/A)',
    answer:
      '**"Trade Size" does not apply to circuit breakers.**\n\n"Trade size" is the nominal designation used for **conduit and fittings** — for example, ½″ EMT, ¾″ rigid conduit, or 1″ PVC. It refers to the inside diameter category of a pipe or tube.\n\nBreakers are rated by **amperage, poles, voltage, and frame size** — none of which are trade sizes.\n\nIf you see "trade size" displayed on a breaker result, the value was likely derived incorrectly from the catalog number\'s amp/pole digits. The correct attributes to reference are Amp Rating, Poles, and Voltage Rating.',
  },
];

interface ReferenceModalProps {
  open: boolean;
  onClose: () => void;
}

export function ReferenceModal({ open, onClose }: ReferenceModalProps) {
  const colors = useColors();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [loading, setLoading] = useState(false);
  const [isError, setIsError] = useState(false);
  const [history, setHistory] = useState<{ q: string; a: string }[]>([]);
  // When true the input is pinned to a single-line height; typing re-enables auto-grow.
  const [inputCollapsed, setInputCollapsed] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  // Stores the question text that was sent so the error bubble can show it
  const askedQuestionRef = useRef('');
  // In-memory cache: question string → completed answer string (session only)
  const answerCacheRef = useRef<Map<string, string>>(new Map());
  // Y offset of the active answer container within the ScrollView content
  const answerContainerYRef = useRef<number>(0);
  // Timestamp of the last tap on any answer bubble, used for double-tap detection
  const lastAnswerTapRef = useRef<number>(0);
  // Breaker Attributes section: tracks which chip is currently expanded (label or null)
  const [activeBreakerChip, setActiveBreakerChip] = useState<string | null>(null);

  // Pre-fetch all cached quick-lookup answers from the server when the modal
  // opens so every chip tap is instant. Falls back silently if this fails.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/reference/quick-lookups`);
        if (!res.ok || cancelled) return;
        const rows = (await res.json()) as { label: string; answer: string }[];
        for (const { label, answer } of rows) {
          if (!cancelled && label && answer) {
            // Map the label back to its canonical question so chip presses hit
            // the cache using the full question string (matching handleChipPress).
            const chip = QUICK_LOOKUP_CHIPS.find((c) => c.label === label);
            if (chip && !answerCacheRef.current.has(chip.question.trim())) {
              answerCacheRef.current.set(chip.question.trim(), answer);
            }
          }
        }
      } catch {
        // Pre-fetch failure is non-fatal; the on-demand SSE path is the fallback.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // askQuestion accepts an optional override so chip handlers can pass the
  // question text directly without waiting for a setState flush.
  const askQuestion = useCallback(
    async (overrideText?: string) => {
      const q = (overrideText ?? question).trim();
      if (!q || loading) return;
      askedQuestionRef.current = q;
      setQuestion('');
      setLoading(true);
      setIsError(false);
      setAnswer('');

      try {
        // Use the JSON (non-streaming) mode so this works on iOS React Native,
        // which does not expose ReadableStream on fetch response bodies.
        const res = await fetch(`${API_BASE}/reference/ask?stream=false`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ question: q }),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = (await res.json()) as { answer?: string };
        const fullText = data.answer ?? '';

        if (fullText) {
          setAnswer(fullText);
          // Scroll so the answer bubble sits in the upper–middle portion
          // of the viewport rather than snapping to the very bottom edge.
          const targetY = Math.max(0, answerContainerYRef.current - 120);
          scrollRef.current?.scrollTo({ y: targetY, animated: true });
          setHistory((h) => [...h, { q: askedQuestionRef.current, a: fullText }]);
          // Cache the completed answer so repeat chip taps are instant.
          answerCacheRef.current.set(q, fullText);
        } else {
          setIsError(true);
        }
      } catch {
        setIsError(true);
      } finally {
        setLoading(false);
      }
    },
    [question, loading]
  );

  const clearAll = () => {
    setQuestion('');
    setAnswer('');
    setIsError(false);
    setHistory([]);
  };

  // Clears only the active answer bubble; history entries remain intact.
  const clearAnswer = () => {
    setAnswer('');
    setIsError(false);
    setQuestion('');
  };

  // Tracks an in-flight chip DB fetch so double-taps are ignored without
  // involving the main `loading` state (which would show the send-button spinner).
  const chipFetchingRef = useRef(false);

  // Called by chip onPress: show a cached answer instantly (in-memory cache) or
  // silently fetch from the DB quick-lookup endpoint (non-streaming JSON, no spinner).
  // Chips never set `loading` and never enter the SSE streaming path.
  const handleChipPress = useCallback(
    async (chipQuestion: string, chipLabel: string) => {
      if (loading || chipFetchingRef.current) return;
      const q = chipQuestion.trim();
      const cached = answerCacheRef.current.get(q);
      if (cached) {
        askedQuestionRef.current = q;
        setQuestion('');
        setAnswer(cached);
        setIsError(false);
        // Scroll to the answer bubble after a short layout delay
        setTimeout(() => {
          const targetY = Math.max(0, answerContainerYRef.current - 120);
          scrollRef.current?.scrollTo({ y: targetY, animated: true });
        }, 80);
        return;
      }

      // Not in memory — fetch directly from the DB cache.
      // No setLoading call here: chips must never show the send-button spinner.
      chipFetchingRef.current = true;
      askedQuestionRef.current = q;
      setQuestion('');
      setIsError(false);
      setAnswer('');
      try {
        const res = await fetch(
          `${API_BASE}/reference/quick-lookups/${encodeURIComponent(chipLabel)}`
        );
        if (res.ok) {
          const data = (await res.json()) as { answer: string };
          if (data.answer) {
            setAnswer(data.answer);
            answerCacheRef.current.set(q, data.answer);
            chipFetchingRef.current = false;
            return;
          }
        }
        // DB cache miss (404) or empty answer — fall back to the full AI call
        // so the user always gets an answer rather than a dead error state.
        chipFetchingRef.current = false;
        await askQuestion(q);
      } catch {
        chipFetchingRef.current = false;
        await askQuestion(q);
      }
    },
    [loading, askQuestion]
  );

  // Detects a double-tap (two taps within 300 ms) on any answer bubble and
  // collapses the input back to a single-line height.
  const handleAnswerDoubleTap = useCallback(() => {
    const now = Date.now();
    if (now - lastAnswerTapRef.current < 300) {
      setInputCollapsed(true);
    }
    lastAnswerTapRef.current = now;
  }, []);

  // Simple markdown bold renderer
  const renderAnswer = (text: string) => {
    const parts = text.split(/(\*\*[^*]+\*\*)/g);
    return parts.map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return (
          <Text key={i} style={{ fontFamily: 'Inter_700Bold', color: colors.foreground }}>
            {part.slice(2, -2)}
          </Text>
        );
      }
      return (
        <Text key={i} style={{ fontFamily: 'Inter_400Regular', color: colors.foreground }}>
          {part}
        </Text>
      );
    });
  };

  // True only in the pure empty state — no history, no answer, not loading, no error.
  const isEmpty = !history.length && !answer && !loading && !isError;

  return (
    <Modal
      visible={open}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={[modalStyles.container, { backgroundColor: colors.background }]}
      >
        {/* Header */}
        <View style={[modalStyles.header, { borderBottomColor: colors.border }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={[modalStyles.accentBar, { backgroundColor: colors.primary }]} />
            <View>
              <Text style={[modalStyles.title, { color: colors.foreground }]}>⚡ Reference AI</Text>
              <Text style={[modalStyles.subtitle, { color: colors.mutedForeground }]}>
                Ask about electrical terms & codes
              </Text>
            </View>
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {history.length > 0 ? (
              <Pressable
                onPress={clearAll}
                style={[modalStyles.clearBtn, { borderColor: colors.border }]}
              >
                <Text style={[modalStyles.clearText, { color: colors.mutedForeground }]}>
                  Clear
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={onClose}
              style={[modalStyles.closeBtn, { backgroundColor: colors.muted }]}
            >
              <Text style={[modalStyles.closeText, { color: colors.foreground }]}>✕</Text>
            </Pressable>
          </View>
        </View>

        {/* History + active answer + empty state */}
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={[{ padding: 16 }, isEmpty && { flexGrow: 1 }]}
          keyboardShouldPersistTaps="handled"
        >
          {history.map((h, i) => (
            <View key={i} style={{ marginBottom: 16 }}>
              <View style={[msgStyles.qBubble, { backgroundColor: colors.primary + '22' }]}>
                <Text style={[msgStyles.qText, { color: colors.foreground }]}>Q: {h.q}</Text>
              </View>
              <Pressable
                onPress={handleAnswerDoubleTap}
                style={[
                  msgStyles.aBubble,
                  { backgroundColor: colors.card, borderColor: colors.border },
                ]}
              >
                <Text style={{ fontSize: 14, lineHeight: 22 }}>{renderAnswer(h.a)}</Text>
              </Pressable>
            </View>
          ))}

          {/* Active Q+A — visible as soon as loading starts so questions feel instant */}
          {answer || loading || isError ? (
            <View
              style={{ marginBottom: 16 }}
              onLayout={(e) => {
                answerContainerYRef.current = e.nativeEvent.layout.y;
              }}
            >
              <View style={[msgStyles.qBubble, { backgroundColor: colors.primary + '22' }]}>
                <Text style={[msgStyles.qText, { color: colors.foreground }]}>
                  Q: {askedQuestionRef.current || question}
                </Text>
              </View>
              {isError ? (
                <View style={msgStyles.errorWrap}>
                  <ErrorBanner message="No answer — check your connection and try again." />
                  <Pressable
                    onPress={() => askQuestion(askedQuestionRef.current)}
                    style={[msgStyles.retryBtn, { borderColor: colors.primary }]}
                  >
                    <Text
                      style={{
                        fontSize: 13,
                        color: colors.primary,
                        fontFamily: 'Inter_600SemiBold',
                      }}
                    >
                      ↺ Retry
                    </Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable
                  onPress={handleAnswerDoubleTap}
                  style={[
                    msgStyles.aBubble,
                    { backgroundColor: colors.card, borderColor: colors.border },
                  ]}
                >
                  {/* Clear button — only shown when answer is complete */}
                  {!loading && answer ? (
                    <Pressable
                      onPress={clearAnswer}
                      style={[msgStyles.clearAnswerBtn, { backgroundColor: colors.muted }]}
                      hitSlop={8}
                    >
                      <Text style={[msgStyles.clearAnswerText, { color: colors.mutedForeground }]}>
                        ✕
                      </Text>
                    </Pressable>
                  ) : null}
                  {answer ? (
                    <Text
                      style={{
                        fontSize: 14,
                        lineHeight: 22,
                        paddingRight: answer && !loading ? 28 : 0,
                      }}
                    >
                      {renderAnswer(answer)}
                    </Text>
                  ) : null}
                  {/* Spinner shown while loading (whether or not streaming has started) */}
                  {loading ? (
                    <ActivityIndicator
                      size="small"
                      color={colors.primary}
                      style={{ marginTop: answer ? 4 : 0, alignSelf: 'flex-start' }}
                    />
                  ) : null}
                </Pressable>
              )}
            </View>
          ) : null}

          {/* Empty state — inline input sits directly above Quick Lookups */}
          {isEmpty ? (
            <View style={emptyStyles.container}>
              <Text style={emptyStyles.emoji}>🤖</Text>
              <Text style={[emptyStyles.title, { color: colors.foreground }]}>Ask the AI</Text>
              <Text style={[emptyStyles.hint, { color: colors.mutedForeground }]}>
                Ask about NEMA codes, wire gauges, breaker ratings, conduit types, or any electrical
                term and it will generate an answer for you.
              </Text>

              {/* Inline input row — sits directly above Quick Lookups in empty state */}
              <View
                style={[
                  inlineInputStyles.bar,
                  { backgroundColor: colors.card, borderColor: colors.border },
                ]}
              >
                <TextInput
                  value={question}
                  onChangeText={(text) => {
                    setQuestion(text);
                    setInputCollapsed(false);
                  }}
                  placeholder="Ask about any electrical term..."
                  placeholderTextColor={colors.mutedForeground}
                  style={[
                    inputStyles.input,
                    {
                      backgroundColor: colors.muted,
                      color: colors.foreground,
                      borderColor: colors.border,
                    },
                    inputCollapsed ? { height: 40, maxHeight: 40 } : { maxHeight: 144 },
                  ]}
                  multiline
                  returnKeyType="send"
                  onSubmitEditing={() => askQuestion()}
                />
                <Pressable
                  onPress={() => askQuestion()}
                  disabled={loading || !question.trim()}
                  style={[
                    inputStyles.sendBtn,
                    { backgroundColor: loading ? colors.muted : colors.primary },
                  ]}
                >
                  {loading ? (
                    <ActivityIndicator size="small" color={colors.primaryForeground} />
                  ) : (
                    <Text style={[inputStyles.sendText, { color: colors.primaryForeground }]}>
                      →
                    </Text>
                  )}
                </Pressable>
              </View>

              {/* ── Quick Lookups section ── */}
              <View style={emptyStyles.chipsWrapper}>
                <Text style={[emptyStyles.sectionLabel, { color: colors.mutedForeground }]}>
                  QUICK LOOKUPS
                </Text>
                {QUICK_LOOKUP_CHIPS.map(({ label, question: q }) => (
                  <Pressable
                    key={label}
                    onPress={() => handleChipPress(q, label)}
                    style={[
                      emptyStyles.chip,
                      { backgroundColor: colors.muted, borderColor: colors.border },
                    ]}
                  >
                    <Text style={[emptyStyles.chipText, { color: colors.foreground }]}>
                      {label}
                    </Text>
                  </Pressable>
                ))}
              </View>

              {/* ── Breaker Attributes section ── */}
              <View style={[emptyStyles.chipsWrapper, { marginTop: 20 }]}>
                <Text style={[emptyStyles.sectionLabel, { color: colors.mutedForeground }]}>
                  BREAKER ATTRIBUTES
                </Text>
                <Text
                  style={[
                    emptyStyles.sectionHint,
                    { color: colors.mutedForeground },
                  ]}
                >
                  Tap a term to see its definition and catalog-number examples — no internet
                  required.
                </Text>
                {BREAKER_HELP_CHIPS.map(({ label, answer: staticAnswer }) => {
                  const isActive = activeBreakerChip === label;
                  return (
                    <View key={label} style={{ marginBottom: 6 }}>
                      <Pressable
                        onPress={() => setActiveBreakerChip(isActive ? null : label)}
                        style={[
                          breakerChipStyles.chip,
                          {
                            backgroundColor: isActive
                              ? colors.primary + '18'
                              : colors.muted,
                            borderColor: isActive ? colors.primary : colors.border,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            breakerChipStyles.chipText,
                            {
                              color: isActive ? colors.primary : colors.foreground,
                              fontFamily: isActive ? 'Inter_600SemiBold' : 'Inter_400Regular',
                            },
                          ]}
                        >
                          {label}
                        </Text>
                        <Text
                          style={[
                            breakerChipStyles.chevron,
                            { color: isActive ? colors.primary : colors.mutedForeground },
                          ]}
                        >
                          {isActive ? '▲' : '▼'}
                        </Text>
                      </Pressable>
                      {isActive ? (
                        <View
                          style={[
                            breakerChipStyles.answerBox,
                            {
                              backgroundColor: colors.card,
                              borderColor: colors.border,
                            },
                          ]}
                        >
                          <Text style={{ fontSize: 13, lineHeight: 20 }}>
                            {renderAnswer(staticAnswer)}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                  );
                })}
              </View>
            </View>
          ) : null}
        </ScrollView>

        {/* Bottom input bar — only shown when there is chat history, an active answer, or loading */}
        {history.length > 0 || answer || loading || isError ? (
          <View
            style={[
              inputStyles.bar,
              { backgroundColor: colors.card, borderTopColor: colors.border },
            ]}
          >
            <TextInput
              value={question}
              onChangeText={(text) => {
                setQuestion(text);
                setInputCollapsed(false);
              }}
              placeholder="Ask about any electrical term..."
              placeholderTextColor={colors.mutedForeground}
              style={[
                inputStyles.input,
                {
                  backgroundColor: colors.muted,
                  color: colors.foreground,
                  borderColor: colors.border,
                },
                inputCollapsed ? { height: 40, maxHeight: 40 } : { maxHeight: 144 },
              ]}
              multiline
              returnKeyType="send"
              onSubmitEditing={() => askQuestion()}
            />
            <Pressable
              onPress={() => askQuestion()}
              disabled={loading || !question.trim()}
              style={[
                inputStyles.sendBtn,
                { backgroundColor: loading ? colors.muted : colors.primary },
              ]}
            >
              {loading ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : (
                <Text style={[inputStyles.sendText, { color: colors.primaryForeground }]}>→</Text>
              )}
            </Pressable>
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </Modal>
  );
}

const modalStyles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    paddingTop: 20,
    borderBottomWidth: 1,
  },
  accentBar: { width: 3, height: 20, borderRadius: 2 },
  title: { fontSize: 18, fontFamily: 'Inter_700Bold' },
  subtitle: { fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 2 },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: { fontSize: 14, fontFamily: 'Inter_500Medium' },
  clearBtn: { ...secondaryBtnBase, paddingHorizontal: 10, paddingVertical: 5 },
  clearText: { fontSize: 12, fontFamily: 'Inter_500Medium' },
});

const msgStyles = StyleSheet.create({
  qBubble: { padding: 10, borderRadius: 8, marginBottom: 6 },
  qText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  aBubble: { ...secondaryBtnBase, padding: 12 },
  errorWrap: { marginBottom: 4 },
  retryBtn: {
    alignSelf: 'flex-start',
    marginTop: 4,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 6,
    borderWidth: 1,
  },
  clearAnswerBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  clearAnswerText: { fontSize: 11, fontFamily: 'Inter_500Medium' },
});

const inlineInputStyles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    width: '100%',
    padding: 10,
    gap: 10,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 20,
  },
});

const emptyStyles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
    paddingHorizontal: 8,
  },
  emoji: { fontSize: 40, marginBottom: 12, alignSelf: 'center' },
  title: { fontSize: 18, fontFamily: 'Inter_700Bold', marginBottom: 8 },
  hint: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 28,
  },
  chipsWrapper: { width: '100%' },
  sectionLabel: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  sectionHint: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    lineHeight: 18,
    marginBottom: 10,
    marginTop: -4,
  },
  chip: { ...secondaryBtnBase, width: '100%', padding: 12, marginBottom: 8 },
  chipText: { fontSize: 13, fontFamily: 'Inter_400Regular' },
});

const breakerChipStyles = StyleSheet.create({
  chip: {
    ...secondaryBtnBase,
    width: '100%',
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  chipText: { fontSize: 13, flex: 1 },
  chevron: { fontSize: 10, marginLeft: 8 },
  answerBox: {
    borderWidth: 1,
    borderTopWidth: 0,
    borderBottomLeftRadius: 8,
    borderBottomRightRadius: 8,
    padding: 12,
    marginTop: -1,
  },
});

const inputStyles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
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
    fontFamily: 'Inter_400Regular',
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendText: { fontSize: 18, fontFamily: 'Inter_700Bold' },
});
