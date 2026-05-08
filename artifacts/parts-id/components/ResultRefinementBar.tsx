import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import type { SearchResult } from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";
import { CHIP_DIMS, type ChipDim } from "@/components/FilterPanel";
import {
  applyRefinement,
  EXTRA_KEYWORDS_KEY,
  extractHighlightTokens,
  itemFullText,
  tokenMatch,
  type RefinementState,
} from "@/lib/refinement";

// Re-export so callers can keep importing the helpers + state type from this module.
export { applyRefinement, itemFullText, tokenMatch, extractHighlightTokens };
export type { RefinementState };

interface Props {
  results: SearchResult[];
  refinement: RefinementState;
  onChange: (next: RefinementState) => void;
}

// Light debounce so filtering runs once a typing burst settles, without making
// the input feel sluggish.
const EXTRA_KEYWORDS_DEBOUNCE_MS = 150;

export function ResultRefinementBar({ results, refinement, onChange }: Props) {
  const colors = useColors();

  // Local state for the "Add keywords" input — keeps typing snappy and lets us
  // debounce the heavier upstream filter pass.
  const [extraInput, setExtraInput] = useState<string>(refinement.extraKeywords ?? "");

  // Latest props in refs so the debounce closure always sees current values
  // without re-creating the timer on every parent render.
  const refinementRef = useRef(refinement);
  useEffect(() => { refinementRef.current = refinement; }, [refinement]);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  // Sync local input when refinement.extraKeywords is reset/changed externally
  // (e.g. parent calls setRefinement({}) on new search or "Clear refinement").
  useEffect(() => {
    const upstream = refinement.extraKeywords ?? "";
    setExtraInput(prev => (prev === upstream ? prev : upstream));
  }, [refinement.extraKeywords]);

  // Debounce typed input → upstream refinement state.
  useEffect(() => {
    const trimmed = extraInput.trim();
    const current = (refinementRef.current.extraKeywords ?? "").trim();
    if (trimmed === current) return;
    const id = setTimeout(() => {
      const next: RefinementState = { ...refinementRef.current };
      if (trimmed) next[EXTRA_KEYWORDS_KEY] = trimmed;
      else delete next[EXTRA_KEYWORDS_KEY];
      onChangeRef.current(next);
    }, EXTRA_KEYWORDS_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [extraInput]);

  // For each chip dim, compute counts under all OTHER active refinements
  // (chips + extra keywords). Mirrors the server's dimensionCounts pattern so
  // users see how many results would remain if they tapped a given chip.
  const dimsWithCounts = useMemo(() => {
    const out: Array<{ dim: ChipDim; counts: Record<string, number>; visibleOptions: string[] }> = [];
    for (const dim of CHIP_DIMS) {
      const otherRefinement: RefinementState = { ...refinement };
      delete otherRefinement[dim.key];
      const subset = applyRefinement(results, otherRefinement);
      const counts: Record<string, number> = {};
      for (const opt of dim.options) {
        const matched = subset.reduce(
          (acc, r) => {
            const text = dim.key === "category"
              ? (r.item.aiKeywords ?? []).join(" ").toLowerCase()
              : itemFullText(r.item);
            return tokenMatch(text, opt) ? acc + 1 : acc;
          },
          0,
        );
        if (matched > 0) counts[opt] = matched;
      }
      const selected = refinement[dim.key];
      const optKeys = Object.keys(counts);
      // Always keep the currently-selected option visible even if its count
      // collapsed to zero under the new refinement (gives the user a way to
      // un-tap it without resetting everything).
      const visibleOptions = selected && !optKeys.includes(selected)
        ? [...optKeys, selected]
        : optKeys;
      // Show the dim only when there's meaningful variation OR when one of
      // its options is currently selected.
      if (visibleOptions.length > 1 || selected) {
        out.push({ dim, counts, visibleOptions });
      }
    }
    return out;
  }, [results, refinement]);

  return (
    <View style={[styles.container, { borderColor: colors.border, backgroundColor: colors.card }]}>
      <Text style={[styles.title, { color: colors.mutedForeground }]}>REFINE RESULTS</Text>

      {/* Free-text "Add keywords" input — narrows the in-memory list without a
          new server round-trip. Always visible after a search. */}
      <View
        style={[
          styles.kwRow,
          {
            backgroundColor: colors.muted,
            borderColor: extraInput ? colors.primary : colors.border,
          },
        ]}
      >
        <Feather name="search" size={13} color={colors.mutedForeground} style={styles.kwIcon} />
        <TextInput
          value={extraInput}
          onChangeText={setExtraInput}
          placeholder="Add keywords (e.g. blue, weatherproof)…"
          placeholderTextColor={colors.mutedForeground}
          style={[styles.kwInput, { color: colors.foreground }]}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          accessibilityLabel="Add keywords to refine the current results"
        />
        {extraInput ? (
          <Pressable
            onPress={() => setExtraInput("")}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Clear added keywords"
          >
            <Feather name="x-circle" size={14} color={colors.mutedForeground} />
          </Pressable>
        ) : null}
      </View>

      {dimsWithCounts.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.row}>
            {dimsWithCounts.map(({ dim, counts, visibleOptions }, dimIdx) => (
              <View key={dim.key} style={styles.dimGroup}>
                {dimIdx > 0 ? (
                  <View style={[styles.divider, { backgroundColor: colors.border }]} />
                ) : null}
                <Text style={[styles.dimLabel, { color: colors.mutedForeground }]}>{dim.label}</Text>
                {visibleOptions.map(opt => {
                  const active = refinement[dim.key] === opt;
                  const count = counts[opt] ?? 0;
                  return (
                    <Pressable
                      key={`${String(dim.key)}:${opt}`}
                      onPress={() => {
                        const next: RefinementState = { ...refinement };
                        if (active) {
                          delete next[dim.key];
                        } else {
                          next[dim.key] = opt;
                        }
                        onChange(next);
                      }}
                      style={[
                        styles.chip,
                        {
                          backgroundColor: active ? colors.primary : colors.muted,
                          borderColor: active ? colors.primary : colors.border,
                        },
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel={`Refine by ${dim.label} ${opt}, ${count} ${count === 1 ? "match" : "matches"}`}
                      accessibilityState={{ selected: active }}
                    >
                      <Text
                        style={[
                          styles.chipText,
                          {
                            color: active ? colors.primaryForeground : colors.foreground,
                          },
                        ]}
                      >
                        {opt} ({count})
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            ))}
          </View>
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: 12,
    marginBottom: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
  },
  title: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.8,
    marginBottom: 6,
  },
  kwRow: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginBottom: 8,
  },
  kwIcon: {
    marginRight: 6,
  },
  kwInput: {
    flex: 1,
    paddingVertical: 4,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 2,
  },
  dimGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  dimLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    marginRight: 2,
    marginLeft: 2,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  divider: {
    width: 1,
    height: 18,
    marginHorizontal: 6,
    opacity: 0.6,
  },
  chip: {
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  chipText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
});
