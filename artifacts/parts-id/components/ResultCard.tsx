/**
 * Single result row used by Search, Browse, and Photo ID.
 *
 * Renders catalog/vendor/description, bin locations, and matched keyword
 * highlights. Accepts optional `highlightTokens` (which words to bold in
 * the description) and `highlightBin` (which bin code to mark with
 * "← here" — used by Browse-by-Aisle to point to the exact shelf).
 */
import React, { useCallback, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import type { InventoryItem, SearchResult } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { splitHighlightSegments } from '@/lib/refinement';
import { parseTradeSizeInches, formatInchesAsFraction } from '@/lib/tradeSize';

interface ResultCardProps {
  result: SearchResult;
  onEditKeywords?: (item: InventoryItem) => void;
  rank: number;
  /** When false, the rank badge (#1, #2, …) is not rendered. Defaults to true.
   *  Set to false in Browse by Aisle where ordering is by bin position, not relevance. */
  showRank?: boolean;
  fontScale?: number;
  /**
   * Lower-cased whole-word tokens to visually emphasize inside the card's
   * vendor / catalog / description / keyword text. Sourced from the active
   * refinement state (chips + extra keywords) by the parent screen, so
   * highlighting always reflects exactly what `applyRefinement` filtered on.
   * Pass [] (or omit) to disable highlighting.
   */
  highlightTokens?: string[];
  /** When set, the matching bin in the bin list is visually emphasized so
   *  the worker knows which physical bin matches the current Browse path. */
  highlightBin?: string;
  /**
   * Optional callback fired when the worker first expands this card (i.e.,
   * when the card transitions from collapsed → expanded). Used by the parent
   * search screen to record a "view" click event for search telemetry.
   * Never called on collapse, only on the first expand gesture.
   */
  onFirstExpand?: () => void;
  /**
   * Optional callback for explicit user confirmation that this card is the
   * correct part. When provided, a "That's it" button is rendered inside
   * the expanded view. Intended for Photo ID — fires POST /photo/confirm
   * once per deliberate tap, not on expand.
   */
  onConfirm?: () => void;
  /**
   * When true the card renders in expanded state from the moment it mounts.
   * Used by visual shelf views so the full detail (including "Edit Part Details")
   * is immediately visible after the worker taps a bin — no second tap required.
   */
  initiallyExpanded?: boolean;
  /**
   * When false the confidence percentage badge is not rendered. Defaults to true.
   * Set to false in visual shelf views where the confidence is always 1.0 and
   * the badge adds no information.
   */
  showConfidence?: boolean;
}

/**
 * Render `text` with a match-style applied to whole-word matches of any
 * `tokens`. Falls back to the bare string when no tokens or no matches so
 * we don't pay the StyleSheet/Array overhead in the common case.
 */
function HighlightedText({
  text,
  tokens,
  matchStyle,
}: {
  text: string;
  tokens: string[] | undefined;
  matchStyle: object;
}) {
  if (!text || !tokens || tokens.length === 0) return <>{text}</>;
  const segments = splitHighlightSegments(text, tokens);
  if (segments.length === 1 && !segments[0]!.match) return <>{text}</>;
  return (
    <>
      {segments.map((seg, i) =>
        seg.match ? (
          <Text key={i} style={matchStyle}>
            {seg.text}
          </Text>
        ) : (
          <Text key={i}>{seg.text}</Text>
        )
      )}
    </>
  );
}

const CONFIDENCE_COLORS = {
  high: '#10b981',
  medium: '#f59e0b',
  low: '#ef4444',
};

function getConfidenceLevel(confidence: number): 'high' | 'medium' | 'low' {
  if (confidence >= 0.85) return 'high';
  if (confidence >= 0.6) return 'medium';
  return 'low';
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const level = getConfidenceLevel(confidence);
  const color = CONFIDENCE_COLORS[level];
  const pct = Math.round(confidence * 100);
  return (
    <View style={[cardStyles.badge, { backgroundColor: color + '22' }]}>
      <View style={[cardStyles.badgeDot, { backgroundColor: color }]} />
      <Text style={[cardStyles.badgeText, { color }]}>{pct}%</Text>
    </View>
  );
}

/**
 * One row in the related-sizes dropdown list.
 *
 * Lays out three columns: catalog name on the left, parsed trade size in
 * the middle, and the part's primary bin (first entry of `binLocations`)
 * on the right. The size is derived client-side via `parseTradeSizeInches`
 * with a fallback to the catalog suffix relative to the parent so workers
 * can scan a series at a glance without reading the catalog code itself.
 * When the variant shares the parent's vendor we drop the vendor prefix
 * to keep the row tight, otherwise we show "VENDOR · CATALOG" so workers
 * can disambiguate. Parts with no bin show a muted "No bin" placeholder
 * so the right column still aligns vertically down the list.
 */
function VariantRow({
  item,
  parentVendor,
  parentCatalog,
  colors,
  fontScale,
  onPress,
}: {
  item: InventoryItem;
  parentVendor: string;
  parentCatalog: string;
  colors: ReturnType<typeof useColors>;
  fontScale: number;
  onPress: () => void;
}) {
  const fs = useCallback((base: number) => Math.round(base * fontScale), [fontScale]);
  const bins = item.binLocations ?? [];
  const primaryBin = bins[0];
  const sameVendor = item.vendor.toUpperCase() === parentVendor.toUpperCase();
  const label = sameVendor ? item.catalog : `${item.vendor} · ${item.catalog}`;

  // Size column: use the stored tradeSize first; fall back to parsing the
  // catalog code / description so parts without a manual trade size still
  // show a useful label.
  const sizeLabel: string = item.tradeSize
    ? item.tradeSize
    : formatInchesAsFraction(
        parseTradeSizeInches(item.catalog) ?? parseTradeSizeInches(item.description)
      );
  const hasSize = sizeLabel.length > 0;
  // Speech-friendly size: strip the inch-mark glyph and append "inches".
  const a11ySize = hasSize ? `, size ${sizeLabel.replace(/"/g, '')} inches` : '';
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: colors.muted }}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={`Open ${item.vendor} ${item.catalog}${a11ySize}${primaryBin ? `, bin ${primaryBin}` : ', no bin'}`}
      style={({ pressed }) => [
        varStyles.row,
        {
          borderBottomColor: colors.border,
          backgroundColor: pressed ? colors.accent : 'transparent',
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <Text
        style={[varStyles.catalog, { color: colors.foreground, fontSize: fs(13) }]}
        numberOfLines={1}
        allowFontScaling={false}
      >
        {label}
      </Text>
      {hasSize ? (
        <Text
          style={[varStyles.size, { color: colors.foreground, fontSize: fs(13) }]}
          numberOfLines={1}
          ellipsizeMode="tail"
          allowFontScaling={false}
        >
          {sizeLabel}
        </Text>
      ) : (
        <Text
          style={[varStyles.sizeEmpty, { color: colors.mutedForeground, fontSize: fs(13) }]}
          numberOfLines={1}
          allowFontScaling={false}
        >
          —
        </Text>
      )}
      {primaryBin ? (
        <Text
          style={[varStyles.bin, { color: colors.foreground, fontSize: fs(13) }]}
          numberOfLines={1}
          allowFontScaling={false}
        >
          {primaryBin}
        </Text>
      ) : (
        <Text
          style={[varStyles.binEmpty, { color: colors.mutedForeground, fontSize: fs(12) }]}
          numberOfLines={1}
          allowFontScaling={false}
        >
          No bin
        </Text>
      )}
    </Pressable>
  );
}

const varStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
    minHeight: 44,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  // Catalog and size both shrink under pressure so a long catalog won't
  // squeeze the bin off-screen and a long size suffix won't either. Bin
  // stays flex-fixed and right-aligned so workers always see it.
  catalog: { fontFamily: 'Inter_600SemiBold', flexShrink: 1, flexGrow: 1, flexBasis: 0 },
  size: { fontFamily: 'Inter_600SemiBold', textAlign: 'center', flexShrink: 1, maxWidth: 96 },
  sizeEmpty: { fontFamily: 'Inter_400Regular', textAlign: 'center', flexShrink: 0 },
  bin: { fontFamily: 'Inter_500Medium', textAlign: 'right', flexShrink: 0 },
  binEmpty: {
    fontFamily: 'Inter_400Regular',
    fontStyle: 'italic',
    textAlign: 'right',
    flexShrink: 0,
  },
});

