/**
 * Single result row used by Search, Browse, and Photo ID.
 *
 * Renders catalog/vendor/description, bin locations, and matched keyword
 * highlights. Accepts optional `highlightTokens` (which words to bold in
 * the description) and `highlightBin` (which bin code to mark with
 * "← here" — used by Browse-by-Aisle to point to the exact shelf).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  ActivityIndicator,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Feather } from '@expo/vector-icons';
import type { InventoryItem, SearchResult } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import rawColors from '@/constants/colors';
import { splitHighlightSegments } from '@/lib/refinement';
import { parseTradeSizeInches, formatInchesAsFraction, parseBreakerCatalog } from '@/lib/tradeSize';

interface ResultCardProps {
  result: SearchResult;
  /**
   * Called when the admin taps "Edit Part Details". An optional `onDone`
   * callback is passed as the second argument — the parent should call it
   * once the edit modal has visibly opened (or on close) so the button can
   * be re-enabled immediately. If the parent does not call `onDone`, the
   * button unlocks automatically after a 600 ms fallback.
   */
  onEditKeywords?: (item: InventoryItem, onDone?: () => void) => void;
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
  /**
   * Optional category slug from the active filter/browse context (e.g. "Breaker").
   * When provided, breaker detection is authoritative (category wins over catalog regex).
   * Falls back to catalog-regex detection when omitted.
   */
  categorySlug?: string;
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
 * One row in the related-sizes / other-ratings dropdown list.
 *
 * For conduit and fitting items (non-breaker): lays out three columns —
 * catalog on the left, parsed trade size in the middle, and the primary bin
 * on the right.
 *
 * For breaker items: the middle column shows the amp/pole rating
 * (`[N]A [P]-Pole`) derived from the variant's catalog number so workers
 * can scan a series at a glance without reading the full catalog code.
 */
