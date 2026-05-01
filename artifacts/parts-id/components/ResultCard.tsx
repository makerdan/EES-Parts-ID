import React, { useState } from "react";
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { InventoryItem, SearchResult } from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";

interface ResultCardProps {
  result: SearchResult;
  onEditKeywords?: (item: InventoryItem) => void;
  rank: number;
}

const CONFIDENCE_COLORS = {
  high: "#10b981",
  medium: "#f59e0b",
  low: "#ef4444",
};

function getConfidenceLevel(confidence: number): "high" | "medium" | "low" {
  if (confidence >= 0.85) return "high";
  if (confidence >= 0.65) return "medium";
  return "low";
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const level = getConfidenceLevel(confidence);
  const color = CONFIDENCE_COLORS[level];
  const pct = Math.round(confidence * 100);
  return (
    <View style={[styles.badge, { backgroundColor: color + "22" }]}>
      <View style={[styles.badgeDot, { backgroundColor: color }]} />
      <Text style={[styles.badgeText, { color }]}>{pct}%</Text>
    </View>
  );
}

function VariantChip({
  item,
  colors,
}: {
  item: InventoryItem;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={[varStyles.chip, { backgroundColor: colors.muted, borderColor: colors.border }]}>
      <Text style={[varStyles.catalog, { color: colors.primary }]}>{item.catalog}</Text>
      {item.binLocation ? (
        <Text style={[varStyles.bin, { color: colors.mutedForeground }]}>
          {item.binLocation}
        </Text>
      ) : null}
    </View>
  );
}

const varStyles = StyleSheet.create({
  chip: {
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginRight: 6,
    marginBottom: 6,
  },
  catalog: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  bin: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 2 },
});