export function ResultCard({
  result,
  onEditKeywords,
  rank,
  showRank = true,
  fontScale = 1.0,
  highlightTokens,
  highlightBin,
  onFirstExpand,
  onConfirm,
  initiallyExpanded = false,
  showConfidence = true,
}: ResultCardProps) {
  const colors = useColors();
  // Match style: a soft tint background + bold weight. Uses the theme's
  // primary color so it stays legible in light/dark mode.
  const hlStyle = React.useMemo(
    () => ({
      backgroundColor: colors.primary + '33',
      color: colors.foreground,
      fontFamily: 'Inter_700Bold' as const,
    }),
    [colors.primary, colors.foreground]
  );
  const hl = highlightTokens && highlightTokens.length > 0 ? highlightTokens : undefined;
  const [expanded, setExpanded] = useState(initiallyExpanded);
  // Related-sizes panel toggles independently of the main card expand/collapse
  // so workers can peek at alternate sizes without revealing the rest of the
  // card (keywords, enrichment date, etc.). When the card is collapsed by the
  // worker, we also collapse this panel so card state stays consistent.
  const [variantsExpanded, setVariantsExpanded] = useState(false);
  // Tapping a row in the related-sizes panel opens the variant in a modal
  // showing its full ResultCard. Using a Modal (rather than scrolling to an
  // existing list row) means this works identically across Search,
  // Browse-by-Aisle, and Photo ID even when the variant isn't already in
  // the visible result list.
  const [detailVariant, setDetailVariant] = useState<InventoryItem | null>(null);
  const { item, confidence, matchReason, seriesLabel, variants } = result;
  const fs = useCallback((base: number) => Math.round(base * fontScale), [fontScale]);

  // Exclude the current part from its own related-sizes list — a card
  // should never list itself as a "related" size. Server-side filtering
  // already drops result IDs from variant lists, but we belt-and-suspender
  // here in case a variant rolls into the current item via id collision.
  const filteredVariants = React.useMemo(() => {
    const list = (variants ?? []).filter((v) => v.id !== item.id);
    const sizeOf = (v: InventoryItem): number | null =>
      parseTradeSizeInches(v.tradeSize) ??
      parseTradeSizeInches(v.catalog) ??
      parseTradeSizeInches(v.description);
    return [...list].sort((a, b) => {
      const sa = sizeOf(a);
      const sb = sizeOf(b);
      if (sa === null && sb === null) return 0;
      if (sa === null) return 1; // unsized → end
      if (sb === null) return -1;
      return sa - sb;
    });
  }, [variants, item.id]);
  const hasVariants = filteredVariants.length > 0;
  const variantCount = filteredVariants.length;
  const hasKeywords = item.aiKeywords && item.aiKeywords.length > 0;

  const toggleCard = () => {
    const next = !expanded;
    setExpanded(next);
    // Collapsing the card closes the related-sizes panel too.
    if (!next) setVariantsExpanded(false);
    // Fire the telemetry callback only when the card first opens.
    if (next) onFirstExpand?.();
  };

  return (
    <>
      <Pressable
        onPress={toggleCard}
        accessibilityRole="button"
        accessibilityLabel={`${item.vendor} ${item.catalog} — tap to expand`}
      >
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
              {showRank ? (
                <View
                  style={[
                    cardStyles.rankBadge,
                    { backgroundColor: rank === 0 ? colors.primary : colors.muted },
                  ]}
                >
                  <Text
                    style={[
                      cardStyles.rankText,
                      { color: rank === 0 ? colors.primaryForeground : colors.mutedForeground },
                    ]}
                  >
                    #{rank + 1}
                  </Text>
                </View>
              ) : null}
              <View style={cardStyles.titleGroup}>
                <Text
                  style={[cardStyles.vendor, { color: colors.mutedForeground, fontSize: fs(11) }]}
                  allowFontScaling={false}
                >
                  <HighlightedText text={item.vendor} tokens={hl} matchStyle={hlStyle} />
                </Text>
                <Text
                  style={[cardStyles.catalog, { color: colors.foreground, fontSize: fs(28) }]}
                  allowFontScaling={false}
                >
                  <HighlightedText text={item.catalog} tokens={hl} matchStyle={hlStyle} />
                </Text>
                {item.seriesName ? (
                  <Pressable
                    onPress={() => {
                      if (hasVariants) setVariantsExpanded((v) => !v);
                    }}
                    hitSlop={4}
                    disabled={!hasVariants}
                    accessibilityRole={hasVariants ? 'button' : 'text'}
                    accessibilityLabel={`Part of series: ${item.seriesName}${hasVariants ? '. Tap to see other sizes.' : ''}`}
                    style={({ pressed }) => [
                      cardStyles.seriesBadge,
                      {
                        backgroundColor: colors.primary + '1A',
                        borderColor: colors.primary + '66',
                        opacity: pressed ? 0.7 : 1,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        cardStyles.seriesBadgeText,
                        { color: colors.primary, fontSize: fs(11) },
                      ]}
                      allowFontScaling={false}
                    >
                      {hasVariants ? '⊞ ' : ''}Part of {item.seriesName}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
            <View style={[cardStyles.headerRight, { alignItems: 'flex-end' }]}>
              {showConfidence !== false ? <ConfidenceBadge confidence={confidence} /> : null}
              {item.tradeSize ? (
                <Text style={[cardStyles.tradeSizeLabel, { color: colors.mutedForeground }]}>
                  {item.tradeSize}
                </Text>
              ) : null}
            </View>
          </View>

          {/* Description */}
          <Text
            style={[cardStyles.description, { color: colors.foreground, fontSize: fs(13) }]}
            numberOfLines={expanded ? undefined : 2}
            allowFontScaling={false}
          >
            {item.description ? (
              <HighlightedText text={item.description} tokens={hl} matchStyle={hlStyle} />
            ) : (
              'No description'
            )}
          </Text>

          {/* Bin location(s)
            ─────────────────
            • Collapsed view: comma-separated on one line (tight, scannable).
            • Expanded view: one bin per line (easy to read on a phone).
            • Empty list: row hidden entirely so single-bin parts look identical
              to before the multi-bin migration. */}
          {(item.binLocations ?? []).length > 0 ? (
            <View style={[cardStyles.binRow, { backgroundColor: colors.accent }]}>
              <Feather name="map-pin" size={14} color={colors.accentForeground} />
              <View style={cardStyles.binTextWrap}>
                <Text style={[cardStyles.binText, { color: colors.accentForeground }]}>
                  {(item.binLocations ?? []).length === 1 ? 'Bin: ' : 'Bins: '}
                  {(item.binLocations ?? []).map((b, i) => {
                    const isMatch =
                      !!highlightBin && b.toUpperCase() === highlightBin.toUpperCase();
                    const sep = i === 0 ? '' : expanded ? '\n      ' : ', ';
                    return (
                      <Text key={`${b}-${i}`}>
                        {sep}
                        <Text
                          style={
                            isMatch
                              ? { fontFamily: 'Inter_700Bold', textDecorationLine: 'underline' }
                              : undefined
                          }
                        >
                          {b}
                        </Text>
                      </Text>
                    );
                  })}
                </Text>
              </View>
            </View>
          ) : null}

          {/* Dedicated related-sizes control
            ────────────────────────────────
            Always visible (when the part has variants) so workers can find
            other sizes / amperages / lengths without expanding the whole card.
            Toggles a panel directly underneath; tapping the inner Pressable
            does NOT bubble to the outer card Pressable, so the rest of the
            card stays in its current state. */}
          {hasVariants ? (
            <Pressable
              onPress={() => setVariantsExpanded((v) => !v)}
              style={({ pressed }) => [
                cardStyles.variantsToggle,
                {
                  borderColor: colors.border,
                  backgroundColor: colors.muted,
                  opacity: pressed ? 0.7 : 1,
                },
              ]}
              accessibilityRole="button"
              accessibilityState={{ expanded: variantsExpanded }}
              accessibilityLabel={`${seriesLabel ?? 'Related sizes'}, ${variantCount} ${variantCount === 1 ? 'item' : 'items'}`}
            >
              <Text
                style={[
                  cardStyles.variantsToggleText,
                  { color: colors.foreground, fontSize: fs(12) },
                ]}
                allowFontScaling={false}
              >
                {seriesLabel ?? 'RELATED SIZES'} ({variantCount})
              </Text>
              <Text style={[cardStyles.variantsToggleChevron, { color: colors.mutedForeground }]}>
                {variantsExpanded ? '▲' : '▼'}
              </Text>
            </Pressable>
          ) : null}

          {/* Related-sizes panel (independent of card expand state) */}
          {hasVariants && variantsExpanded ? (
            <View
              style={[
                cardStyles.variantsPanel,
                { borderColor: colors.border, backgroundColor: colors.card },
              ]}
            >
              {filteredVariants.slice(0, 12).map((v) => (
                <VariantRow
                  key={v.id}
                  item={v}
                  parentVendor={item.vendor}
                  parentCatalog={item.catalog}
                  colors={colors}
                  fontScale={fontScale}
                  onPress={() => {
                    setVariantsExpanded(false);
                    setDetailVariant(v);
                  }}
                />
              ))}
              {filteredVariants.length > 12 ? (
                <Text style={[cardStyles.moreText, { color: colors.mutedForeground }]}>
                  +{filteredVariants.length - 12} more
                </Text>
              ) : null}
            </View>
          ) : null}

          {/* Expanded content */}
          {expanded ? (
            <>
              {/* Keywords — always shown when expanded; edit button always accessible */}
              <View style={cardStyles.section}>
                <Text style={[cardStyles.sectionTitle, { color: colors.mutedForeground }]}>
                  AI KEYWORDS
                </Text>
                {hasKeywords ? (
                  <View style={cardStyles.keywordRow}>
                    {(item.aiKeywords ?? []).map((kw, i) => {
                      // A keyword chip is "matched" when the whole keyword
                      // string would survive the same whole-word check used
                      // by applyRefinement — tint the chip background so the
                      // worker sees which AI tags drove the match.
                      const matched = hl
                        ? splitHighlightSegments(kw, hl).some((s) => s.match)
                        : false;
                      return (
                        <View
                          key={i}
                          style={[
                            cardStyles.keyword,
                            {
                              backgroundColor: matched ? colors.primary + '33' : colors.muted,
                              borderWidth: matched ? 1 : 0,
                              borderColor: matched ? colors.primary : 'transparent',
                            },
                          ]}
                        >
                          <Text
                            style={[
                              cardStyles.keywordText,
                              {
                                color: colors.foreground,
                                fontFamily: matched ? 'Inter_700Bold' : 'Inter_400Regular',
                              },
                            ]}
                          >
                            {kw}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                ) : (
                  <Text
                    style={[
                      cardStyles.keywordText,
                      { color: colors.mutedForeground, marginBottom: 6 },
                    ]}
                  >
                    No keywords yet — tap Edit to add some.
                  </Text>
                )}
                {onEditKeywords ? (
                  <Pressable
                    onPress={() => onEditKeywords(item)}
                    style={[cardStyles.editBtn, { borderColor: colors.border }]}
                  >
                    <Text style={[cardStyles.editBtnText, { color: colors.primary }]}>
                      ✏️ Edit Part Details
                    </Text>
                  </Pressable>
                ) : null}
                {onConfirm ? (
                  <Pressable
                    onPress={onConfirm}
                    style={[cardStyles.confirmBtn, { backgroundColor: '#10b981' }]}
                    accessibilityRole="button"
                    accessibilityLabel="Confirm this is the correct part"
                  >
                    <Text style={cardStyles.confirmBtnText}>✓ That's it</Text>
                  </Pressable>
                ) : null}
              </View>

              {/* Vendor full name — only shown when we have a vendor_map entry
                for this vendor code. Hidden entirely otherwise (no
                "Unknown vendor" placeholder). */}
              {item.vendorFullName ? (
                <Text style={[cardStyles.vendorFullName, { color: colors.mutedForeground }]}>
                  Vendor: {item.vendorFullName}
                </Text>
              ) : null}
            </>
          ) : null}

          {/* Expand chevron */}
          <Text style={[cardStyles.chevron, { color: colors.mutedForeground }]}>
            {expanded ? '▲' : '▼'}
          </Text>
        </View>
      </Pressable>
      {/* Variant detail modal — lives outside the outer card Pressable so the
        slide animation's touch-up event cannot leak into toggleCard. The
        inner ResultCard gets an empty variants array so we never recurse
        into a nested related-sizes panel. */}
      <Modal
        visible={detailVariant !== null}
        animationType="slide"
        transparent
        onRequestClose={() => setDetailVariant(null)}
      >
        <Pressable
          style={[cardStyles.detailOverlay, { backgroundColor: '#00000088' }]}
          onPress={() => setDetailVariant(null)}
          accessibilityRole="button"
          accessibilityLabel="Dismiss related size"
        >
          {/* Inner Pressable absorbs taps inside the sheet so they don't
              bubble to the backdrop dismiss handler. */}
          <Pressable
            onPress={() => undefined}
            style={[
              cardStyles.detailSheet,
              { backgroundColor: colors.background, borderColor: colors.border },
            ]}
          >
            <View style={[cardStyles.detailHeader, { borderColor: colors.border }]}>
              <Text style={[cardStyles.detailTitle, { color: colors.foreground }]}>
                Related Size
              </Text>
              <Pressable
                onPress={() => setDetailVariant(null)}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Close related size"
                style={({ pressed }) => [
                  cardStyles.detailClose,
                  { borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
                ]}
              >
                <Text style={[cardStyles.detailCloseText, { color: colors.foreground }]}>
                  ✕ Close
                </Text>
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={cardStyles.detailScroll}>
              {detailVariant ? (
                <ResultCard
                  result={{
                    item: detailVariant,
                    confidence: 1,
                    matchReason: `Related to ${item.vendor} ${item.catalog}`,
                    seriesLabel: undefined,
                    variants: [],
                  }}
                  rank={0}
                  fontScale={fontScale}
                  onEditKeywords={onEditKeywords}
                />
              ) : null}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const cardStyles = StyleSheet.create({
  container: {
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'flex-start', flex: 1 },
  headerRight: { marginLeft: 8 },
  rankBadge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
  rankText: { fontSize: 11, fontFamily: 'Inter_700Bold' },
  titleGroup: { flex: 1 },
  vendor: {
    fontSize: 11,
    fontFamily: 'Inter_500Medium',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  catalog: { fontSize: 17, fontFamily: 'Inter_700Bold', marginTop: 2 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    gap: 4,
  },
  badgeDot: { width: 6, height: 6, borderRadius: 3 },
  badgeText: { fontSize: 12, fontFamily: 'Inter_700Bold' },
  description: { fontSize: 13, fontFamily: 'Inter_400Regular', lineHeight: 19, marginBottom: 8 },
  binRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 8,
    gap: 6,
  },
  binTextWrap: { flex: 1 },
  binText: { fontSize: 13, fontFamily: 'Inter_600SemiBold', flexShrink: 1 },
  reason: { fontSize: 11, fontFamily: 'Inter_400Regular', fontStyle: 'italic', marginBottom: 4 },
  tradeSizeLabel: { fontSize: 22, fontFamily: 'Inter_700Bold', marginTop: 3 },
  section: { marginTop: 12 },
  sectionTitle: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  keywordRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  keyword: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4 },
  keywordText: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  variantsToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginTop: 8,
  },
  variantsToggleText: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.5,
    flexShrink: 1,
  },
  variantsToggleChevron: {
    fontSize: 11,
    marginLeft: 8,
  },
  variantsPanel: {
    marginTop: 8,
    borderWidth: 1,
    borderRadius: 6,
    overflow: 'hidden',
  },
  moreText: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    alignSelf: 'center',
    paddingVertical: 6,
  },
  editBtn: {
    marginTop: 10,
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
    alignSelf: 'flex-start',
  },
  editBtnText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  confirmBtn: {
    marginTop: 10,
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 16,
    alignSelf: 'flex-start',
  },
  confirmBtnText: { fontSize: 14, fontFamily: 'Inter_700Bold', color: '#ffffff' },
  vendorFullName: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 8 },
  seriesBadge: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginTop: 4,
  },
  seriesBadgeText: {
    fontSize: 11,
    fontFamily: 'Inter_500Medium',
  },
  chevron: { textAlign: 'center', fontSize: 12, marginTop: 8 },
  detailOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  detailSheet: {
    maxHeight: '92%',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    overflow: 'hidden',
  },
  detailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  detailTitle: {
    fontSize: 15,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.3,
  },
  detailClose: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 44,
    minWidth: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailCloseText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
  detailScroll: {
    padding: 14,
  },
});
