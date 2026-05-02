import React, { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { SearchResult } from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";
import { CHIP_DIMS, type ChipDim } from "@/components/FilterPanel";
import { applyRefinement, itemFullText, tokenMatch, type RefinementState } from "@/lib/refinement";

// Re-export so callers can keep importing the helpers + state type from this module.
export { applyRefinement, itemFullText, tokenMatch };
export type { RefinementState };

interface Props {
  results: SearchResult[];
  refinement: RefinementState;
  onChange: (next: RefinementState) => void;
}

export function ResultRefinementBar({ results, refinement, onChange }: Props) {
  const colors = useColors();

  // For each dim, compute counts for each option *under all OTHER active
  // refinements*. Mirrors the server's dimensionCounts pattern so users see
  // how many results would remain if they tapped a given chip.
  const dimsWithCounts = useMemo(() => {
    const out: Array<{ dim: ChipDim; counts: Record<string, number>; visibleOptions: string[] }> = [];
    for (const dim of CHIP_DIMS) {
      const otherRefinement: RefinementState = { ...refinement };
      delete otherRefinement[dim.key];
      const subset = applyRefinement(results, otherRefinement);
      const counts: Record<string, number> = {};
      for (const opt of dim.options) {
        const matched = subset.reduce(
          (acc, r) => (tokenMatch(itemFullText(r.item), opt) ? acc + 1 : acc),
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

  if (dimsWithCounts.length === 0) return null;

  return (
    <View style={[styles.container, { borderColor: colors.border, backgroundColor: colors.card }]}>
      <Text style={[styles.title, { color: colors.mutedForeground }]}>REFINE RESULTS</Text>
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
