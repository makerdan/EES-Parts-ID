import { Feather } from "@expo/vector-icons";
import type { InventoryItem, SearchResult } from "@workspace/api-client-react";
import React, { useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { PartCard } from "@/components/PartCard";
import { PhotoLightbox } from "@/components/PhotoLightbox";
import { PinIcon } from "@/components/PinIcon";
import { RetryImage } from "@/components/RetryImage";
import { getSizeLabel, SizeVariantDropdown } from "@/components/SizeVariantDropdown";
import { useApp } from "@/contexts/AppContext";
import { useColors } from "@/hooks/useColors";

interface ResultCardProps {
  result: SearchResult;
  /** Admin-only: opens the full part details editor. */
  onEditItem?: ((item: InventoryItem) => void) | undefined;
  /** Navigate to warehouse map and open this part's zone. */
  onShowOnMap?: ((item: InventoryItem) => void) | undefined;
  /** Admin-only: opens the measurement screen for this unmeasured item. */
  onMeasure?: ((item: InventoryItem) => void) | undefined;
  /**
   * Called when the variants section is expanded or collapsed.
   * Only fires when the result has at least one variant.
   * Receives the full variants array and the new expanded state so the caller
   * can add / remove map location pins grouped by item.
   */
  onVariantsToggle?: ((item: InventoryItem, variants: Array<InventoryItem>, expanded: boolean) => void) | undefined;
  rank: number;
  fontScale?: number | undefined;
  /** When true, shows a "Size not measured" badge because no dimension data is stored for this item */
  sizeUnknown?: boolean | undefined;
  /** When true, the Part Details section auto-expands on mount (used for top Photo ID result). */
  autoExpandPartCard?: boolean | undefined;
  /**
   * Admin-only: called when the admin taps "Re-enrich keywords".
   * The callback receives the item and returns a promise that resolves to the
   * updated InventoryItem (or throws on failure).
   */
  onReenrichKeywords?: ((item: InventoryItem) => Promise<InventoryItem>) | undefined;
  /**
   * Called the first time the card is expanded (collapsed → expanded).
   * Used to record the part in the "Recently Viewed" history.
   */
  onOpen?: ((item: InventoryItem) => void) | undefined;
  /**
   * Called when the user switches to a different size variant via the dropdown.
   * Receives the base (primary) item and the newly selected variant so the
   * caller can update any existing map pin for this item.
   */
  onVariantSelect?: ((baseItem: InventoryItem, selectedVariant: InventoryItem) => void) | undefined;
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

export function ResultCard({ result, onEditItem, onShowOnMap, onMeasure, onVariantsToggle, rank, fontScale = 1.0, sizeUnknown = false, autoExpandPartCard = false, onReenrichKeywords, onOpen, onVariantSelect }: ResultCardProps) {
  "use no memo";
  const colors = useColors();
  const { showToast } = useApp();
  const [expanded, setExpanded] = useState(false);
  const [lightboxUris, setLightboxUris] = useState<Array<string>>([]);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [reenrichState, setReenrichState] = useState<"idle" | "loading" | "done" | "error">("idle");
  // F-059: mirror reenrichState in a ref so the failed state is not lost when
  // the parent re-renders and React re-reconciles the component instance.
  const reenrichStateRef = useRef<"idle" | "loading" | "done" | "error">("idle");
  const [localKeywords, setLocalKeywords] = useState<Array<string> | null>(null);
  const [localEnrichedAt, setLocalEnrichedAt] = useState<Date | string | null | undefined>(undefined);
  const [activeItem, setActiveItem] = useState<InventoryItem>(result.item);
  const { item, confidence, seriesLabel, variants } = result;
  const fs = (base: number) => Math.round(base * fontScale);

  const hasVariants = variants && variants.length > 0;
  const displayKeywords = localKeywords ?? activeItem.aiKeywords;
  const hasKeywords = displayKeywords && displayKeywords.length > 0;
  const displayEnrichedAt = localEnrichedAt !== undefined ? localEnrichedAt : activeItem.enrichedAt;
  const isViewingVariant = activeItem.id !== item.id;

  const handleReenrich = async () => {
    if (!onReenrichKeywords || reenrichStateRef.current === "loading") return;
    setReenrichState("loading");
    reenrichStateRef.current = "loading";
    try {
      const updated = await onReenrichKeywords(activeItem);
      setLocalKeywords(updated.aiKeywords ?? null);
      setLocalEnrichedAt(updated.enrichedAt ?? null);
      setReenrichState("done");
      reenrichStateRef.current = "done";
    } catch {
      setReenrichState("error");
      reenrichStateRef.current = "error";
      // F-059: fire a toast so the failure is visible even if the card scrolls
      // off screen; the ⟳ Re-enrich button on the card allows retrying.
      showToast("Re-enrich failed — tap ⟳ Re-enrich on the card to retry", "error");
    }
  };

  const handlePress = () => {
    const next = !expanded;
    setExpanded(next);
    if (hasVariants && onVariantsToggle) {
      onVariantsToggle(item, variants ?? [], next);
    }
    if (next && onOpen) {
      onOpen(item);
    }
  };

  return (
    <>
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
              {isViewingVariant ? (
                <Pressable
                  onPress={(e) => { e?.stopPropagation?.(); setActiveItem(item); setLocalKeywords(null); setLocalEnrichedAt(undefined); }}
                  hitSlop={8}
                  style={cardStyles.backBtn}
                  accessibilityLabel={`Back to ${item.catalog}`}
                  accessibilityRole="button"
                >
                  <Text style={[cardStyles.backBtnText, { color: colors.primary, fontSize: fs(11) }]}>
                    {`← ${item.catalog}`}
                  </Text>
                </Pressable>
              ) : null}
              <Text style={[cardStyles.vendor, { color: colors.mutedForeground, fontSize: fs(11) }]}>
                {activeItem.vendor}
              </Text>
              <Text style={[cardStyles.catalog, { color: colors.foreground, fontSize: fs(17) }]}>
                {activeItem.catalog}
              </Text>
              {isViewingVariant ? (
                <View style={[cardStyles.sizeBadge, { backgroundColor: colors.primary + "18", borderColor: colors.primary + "44" }]}>
                  <Text style={[cardStyles.sizeBadgeText, { color: colors.primary, fontSize: fs(11) }]}>
                    {getSizeLabel((activeItem as unknown as { size?: string | null }).size, activeItem.description)}
                  </Text>
                </View>
              ) : null}
            </View>
          </View>
          <View style={cardStyles.headerRight}>
            {(activeItem.thumbnailUrl ?? activeItem.imageUrl ?? activeItem.thumbnailUrl2 ?? activeItem.imageUrl2) ? (() => {
              const slot1 = activeItem.thumbnailUrl ?? activeItem.imageUrl ?? null;
              const slot2 = activeItem.thumbnailUrl2 ?? activeItem.imageUrl2 ?? null;
              const allUris = [
                ...(activeItem.imageUrl ?? activeItem.thumbnailUrl ? [(activeItem.imageUrl ?? activeItem.thumbnailUrl) as string] : []),
                ...(activeItem.imageUrl2 ?? activeItem.thumbnailUrl2 ? [(activeItem.imageUrl2 ?? activeItem.thumbnailUrl2) as string] : []),
              ];
              const isSmall = slot1 !== null && slot2 !== null;
              return (
                <View style={cardStyles.thumbnailRow}>
                  {slot1 ? (
                    <Pressable
                      onPress={(e) => { e?.stopPropagation?.(); setLightboxUris(allUris); setLightboxIndex(0); }}
                      hitSlop={4}
                      accessibilityLabel={`View photo 1 for ${activeItem.catalog}`}
                      accessibilityRole="button"
                    >
                      <RetryImage
                        uri={slot1}
                        style={isSmall ? cardStyles.thumbnailSmall : cardStyles.thumbnail}
                        resizeMode="cover"
                      />
                    </Pressable>
                  ) : null}
                  {slot2 ? (
                    <Pressable
                      onPress={(e) => { e?.stopPropagation?.(); setLightboxUris(allUris); setLightboxIndex(slot1 ? 1 : 0); }}
                      hitSlop={4}
                      accessibilityLabel={`View photo 2 for ${activeItem.catalog}`}
                      accessibilityRole="button"
                    >
                      <RetryImage
                        uri={slot2}
                        style={cardStyles.thumbnailSmall}
                        resizeMode="cover"
                      />
                    </Pressable>
                  ) : null}
                </View>
              );
            })() : (
              <View style={[cardStyles.thumbnail, cardStyles.thumbnailPlaceholder, { backgroundColor: colors.muted, borderColor: colors.border }]}>
                <Feather name="image" size={22} color={colors.mutedForeground} />
              </View>
            )}
            <ConfidenceBadge confidence={confidence} />
            {onEditItem ? (
              <Pressable
                onPress={(e) => { e?.stopPropagation?.(); onEditItem(activeItem); }}
                hitSlop={8}
                style={[cardStyles.editItemBtn, { backgroundColor: colors.muted, borderColor: colors.border }]}
                accessibilityLabel={`Edit ${activeItem.catalog}`}
                accessibilityRole="button"
              >
                <Text style={[cardStyles.editItemBtnText, { color: colors.primary }]}>✏️ Edit</Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        {/* Description */}
        {activeItem.description ? (
          <Text style={[cardStyles.description, { color: colors.foreground, fontSize: fs(13) }]} numberOfLines={expanded ? undefined : 2}>
            {activeItem.description}
          </Text>
        ) : activeItem.expandedDescription ? (
          <View style={cardStyles.descriptionBlock}>
            <Text style={[cardStyles.description, { color: colors.foreground, fontSize: fs(13) }]} numberOfLines={expanded ? undefined : 2}>
              {activeItem.expandedDescription}
            </Text>
          </View>
        ) : (
          <Text style={[cardStyles.description, { color: colors.foreground, fontSize: fs(13) }]} numberOfLines={expanded ? undefined : 2}>
            {"No description"}
          </Text>
        )}

        {/* Bin location(s) — read-only */}
        {activeItem.binLocations && activeItem.binLocations.length > 0 ? (
          <View style={[cardStyles.binRow, { backgroundColor: colors.accent }]}>
            <PinIcon fill="#f59e0b" stroke="#b45309" size={16} />
            <Text style={[cardStyles.binText, { color: colors.accentForeground, flex: 1 }]}>
              {activeItem.binLocations.length === 1 ? "Bin: " : "Bins: "}
              {activeItem.binLocations.join(", ")}
            </Text>
            {onShowOnMap ? (
              <Pressable
                onPress={(e) => { e?.stopPropagation?.(); onShowOnMap(activeItem); }}
                hitSlop={8}
                style={[cardStyles.binActionBtn, { borderColor: colors.accentForeground + "44" }]}
              >
                <Text style={[cardStyles.binActionText, { color: colors.accentForeground }]}>Map it!</Text>
              </Pressable>
            ) : null}
          </View>
        ) : (
          <View style={[cardStyles.binRow, { backgroundColor: colors.muted }]}>
            <PinIcon fill={colors.mutedForeground} stroke={colors.border} size={16} />
            <Text style={[cardStyles.binText, { color: colors.mutedForeground, flex: 1 }]}>
              No bin assigned
            </Text>
          </View>
        )}

        {/* Size variant dropdown — always visible on collapsed card when hasVariants */}
        {hasVariants && !expanded ? (
          <SizeVariantDropdown
            variants={variants ?? []}
            onSelect={(v) => { setActiveItem(v); setLocalKeywords(null); setLocalEnrichedAt(undefined); onVariantSelect?.(item, v); }}
            colors={colors}
            fontScale={fontScale}
          />
        ) : null}

        {/* Dimensions badge */}
        {sizeUnknown ? (
          onMeasure ? (
            <Pressable
              onPress={(e) => { e?.stopPropagation?.(); onMeasure(activeItem); }}
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
        ) : activeItem.dimensions &&
         Object.values(activeItem.dimensions).some(v => v != null) ? (
          <View style={[cardStyles.dimBadge, { backgroundColor: colors.muted }]}>
            <Text style={[cardStyles.dimIcon, { color: colors.mutedForeground }]}>📐</Text>
            <Text style={[cardStyles.dimText, { color: colors.mutedForeground }]}>
              {(() => {
                const d = activeItem.dimensions!;
                const parts: Array<string> = [];
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
            {/* Size variant dropdown inside expanded card */}
            {hasVariants ? (
              <SizeVariantDropdown
                variants={variants ?? []}
                onSelect={(v) => { setActiveItem(v); setLocalKeywords(null); setLocalEnrichedAt(undefined); onVariantSelect?.(item, v); }}
                colors={colors}
                fontScale={fontScale}
              />
            ) : null}

            {/* Catalog images */}
            {(activeItem.imageUrl || activeItem.imageUrl2) ? (
              <View style={cardStyles.section}>
                <Text style={[cardStyles.sectionTitle, { color: colors.mutedForeground }]}>
                  {activeItem.imageUrl && activeItem.imageUrl2 ? "CATALOG IMAGES" : "CATALOG IMAGE"}
                </Text>
                <View style={cardStyles.catalogImageRow}>
                  {activeItem.imageUrl ? (
                    <Pressable
                      style={[cardStyles.catalogImageWrap, { backgroundColor: colors.muted }, activeItem.imageUrl2 ? cardStyles.catalogImageWrapHalf : null]}
                      onPress={(e) => {
                        e?.stopPropagation?.();
                        const uris = [activeItem.imageUrl!, ...(activeItem.imageUrl2 ? [activeItem.imageUrl2] : [])];
                        setLightboxUris(uris);
                        setLightboxIndex(0);
                      }}
                    >
                      <RetryImage
                        uri={activeItem.imageUrl}
                        style={cardStyles.catalogImage}
                        resizeMode="contain"
                      />
                      {activeItem.imageUrl2 ? (
                        <Text style={[cardStyles.catalogImageLabel, { color: colors.mutedForeground }]}>Box / Label</Text>
                      ) : null}
                    </Pressable>
                  ) : null}
                  {activeItem.imageUrl2 ? (
                    <Pressable
                      style={[cardStyles.catalogImageWrap, { backgroundColor: colors.muted }, cardStyles.catalogImageWrapHalf]}
                      onPress={(e) => {
                        e?.stopPropagation?.();
                        const uris = [...(activeItem.imageUrl ? [activeItem.imageUrl] : []), activeItem.imageUrl2!];
                        setLightboxUris(uris);
                        setLightboxIndex(activeItem.imageUrl ? 1 : 0);
                      }}
                    >
                      <RetryImage
                        uri={activeItem.imageUrl2}
                        style={cardStyles.catalogImage}
                        resizeMode="contain"
                      />
                      <Text style={[cardStyles.catalogImageLabel, { color: colors.mutedForeground }]}>Detail / Wire Frame</Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>
            ) : null}

            {/* Barcodes section */}
            <View style={cardStyles.section}>
              <Text style={[cardStyles.sectionTitle, { color: colors.mutedForeground }]}>
                BARCODES
              </Text>
              {activeItem.barcodes && activeItem.barcodes.length > 0 ? (
                <View style={cardStyles.keywordRow}>
                  {activeItem.barcodes.map((bc, i) => (
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
              <View style={cardStyles.keywordSectionHeader}>
                <Text style={[cardStyles.sectionTitle, { color: colors.mutedForeground }]}>
                  AI KEYWORDS
                </Text>
                {onReenrichKeywords ? (
                  <Pressable
                    onPress={(e) => { e?.stopPropagation?.(); handleReenrich(); }}
                    hitSlop={8}
                    disabled={reenrichState === "loading"}
                    style={[cardStyles.reenrichBtn, { backgroundColor: colors.muted, borderColor: colors.border, opacity: reenrichState === "loading" ? 0.6 : 1 }]}
                    accessibilityLabel={`Re-enrich keywords for ${activeItem.catalog}`}
                    accessibilityRole="button"
                  >
                    {reenrichState === "loading" ? (
                      <ActivityIndicator size="small" color={colors.primary} style={{ width: 14, height: 14 }} />
                    ) : (
                      <Text style={[cardStyles.reenrichBtnText, { color: reenrichState === "error" ? "#ef4444" : colors.primary }]}>
                        {reenrichState === "done" ? "✓ Re-enriched" : reenrichState === "error" ? "⚠ Failed" : "⟳ Re-enrich"}
                      </Text>
                    )}
                  </Pressable>
                ) : null}
              </View>
              {hasKeywords ? (
                <View style={cardStyles.keywordRow}>
                  {(displayKeywords ?? []).map((kw, i) => (
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
                  {seriesLabel ?? "OTHER SIZES"} ({variants?.length ?? 0})
                </Text>
                <View style={cardStyles.variantRow}>
                  {(variants ?? []).slice(0, 12).map((v) => (
                    <VariantChip key={v.id} item={v} colors={colors} />
                  ))}
                  {(variants?.length ?? 0) > 12 ? (
                    <Text style={[cardStyles.moreText, { color: colors.mutedForeground }]}>
                      +{(variants?.length ?? 0) - 12} more
                    </Text>
                  ) : null}
                </View>
              </View>
            ) : null}

            {/* Last enriched */}
            {displayEnrichedAt ? (
              <Text style={[cardStyles.enrichedAt, { color: colors.mutedForeground }]}>
                AI enriched: {new Date(displayEnrichedAt).toLocaleDateString()}
              </Text>
            ) : (
              <Text style={[cardStyles.enrichedAt, { color: colors.mutedForeground }]}>
                Not AI enriched yet
              </Text>
            )}
          </>
        ) : null}

        {/* Part Details (web-sourced specs) */}
        <PartCard
          catalog={activeItem.catalog}
          vendor={activeItem.vendor ?? ""}
          description={activeItem.description ?? activeItem.expandedDescription ?? ""}
          autoExpand={autoExpandPartCard}
        />

        {/* Expand chevron */}
        <Text style={[cardStyles.chevron, { color: colors.mutedForeground }]}>
          {expanded ? "▲" : "▼"}
        </Text>
      </View>
    </Pressable>
    <PhotoLightbox uris={lightboxUris} initialIndex={lightboxIndex} onClose={() => setLightboxUris([])} />
    </>
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
  backBtn: {
    marginBottom: 2,
    alignSelf: "flex-start",
  },
  backBtnText: {
    fontFamily: "Inter_600SemiBold",
  },
  vendor: { fontSize: 11, fontFamily: "Inter_500Medium", textTransform: "uppercase", letterSpacing: 0.5 },
  catalog: { fontSize: 17, fontFamily: "Inter_700Bold", marginTop: 2 },
  sizeBadge: {
    alignSelf: "flex-start",
    marginTop: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 20,
    borderWidth: 1,
  },
  sizeBadgeText: {
    fontFamily: "Inter_600SemiBold",
  },
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
  descriptionBlock: { marginBottom: 8 },
  description: { fontSize: 13, fontFamily: "Inter_400Regular", lineHeight: 19, marginBottom: 2 },
  descriptionAbbrev: { fontSize: 11, fontFamily: "Inter_400Regular", lineHeight: 16, marginBottom: 6 },
  binRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 8,
    gap: 6,
  },
  binText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  binActionBtn: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    borderWidth: 1,
  },
  binActionText: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  section: { marginTop: 12 },
  keywordSectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 0,
  },
  reenrichBtn: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  reenrichBtnText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
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
  thumbnailRow: {
    flexDirection: "row",
    gap: 4,
    marginBottom: 6,
  },
  thumbnail: {
    width: 52,
    height: 52,
    borderRadius: 6,
  },
  thumbnailSmall: {
    width: 44,
    height: 44,
    borderRadius: 6,
  },
  thumbnailPlaceholder: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    marginBottom: 6,
  },
  catalogImageRow: {
    flexDirection: "row",
    gap: 8,
  },
  catalogImageWrap: {
    flex: 1,
    borderRadius: 8,
    overflow: "hidden",
  },
  catalogImageWrapHalf: {
    flex: 1,
  },
  catalogImage: {
    width: "100%",
    height: 160,
    borderRadius: 8,
  },
  catalogImageLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    textAlign: "center",
    marginTop: 4,
    marginBottom: 4,
  },
});