export function ResultCard({ result, onEditKeywords, rank }: ResultCardProps) {
  const colors = useColors();
  const [expanded, setExpanded] = useState(false);
  const { item, confidence, matchReason, seriesLabel, variants } = result;

  const hasVariants = variants && variants.length > 0;
  const hasKeywords = item.aiKeywords && item.aiKeywords.length > 0;

  return (
    <Pressable onPress={() => setExpanded(!expanded)}>
      <View
        style={[
          cardStyles.container,
          {
            backgroundColor: colors.card,
            borderColor: rank === 0 ? colors.primary : colors.border,
            borderWidth: rank === 0 ? 1.5 : 1,
          },
        ]}
      >
        {/* Header */}
        <View style={cardStyles.header}>
          <View style={cardStyles.headerLeft}>
            <View style={[cardStyles.rankBadge, { backgroundColor: rank === 0 ? colors.primary : colors.muted }]}>
              <Text style={[cardStyles.rankText, { color: rank === 0 ? colors.primaryForeground : colors.mutedForeground }]}>
                #{rank + 1}
              </Text>
            </View>
            <View style={cardStyles.titleGroup}>
              <Text style={[cardStyles.vendor, { color: colors.mutedForeground }]}>
                {item.vendor}
              </Text>
              <Text style={[cardStyles.catalog, { color: colors.foreground }]}>
                {item.catalog}
              </Text>
            </View>
          </View>
          <View style={cardStyles.headerRight}>
            <ConfidenceBadge confidence={confidence} />
          </View>
        </View>

        {/* Description */}
        <Text style={[cardStyles.description, { color: colors.foreground }]} numberOfLines={expanded ? undefined : 2}>
          {item.description || "No description"}
        </Text>

        {/* Bin location */}
        {item.binLocation ? (
          <View style={[cardStyles.binRow, { backgroundColor: colors.accent }]}>
            <Text style={[cardStyles.binIcon, { color: colors.accentForeground }]}>📍</Text>
            <Text style={[cardStyles.binText, { color: colors.accentForeground }]}>
              Bin: {item.binLocation}
            </Text>
          </View>
        ) : null}

        {/* Match reason */}
        <Text style={[cardStyles.reason, { color: colors.mutedForeground }]}>
          ↑ {matchReason}
        </Text>

        {/* Expanded content */}
        {expanded ? (
          <>
            {/* Keywords */}
            {hasKeywords ? (
              <View style={cardStyles.section}>
                <Text style={[cardStyles.sectionTitle, { color: colors.mutedForeground }]}>
                  AI KEYWORDS
                </Text>
                <View style={cardStyles.keywordRow}>
                  {item.aiKeywords.map((kw, i) => (
                    <View key={i} style={[cardStyles.keyword, { backgroundColor: colors.muted }]}>
                      <Text style={[cardStyles.keywordText, { color: colors.foreground }]}>
                        {kw}
                      </Text>
                    </View>
                  ))}
                </View>
                {onEditKeywords ? (
                  <Pressable
                    onPress={() => onEditKeywords(item)}
                    style={[cardStyles.editBtn, { borderColor: colors.border }]}
                  >
                    <Text style={[cardStyles.editBtnText, { color: colors.primary }]}>
                      ✏️ Edit Keywords
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}

            {/* Variants */}
            {hasVariants ? (
              <View style={cardStyles.section}>
                <Text style={[cardStyles.sectionTitle, { color: colors.mutedForeground }]}>
                  {seriesLabel ?? "OTHER SIZES"} ({variants!.length})
                </Text>
                <View style={cardStyles.variantRow}>
                  {variants!.slice(0, 12).map((v) => (
                    <VariantChip key={v.id} item={v} colors={colors} />
                  ))}
                  {variants!.length > 12 ? (
                    <Text style={[cardStyles.moreText, { color: colors.mutedForeground }]}>
                      +{variants!.length - 12} more
                    </Text>
                  ) : null}
                </View>
              </View>
            ) : null}

            {/* Last enriched */}
            {item.enrichedAt ? (
              <Text style={[cardStyles.enrichedAt, { color: colors.mutedForeground }]}>
                AI enriched: {new Date(item.enrichedAt).toLocaleDateString()}
              </Text>
            ) : (
              <Text style={[cardStyles.enrichedAt, { color: colors.mutedForeground }]}>
                Not AI enriched yet
              </Text>
            )}
          </>
        ) : null}

        {/* Expand chevron */}
        <Text style={[cardStyles.chevron, { color: colors.mutedForeground }]}>
          {expanded ? "▲" : "▼"}
        </Text>
      </View>
    </Pressable>
  );
}

const cardStyles = StyleSheet.create({
  container: {
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 8,
  },
  headerLeft: { flexDirection: "row", alignItems: "flex-start", flex: 1 },
  headerRight: { marginLeft: 8 },
  rankBadge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 8,
  },
  rankText: { fontSize: 11, fontFamily: "Inter_700Bold" },
  titleGroup: { flex: 1 },
  vendor: { fontSize: 11, fontFamily: "Inter_500Medium", textTransform: "uppercase", letterSpacing: 0.5 },
  catalog: { fontSize: 17, fontFamily: "Inter_700Bold", marginTop: 2 },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    gap: 4,
  },
  badgeDot: { width: 6, height: 6, borderRadius: 3 },
  badgeText: { fontSize: 12, fontFamily: "Inter_700Bold" },
  description: { fontSize: 13, fontFamily: "Inter_400Regular", lineHeight: 19, marginBottom: 8 },
  binRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 8,
    gap: 6,
  },
  binIcon: { fontSize: 14 },
  binText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  reason: { fontSize: 11, fontFamily: "Inter_400Regular", fontStyle: "italic", marginBottom: 4 },
  section: { marginTop: 12 },
  sectionTitle: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  keywordRow: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  keyword: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4 },
  keywordText: { fontSize: 12, fontFamily: "Inter_400Regular" },
  variantRow: { flexDirection: "row", flexWrap: "wrap" },
  editBtn: {
    marginTop: 10,
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
    alignSelf: "flex-start",
  },
  editBtnText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  enrichedAt: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 8 },
  moreText: { fontSize: 12, fontFamily: "Inter_400Regular", alignSelf: "center", marginBottom: 6 },
  chevron: { textAlign: "center", fontSize: 12, marginTop: 8 },
});

const styles = StyleSheet.create({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    gap: 4,
  },
  badgeDot: { width: 6, height: 6, borderRadius: 3 },
  badgeText: { fontSize: 12, fontFamily: "Inter_700Bold" },
});
