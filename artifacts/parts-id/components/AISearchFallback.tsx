import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useColors } from "@/hooks/useColors";
import { ResultCard } from "@/components/ResultCard";
import type { InventoryItem, SearchResult } from "@workspace/api-client-react";

// ── SearchedAsRow ─────────────────────────────────────────────────────────────

interface SearchedAsRowProps {
  terms: string[];
  interpretation: string;
  onDismiss: () => void;
}

export function SearchedAsRow({ terms, interpretation, onDismiss }: SearchedAsRowProps) {
  const colors = useColors();
  if (terms.length === 0) return null;
  return (
    <View style={[rowStyles.container, { backgroundColor: colors.muted, borderColor: colors.border }]}>
      <View style={rowStyles.left}>
        <Text style={[rowStyles.label, { color: colors.mutedForeground }]}>Searched as:</Text>
        <View style={rowStyles.chips}>
          {terms.map((term, i) => (
            <View key={i} style={[rowStyles.chip, { backgroundColor: colors.primary + "18", borderColor: colors.primary + "44" }]}>
              <Text style={[rowStyles.chipText, { color: colors.primary }]}>{term}</Text>
            </View>
          ))}
        </View>
        {interpretation ? (
          <Text style={[rowStyles.interpretation, { color: colors.mutedForeground }]} numberOfLines={1}>
            {interpretation}
          </Text>
        ) : null}
      </View>
      <Pressable onPress={onDismiss} hitSlop={8} style={rowStyles.dismiss} accessibilityLabel="Dismiss translation hint">
        <Text style={[rowStyles.dismissText, { color: colors.mutedForeground }]}>✕</Text>
      </Pressable>
    </View>
  );
}

const rowStyles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginHorizontal: 12,
    marginBottom: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    gap: 8,
  },
  left: { flex: 1, gap: 4 },
  label: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
  },
  chip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    borderWidth: 1,
  },
  chipText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  interpretation: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    lineHeight: 15,
    marginTop: 2,
  },
  dismiss: { paddingTop: 2 },
  dismissText: { fontSize: 14 },
});

// ── AIZeroResultsCard ─────────────────────────────────────────────────────────

interface AIZeroResultsCardProps {
  loading: boolean;
  partName: string;
  partSpecs: string[];
  catalogNumbers: string[];
  substitutes: SearchResult[];
  error: string | null;
  onShowOnMap: (item: InventoryItem) => void;
  fontScale?: number;
}

export function AIZeroResultsCard({
  loading,
  partName,
  partSpecs,
  catalogNumbers,
  substitutes,
  error,
  onShowOnMap,
  fontScale = 1.0,
}: AIZeroResultsCardProps) {
  const colors = useColors();

  return (
    <View style={[cardStyles.container, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={cardStyles.header}>
        <Text style={[cardStyles.headerIcon]}>🤖</Text>
        <View style={{ flex: 1 }}>
          <Text style={[cardStyles.headerTitle, { color: colors.foreground }]}>
            AI Part Identification
          </Text>
          <Text style={[cardStyles.headerSub, { color: colors.mutedForeground }]}>
            Web knowledge · not your inventory
          </Text>
        </View>
      </View>

      {loading ? (
        <View style={cardStyles.loadingRow}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={[cardStyles.loadingText, { color: colors.mutedForeground }]}>
            Identifying part…
          </Text>
        </View>
      ) : error ? (
        <Text style={[cardStyles.errorText, { color: colors.mutedForeground }]}>
          ⚠ {error === "AI unavailable" ? "AI assistant unavailable — check your connection." : error}
        </Text>
      ) : (
        <>
          {partName ? (
            <Text style={[cardStyles.partName, { color: colors.foreground }]}>{partName}</Text>
          ) : null}

          {partSpecs.length > 0 ? (
            <View style={cardStyles.specsBlock}>
              <Text style={[cardStyles.sectionLabel, { color: colors.mutedForeground }]}>KEY SPECS</Text>
              <View style={cardStyles.specsList}>
                {partSpecs.map((spec, i) => (
                  <View key={i} style={[cardStyles.specChip, { backgroundColor: colors.muted, borderColor: colors.border }]}>
                    <Text style={[cardStyles.specText, { color: colors.foreground }]}>{spec}</Text>
                  </View>
                ))}
              </View>
            </View>
          ) : null}

          {catalogNumbers.length > 0 ? (
            <View style={cardStyles.catalogBlock}>
              <Text style={[cardStyles.sectionLabel, { color: colors.mutedForeground }]}>COMMON CATALOG #s</Text>
              <Text style={[cardStyles.catalogNumbers, { color: colors.foreground }]}>
                {catalogNumbers.join(" · ")}
              </Text>
            </View>
          ) : null}

          {substitutes.length > 0 ? (
            <View style={cardStyles.substitutesBlock}>
              <View style={[cardStyles.substituteHeader, { borderColor: colors.border }]}>
                <Text style={[cardStyles.sectionLabel, { color: colors.mutedForeground }]}>
                  CLOSEST IN STOCK ({substitutes.length})
                </Text>
                <View style={[cardStyles.substituteBadge, { backgroundColor: colors.warning + "22" }]}>
                  <Text style={[cardStyles.substituteBadgeText, { color: colors.warning }]}>SUBSTITUTE</Text>
                </View>
              </View>
              {substitutes.map((result, i) => (
                <View key={result.item.id} style={[cardStyles.substituteCard, { borderColor: colors.border }]}>
                  <ResultCard
                    result={result}
                    onShowOnMap={onShowOnMap}
                    rank={i}
                    fontScale={fontScale}
                  />
                </View>
              ))}
            </View>
          ) : (
            !loading && !error && partName ? (
              <Text style={[cardStyles.noSubstitutes, { color: colors.mutedForeground }]}>
                No close substitutes found in current inventory.
              </Text>
            ) : null
          )}

          {!partName && !loading && !error ? (
            <Text style={[cardStyles.errorText, { color: colors.mutedForeground }]}>
              Could not identify this part. Try a different search term.
            </Text>
          ) : null}
        </>
      )}
    </View>
  );
}

const cardStyles = StyleSheet.create({
  container: {
    marginHorizontal: 0,
    marginTop: 12,
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    marginBottom: 10,
  },
  headerIcon: { fontSize: 20, marginTop: 1 },
  headerTitle: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    marginBottom: 2,
  },
  headerSub: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
  },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
  },
  loadingText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
  },
  errorText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
    paddingVertical: 4,
  },
  partName: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    marginBottom: 10,
  },
  sectionLabel: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  specsBlock: { marginBottom: 10 },
  specsList: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  specChip: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    borderWidth: 1,
  },
  specText: { fontSize: 12, fontFamily: "Inter_500Medium" },
  catalogBlock: { marginBottom: 10 },
  catalogNumbers: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    lineHeight: 18,
  },
  substitutesBlock: { marginTop: 4 },
  substituteHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderTopWidth: 1,
    paddingTop: 10,
    marginBottom: 8,
  },
  substituteBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  substituteBadgeText: {
    fontSize: 9,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.5,
  },
  substituteCard: {
    borderTopWidth: 1,
    paddingTop: 6,
    marginTop: 2,
  },
  noSubstitutes: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    marginTop: 8,
    fontStyle: "italic",
  },
});