function VariantRow({
  item,
  parentVendor,
  parentCatalog,
  isBreaker,
  colors,
  fontScale,
  onPress,
}: {
  item: InventoryItem;
  parentVendor: string;
  parentCatalog: string;
  isBreaker: boolean;
  colors: ReturnType<typeof useColors>;
  fontScale: number;
  onPress: () => void;
}) {
  const fs = useCallback((base: number) => Math.round(base * fontScale), [fontScale]);
  const bins = item.binLocations ?? [];
  const primaryBin = bins[0];
  const sameVendor = item.vendor.toUpperCase() === parentVendor.toUpperCase();
  const label = sameVendor ? item.catalog : `${item.vendor} · ${item.catalog}`;

  // Label column — for breakers: combined "BR120 — 20A 1-Pole" format so the
  // spec-required [Catalog] — [N]A [P]-Pole string appears as a single cell.
  // For conduit items: catalog in left column, trade size in middle column.
  let sizeLabel: string;
  let combinedBreakerLabel: string | null = null;
  if (isBreaker) {
    const bp = parseBreakerCatalog(item.catalog);
    const ratingStr = bp ? `${bp.amps}A ${bp.poles}-Pole` : '';
    if (ratingStr) {
      combinedBreakerLabel = `${label} — ${ratingStr}`;
    }
    sizeLabel = ''; // middle column not used for breakers
  } else {
    sizeLabel = item.tradeSize
      ? item.tradeSize
      : formatInchesAsFraction(
          parseTradeSizeInches(item.catalog) ?? parseTradeSizeInches(item.description)
        );
  }
  const hasSize = sizeLabel.length > 0;
  // Speech-friendly label: strip special chars.
  const a11ySuffix = combinedBreakerLabel
    ? `, ${combinedBreakerLabel.split(' — ')[1] ?? ''}`
    : hasSize
      ? `, size ${sizeLabel.replace(/"/g, '')} inches`
      : '';
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: colors.muted }}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={`Open ${item.vendor} ${item.catalog}${a11ySuffix}${primaryBin ? `, bin ${primaryBin}` : ', no bin'}`}
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
        {combinedBreakerLabel ?? label}
      </Text>
      {/* Breaker rows: combined label already contains the rating, so the
          middle size column is omitted. Conduit rows keep the size column. */}
      {!combinedBreakerLabel &&
        (hasSize ? (
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
        ))}
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
  catalog: {
    fontFamily: 'Inter_600SemiBold',
    flexShrink: 1,
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 80,
  },
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
  categorySlug,
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

  // ── Variant detail sheet: swipe-to-dismiss animated sheet ────────────────
  const { height: DETAIL_SCREEN_H } = useWindowDimensions();
  const detailScreenHRef = useRef(DETAIL_SCREEN_H);
  detailScreenHRef.current = DETAIL_SCREEN_H;
  const detailSheetY = useRef(new Animated.Value(DETAIL_SCREEN_H)).current;

  const startDetailOpenAnimation = useCallback(() => {
    detailSheetY.setValue(detailScreenHRef.current);
    Animated.spring(detailSheetY, {
      toValue: 0,
      tension: 60,
      friction: 12,
      useNativeDriver: true,
    }).start();
  }, [detailSheetY]);

  const dismissDetail = useCallback(() => {
    Animated.timing(detailSheetY, {
      toValue: detailScreenHRef.current,
      duration: 260,
      useNativeDriver: true,
    }).start(() => setDetailVariant(null));
  }, [detailSheetY]);

  const dismissDetailRef = useRef(dismissDetail);
  useEffect(() => {
    dismissDetailRef.current = dismissDetail;
  }, [dismissDetail]);

  const detailDragPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderMove: (_, gs) => {
        detailSheetY.setValue(Math.max(0, gs.dy));
      },
      onPanResponderRelease: (_, gs) => {
        if (gs.dy > 80 || gs.vy > 0.5) {
          dismissDetailRef.current();
        } else {
          Animated.spring(detailSheetY, {
            toValue: 0,
            tension: 60,
            friction: 12,
            useNativeDriver: true,
          }).start();
        }
      },
      onPanResponderTerminate: () => {
        Animated.spring(detailSheetY, {
          toValue: 0,
          tension: 60,
          friction: 12,
          useNativeDriver: true,
        }).start();
      },
    })
  ).current;

  // Edit-button loading state — disabled immediately on tap to prevent
  // double-opens; visual indicator appears only after a 100 ms debounce so
  // it is imperceptible on fast devices that open the modal instantly.
  const [editLocked, setEditLocked] = useState(false);
  const [editShowSpinner, setEditShowSpinner] = useState(false);
  const editTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    // Access the ref directly (not a captured snapshot) so the cleanup
    // always clears the live timer IDs, not the empty array at mount time.
    return () => {
      editTimersRef.current.forEach(clearTimeout);
    };
  }, []);

  const { item, confidence, matchReason, seriesLabel, variants } = result;

  // ── Breaker detection ─────────────────────────────────────────────────────
  // Primary signal: category slug passed down from the active filter/browse
  // context (e.g. filterValues.category === "Breaker"). When available this is
  // authoritative and we skip the catalog-regex fallback. The server also sends
  // amperage, poleCount, voltage, and mountType but those fields are not in the
  // generated InventoryItem type, so we access them via a cast.
  const breakerParse = parseBreakerCatalog(item.catalog);
  const isBreaker = categorySlug?.toLowerCase() === 'breaker' || breakerParse !== null;
  type BreakerExtras = { voltage?: number | null; mountType?: string | null };
  const bx = item as unknown as BreakerExtras;

  const handleEditPress = useCallback(() => {
    if (!onEditKeywords) return;

    // Clear any previous timers before scheduling new ones.
    editTimersRef.current.forEach(clearTimeout);
    editTimersRef.current = [];

    setEditLocked(true);

    // Show the visual indicator only after a 100 ms debounce — on fast
    // devices the modal appears before this fires and the spinner is never
    // visible to the user.
    const showTimer = setTimeout(() => setEditShowSpinner(true), 100);
    editTimersRef.current = [showTimer];

    // `done` is the lifecycle signal. The parent may call it when the modal
    // has opened (or closed). A 600 ms fallback fires automatically for
    // existing callers that don't use the second argument (e.g. setEditItem).
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      editTimersRef.current.forEach(clearTimeout);
      editTimersRef.current = [];
      setEditLocked(false);
      setEditShowSpinner(false);
    };

    onEditKeywords(item, done);

    const fallbackTimer = setTimeout(done, 600);
    editTimersRef.current = [...editTimersRef.current, fallbackTimer];
  }, [onEditKeywords, item]);
  const fs = useCallback((base: number) => Math.round(base * fontScale), [fontScale]);

  // Exclude the current part from its own related-sizes list — a card
  // should never list itself as a "related" size. Server-side filtering
  // already drops result IDs from variant lists, but we belt-and-suspender
  // here in case a variant rolls into the current item via id collision.
  const filteredVariants = React.useMemo(() => {
    const list = (variants ?? []).filter((v) => v.id !== item.id);
    if (isBreaker) {
      // Breaker variants sorted by amperage ascending; fall back to catalog alpha.
      return [...list].sort((a, b) => {
        const aa = parseBreakerCatalog(a.catalog)?.amps ?? Infinity;
        const ba = parseBreakerCatalog(b.catalog)?.amps ?? Infinity;
        if (aa !== ba) return aa - ba;
        return a.catalog.localeCompare(b.catalog);
      });
    }
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
  }, [variants, item.id, isBreaker]);
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
              {/* Breaker items: show labeled attribute chips instead of a trade-size label */}
              {isBreaker && breakerParse ? (
                <View style={cardStyles.breakerChipsRow}>
                  <View
                    style={[
                      cardStyles.breakerChip,
                      { backgroundColor: colors.muted, borderColor: colors.border },
                    ]}
                  >
                    <Text
                      style={[cardStyles.breakerChipLabel, { color: colors.mutedForeground }]}
                      allowFontScaling={false}
                    >
                      Amp Rating
                    </Text>
                    <Text
                      style={[cardStyles.breakerChipValue, { color: colors.foreground }]}
                      allowFontScaling={false}
                    >
                      {breakerParse.amps}A
                    </Text>
                  </View>
                  <View
                    style={[
                      cardStyles.breakerChip,
                      { backgroundColor: colors.muted, borderColor: colors.border },
                    ]}
                  >
                    <Text
                      style={[cardStyles.breakerChipLabel, { color: colors.mutedForeground }]}
                      allowFontScaling={false}
                    >
                      Poles
                    </Text>
                    <Text
                      style={[cardStyles.breakerChipValue, { color: colors.foreground }]}
                      allowFontScaling={false}
                    >
                      {breakerParse.poles}
                    </Text>
                  </View>
                  {bx.voltage ? (
                    <View
                      style={[
                        cardStyles.breakerChip,
                        { backgroundColor: colors.muted, borderColor: colors.border },
                      ]}
                    >
                      <Text
                        style={[cardStyles.breakerChipLabel, { color: colors.mutedForeground }]}
                        allowFontScaling={false}
                      >
                        Voltage
                      </Text>
                      <Text
                        style={[cardStyles.breakerChipValue, { color: colors.foreground }]}
                        allowFontScaling={false}
                      >
                        {bx.voltage}V
                      </Text>
                    </View>
                  ) : null}
                  {bx.mountType ? (
                    <View
                      style={[
                        cardStyles.breakerChip,
                        { backgroundColor: colors.muted, borderColor: colors.border },
                      ]}
                    >
                      <Text
                        style={[cardStyles.breakerChipLabel, { color: colors.mutedForeground }]}
                        allowFontScaling={false}
                      >
                        Mount Type
                      </Text>
                      <Text
                        style={[cardStyles.breakerChipValue, { color: colors.foreground }]}
                        allowFontScaling={false}
                      >
                        {bx.mountType.replace(/-/g, ' ')}
                      </Text>
                    </View>
                  ) : null}
                  <View
                    style={[
                      cardStyles.breakerChip,
                      { backgroundColor: colors.muted, borderColor: colors.border },
                    ]}
                  >
                    <Text
                      style={[cardStyles.breakerChipLabel, { color: colors.mutedForeground }]}
                      allowFontScaling={false}
                    >
                      Series
                    </Text>
                    <Text
                      style={[cardStyles.breakerChipValue, { color: colors.foreground }]}
                      allowFontScaling={false}
                    >
                      {breakerParse.series}
                    </Text>
                  </View>
                </View>
              ) : !isBreaker && item.tradeSize ? (
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

          {/* Dedicated related-sizes / other-ratings control
            ────────────────────────────────────────────────
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
              accessibilityLabel={`${isBreaker ? 'Other ratings' : (seriesLabel ?? 'Related sizes')}, ${variantCount} ${variantCount === 1 ? 'item' : 'items'}`}
            >
              <Text
                style={[
                  cardStyles.variantsToggleText,
                  { color: colors.foreground, fontSize: fs(12) },
                ]}
                allowFontScaling={false}
              >
                {isBreaker ? 'OTHER RATINGS' : (seriesLabel ?? 'RELATED SIZES')} ({variantCount})
              </Text>
              <Text style={[cardStyles.variantsToggleChevron, { color: colors.mutedForeground }]}>
                {variantsExpanded ? '▲' : '▼'}
              </Text>
            </Pressable>
          ) : null}

          {/* Related-sizes / other-ratings panel (independent of card expand state) */}
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
                  isBreaker={isBreaker}
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

          {/* Edit Part Details — always visible when admin prop is provided */}
          {onEditKeywords ? (
            <Pressable
              onPress={handleEditPress}
              disabled={editLocked}
              style={[
                cardStyles.editBtn,
                { borderColor: colors.border },
                editLocked && { opacity: 0.6 },
              ]}
            >
              <View style={cardStyles.editBtnContent}>
                {editShowSpinner ? (
                  <ActivityIndicator
                    size="small"
                    color={colors.primary}
                    style={cardStyles.editBtnSpinner}
                  />
                ) : null}
                <Text style={[cardStyles.editBtnText, { color: colors.primary }]}>
                  {editShowSpinner ? 'Opening…' : '✏️ Edit Part Details'}
                </Text>
              </View>
            </Pressable>
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
        into a nested related-sizes panel. Uses custom animated sheet with
        swipe-to-dismiss via the drag handle. */}
      <Modal
        visible={detailVariant !== null}
        animationType="none"
        transparent
        onShow={startDetailOpenAnimation}
        onRequestClose={dismissDetail}
      >
        <View style={[cardStyles.detailOverlay, { backgroundColor: '#00000088' }]}>
          {/* Backdrop tap dismisses the sheet */}
          <Pressable
            style={StyleSheet.absoluteFillObject}
            onPress={dismissDetail}
            accessibilityRole="button"
            accessibilityLabel="Dismiss related size"
          />
          <Animated.View
            style={[
              cardStyles.detailSheet,
              { backgroundColor: colors.background, borderColor: colors.border },
              { transform: [{ translateY: detailSheetY }] },
            ]}
          >
            {/* Drag handle */}
            <View
              {...detailDragPan.panHandlers}
              style={cardStyles.detailDragHandleArea}
              accessibilityRole="adjustable"
              accessibilityLabel="Drag down to close"
            >
              <View style={[cardStyles.detailDragPill, { backgroundColor: colors.border }]} />
            </View>
            <View style={[cardStyles.detailHeader, { borderColor: colors.border }]}>
              <Text style={[cardStyles.detailTitle, { color: colors.foreground }]}>
                {isBreaker ? 'Other Rating' : 'Related Size'}
              </Text>
              <Pressable
                onPress={() => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  dismissDetail();
                }}
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
          </Animated.View>
        </View>
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
  // ── Breaker attribute chips ───────────────────────────────────────────────
  breakerChipsRow: {
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: 4,
    marginTop: 3,
  },
  breakerChip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
    gap: 4,
  },
  breakerChipLabel: {
    fontSize: 9,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  breakerChipValue: {
    fontSize: 11,
    fontFamily: 'Inter_700Bold',
  },
  // ─────────────────────────────────────────────────────────────────────────
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
    paddingVertical: 10,
    paddingHorizontal: 12,
    minHeight: 44,
    alignSelf: 'flex-start',
    justifyContent: 'center',
  },
  editBtnContent: { flexDirection: 'row', alignItems: 'center' },
  editBtnSpinner: { marginRight: 6 },
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
    borderTopLeftRadius: rawColors.sheetRadius,
    borderTopRightRadius: rawColors.sheetRadius,
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
  detailDragHandleArea: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
  },
  detailDragPill: {
    width: 36,
    height: 4,
    borderRadius: 2,
    opacity: 0.5,
  },
  detailScroll: {
    padding: 14,
  },
});
