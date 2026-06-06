import React, { useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { InventoryItem, SearchResult } from "@workspace/api-client-react";
import type { PartDimensions } from "@/components/MeasurePartScreen";
import { RetryImage } from "@/components/RetryImage";
import { useColors } from "@/hooks/useColors";

interface ResultCardProps {
  result: SearchResult;
  /** Admin-only: opens the full part details editor. */
  onEditItem?: (item: InventoryItem) => void;
  /** Navigate to warehouse map and open this part's zone. */
  onShowOnMap?: (item: InventoryItem) => void;
  /** Admin-only: opens the measurement screen for this unmeasured item. */
  onMeasure?: (item: InventoryItem) => void;
  /**
   * Called when the variants section is expanded or collapsed.
   * Only fires when the result has at least one variant.
   * Receives the full variants array and the new expanded state so the caller
   * can add / remove map location pins grouped by item.
   */
  onVariantsToggle?: (variants: InventoryItem[], expanded: boolean) => void;
  rank: number;
  fontScale?: number;
  /** When true, shows a "Size not measured" badge because no dimension data is stored for this item */
  sizeUnknown?: boolean;
}

const CONFIDENCE_COLORS = {
  high: "#10b981",
  medium: "#f59e0b",
  low: "#ef4444",
};

function getConfidenceLevel(confidence: number): "high" | "medium" | "low" {
  if (confidence >= 0.85) return "high";
  if (confidence >= 0.60) return "medium";
  return "low";
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const level = getConfidenceLevel(confidence);
  const color = CONFIDENCE_COLORS[level];
  const pct = Math.round(confidence * 100);
  return (
    <View style={[cardStyles.badge, { backgroundColor: color + "22" }]}>
      <View style={[cardStyles.badgeDot, { backgroundColor: color }]} />
      <Text style={[cardStyles.badgeText, { color }]}>{pct}%</Text>
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
      {item.binLocations && item.binLocations.length > 0 ? (
        <Text style={[varStyles.bin, { color: colors.mutedForeground }]}>
          {item.binLocations.join(", ")}
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

export function ResultCard({ result, onEditItem, onShowOnMap, onMeasure, onVariantsToggle, rank, fontScale = 1.0, sizeUnknown = false }: ResultCardProps) {
  "use no memo";
  const colors = useColors();
  const [expanded, setExpanded] = useState(false);
  const { item, confidence, seriesLabel, variants } = result;
  const fs = (base: number) => Math.round(base * fontScale);

  const hasVariants = variants && variants.length > 0;
  const hasKeywords = item.aiKeywords && item.aiKeywords.length > 0;

  const handlePress = () => {
    const next = !expanded;
    setExpanded(next);
    if (hasVariants && onVariantsToggle) {
      onVariantsToggle(variants!, next);
    }
  };

  return (
    <Pressable onPress={handlePress}>
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
              <Text style={[cardStyles.vendor, { color: colors.mutedForeground, fontSize: fs(11) }]}>
                {item.vendor}
              </Text>
              <Text style={[cardStyles.catalog, { color: colors.foreground, fontSize: fs(17) }]}>
                {item.catalog}
              </Text>
            </View>
          </View>
          <View style={cardStyles.headerRight}>
            {item.imageUrl ? (
              <RetryImage
                uri={item.imageUrl}
                style={cardStyles.thumbnail}
                resizeMode="contain"
              />
            ) : null}
            <ConfidenceBadge confidence={confidence} />
            {onEditItem ? (
              <Pressable
                onPress={(e) => { e.stopPropagation?.(); onEditItem(item); }}
                hitSlop={8}
                style={[cardStyles.editItemBtn, { backgroundColor: colors.muted, borderColor: colors.border }]}
              >
                <Text style={[cardStyles.editItemBtnText, { color: colors.primary }]}>✏️ Edit</Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        {/* Description */}
        <Text style={[cardStyles.description, { color: colors.foreground, fontSize: fs(13) }]} numberOfLines={expanded ? undefined : 2}>
          {item.description || "No description"}
        </Text>

        {/* Bin location(s) — read-only */}
        {item.binLocations && item.binLocations.length > 0 ? (
          <View style={[cardStyles.binRow, { backgroundColor: colors.accent }]}>
            <Text style={[cardStyles.binIcon, { color: colors.accentForeground }]}>📍</Text>
            <Text style={[cardStyles.binText, { color: colors.accentForeground, flex: 1 }]}>
              {item.binLocations.length === 1 ? "Bin: " : "Bins: "}
              {item.binLocations.join(", ")}
            </Text>
            {onShowOnMap ? (
              <Pressable
                onPress={(e) => { e.stopPropagation?.(); onShowOnMap(item); }}
                hitSlop={8}
                style={[cardStyles.binActionBtn, { borderColor: colors.accentForeground + "44" }]}
              >
                <Text style={[cardStyles.binActionText, { color: colors.accentForeground }]}>Map it!</Text>
              </Pressable>
            ) : null}
          </View>
        ) : (
          <View style={[cardStyles.binRow, { backgroundColor: colors.muted }]}>
            <Text style={[cardStyles.binIcon, { color: colors.mutedForeground }]}>📍</Text>
            <Text style={[cardStyles.binText, { color: colors.mutedForeground, flex: 1 }]}>
              No bin assigned
            </Text>
          </View>
        )}

        {/* Dimensions badge */}
        {sizeUnknown ? (
          onMeasure ? (
            <Pressable
              onPress={(e) => { e.stopPropagation?.(); onMeasure(item); }}
              hitSlop={8}
              style={[cardStyles.dimBadge, { backgroundColor: colors.warning + "18", borderWidth: 1, borderColor: colors.warning + "88" }]}
            >
              <Text style={[cardStyles.dimIcon, { color: colors.warning }]}>📏</Text>
              <Text style={[cardStyles.dimText, { color: colors.warning }]}>Size not measured — tap to measure</Text>
            </Pressable>
          ) : (
            <View style={[cardStyles.dimBadge, { backgroundColor: colors.warning + "18", borderWidth: 1, borderColor: colors.warning + "44" }]}>
              <Text style={[cardStyles.dimIcon, { color: colors.warning }]}>📏</Text>
              <Text style={[cardStyles.dimText, { color: colors.warning }]}>Size not measured</Text>
            </View>
          )
        ) : (item as unknown as { dimensions?: PartDimensions | null }).dimensions &&
         Object.values((item as unknown as { dimensions: PartDimensions }).dimensions).some(v => v != null) ? (
          <View style={[cardStyles.dimBadge, { backgroundColor: colors.muted }]}>
            <Text style={[cardStyles.dimIcon, { color: colors.mutedForeground }]}>📐</Text>
            <Text style={[cardStyles.dimText, { color: colors.mutedForeground }]}>
              {(() => {
                const d = (item as unknown as { dimensions: PartDimensions }).dimensions;
                const parts: string[] = [];
                if (d.length != null && d.width != null && d.height != null) {
                  parts.push(`${d.length} × ${d.width} × ${d.height} mm`);
                } else if (d.length != null) {
                  parts.push(`L ${d.length} mm`);
                }
                if (d.diameter != null) parts.push(`⌀ ${d.diameter} mm`);
                return parts.join("   ");
              })()}
            </Text>
          </View>
        ) : null}

        {/* Expanded content */}
        {expanded ? (
          <>
            {/* Catalog image */}
            {item.imageUrl ? (
              <View style={cardStyles.section}>
                <Text style={[cardStyles.sectionTitle, { color: colors.mutedForeground }]}>
                  CATALOG IMAGE
                </Text>
                <RetryImage
                  uri={item.imageUrl}
                  style={[cardStyles.catalogImage, { backgroundColor: colors.muted }]}
                  resizeMode="contain"
                />
              </View>
            ) : null}

            {/* Barcodes section */}
            <View style={cardStyles.section}>
              <Text style={[cardStyles.sectionTitle, { color: colors.mutedForeground }]}>
                BARCODES
              </Text>
              {item.barcodes && item.barcodes.length > 0 ? (
                <View style={cardStyles.keywordRow}>
                  {item.barcodes.map((bc, i) => (
                    <View key={i} style={[cardStyles.keyword, { backgroundColor: colors.muted }]}>
                      <Text style={[cardStyles.keywordText, { color: colors.foreground, fontFamily: "Inter_500Medium" }]}>
                        {bc}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : (
                <Text style={[cardStyles.keywordText, { color: colors.mutedForeground, marginBottom: 6 }]}>
                  No barcodes assigned.
                </Text>
              )}
            </View>

            {/* Keywords section */}
            <View style={cardStyles.section}>
              <Text style={[cardStyles.sectionTitle, { color: colors.mutedForeground }]}>
                AI KEYWORDS
              </Text>
              {hasKeywords ? (
                <View style={cardStyles.keywordRow}>
                  {(item.aiKeywords ?? []).map((kw, i) => (
                    <View key={i} style={[cardStyles.keyword, { backgroundColor: colors.muted }]}>
                      <Text style={[cardStyles.keywordText, { color: colors.foreground }]}>
                        {kw}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : (
                <Text style={[cardStyles.keywordText, { color: colors.mutedForeground, marginBottom: 6 }]}>
                  No keywords yet.
                </Text>
              )}
            </View>

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
    boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 8,
  },
  headerLeft: { flexDirection: "row", alignItems: "flex-start", flex: 1 },
  headerRight: { marginLeft: 8, alignItems: "flex-end", gap: 6 },
  editItemBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    alignItems: "center",
  },
  editItemBtnText: { fontSize: 11, fontFamily: "Inter_500Medium" },
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
  binActionBtn: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    borderWidth: 1,
  },
  binActionText: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
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
  enrichedAt: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 8 },
  moreText: { fontSize: 12, fontFamily: "Inter_400Regular", alignSelf: "center", marginBottom: 6 },
  chevron: { textAlign: "center", fontSize: 12, marginTop: 8 },
  dimBadge: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginBottom: 8,
    gap: 4,
    alignSelf: "flex-start",
  },
  dimIcon: { fontSize: 12 },
  dimText: { fontSize: 12, fontFamily: "Inter_500Medium" },
  thumbnail: {
    width: 52,
    height: 52,
    borderRadius: 6,
    marginBottom: 6,
  },
  catalogImage: {
    width: "100%",
    height: 200,
    borderRadius: 8,
  },
});
