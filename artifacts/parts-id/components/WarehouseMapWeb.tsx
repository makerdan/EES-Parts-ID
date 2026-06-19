/**
 * Web-only interactive warehouse floor plan.
 *
 * Implements the Map tab's web experience as a custom floor-plan grid rather
 * than a geographic map library (e.g. Leaflet). Indoor warehouses have no GPS
 * coordinates, so a schematic aisle-grid is the appropriate representation.
 *
 * Features:
 * - Zoomable (+/− buttons adjust cell size from 80–200px)
 * - Scrollable canvas for warehouses with many aisles
 * - Each aisle zone colored by inventory density (amber scale)
 * - Section-level pin markers (colored circles) visible when zoomed ≥100px
 * - Tapping any aisle opens BrowseByAisle for that aisle
 *
 * Uses only React Native primitives — no extra packages required.
 * Only rendered when Platform.OS === "web" (see app/(tabs)/map.tsx).
 */
import type { InventoryItem } from "@workspace/api-client-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";

import { useColors } from "@/hooks/useColors";
import { buildAisleHierarchy } from "@/lib/aisleHierarchy";

type Props = {
  inventory: Array<InventoryItem>;
  onAislePress: (aisleNum: number) => void;
  focusAisleNum?: number | null;
  onFocusConsumed?: () => void;
  onFocusFailed?: () => void;
  /** Aisle numbers with primary pinned parts — shown with amber highlight. */
  pinnedAisleNums?: Set<number>;
  /** Aisle numbers with variant/related-size pinned parts — shown with purple highlight. */
  variantAisleNums?: Set<number>;
};

const COLS = 2;
const CELL_MIN = 80;
const CELL_MAX = 200;
const CELL_BASE = 120;

// Approximate y-offset of a grid row inside the ScrollView canvas.
// Layout breakdown (see styles):
//   canvas paddingTop = 20
//   entrance walkway height = 28, followed by grid gap = 6
//   each subsequent row occupies (cellSize + 6) px (gap between rows = 6)
function rowScrollY(rowIndex: number, cellSize: number): number {
  const CANVAS_PADDING_TOP = 20;
  const WALKWAY_HEIGHT = 28;
  const GAP = 6;
  return CANVAS_PADDING_TOP + WALKWAY_HEIGHT + GAP + rowIndex * (cellSize + GAP);
}

const HIGHLIGHT_DURATION_MS = 1800;

export function WarehouseMapWeb({
  inventory,
  onAislePress,
  focusAisleNum,
  onFocusConsumed,
  onFocusFailed,
  pinnedAisleNums,
  variantAisleNums,
}: Props) {
  "use no memo";
  const colors = useColors();
  const { height: windowHeight } = useWindowDimensions();
  const [cellSize, setCellSize] = useState(CELL_BASE);
  const scrollRef = useRef<FlatList<ReturnType<typeof buildAisleHierarchy>["aisles"]> | null>(null);
  const [highlightedAisle, setHighlightedAisle] = useState<number | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { aisles } = useMemo(() => buildAisleHierarchy(inventory), [inventory]);

  const maxCount = useMemo(
    () => Math.max(1, ...aisles.map(a => a.partCount)),
    [aisles],
  );

  useEffect(() => {
    if (focusAisleNum !== undefined && aisles.length > 0) {
      const idx = aisles.findIndex(a => a.aisleNum === focusAisleNum);
      if (idx !== -1) {
        const rowIdx = Math.floor(idx / COLS);
        const y = rowIdx * (cellSize + 6) + 60; // Approximate offset
        scrollRef.current?.scrollToOffset({ offset: y, animated: true });
        onFocusConsumed?.();
      } else {
        onFocusFailed?.();
      }
    }
  }, [focusAisleNum, aisles, cellSize, onFocusConsumed, onFocusFailed]);

  const rows = useMemo(() => {
    const result: Array<typeof aisles> = [];
    for (let i = 0; i < aisles.length; i += COLS) {
      result.push(aisles.slice(i, i + COLS));
    }
    return result;
  }, [aisles]);

  // Focus effect: scroll to the target aisle and briefly highlight it.
  //
  // The highlight timer is stored in highlightTimerRef so its lifetime is
  // independent of this effect's re-run cycle. Calling onFocusConsumed sets
  // focusAisleNum → null in the parent, which re-triggers this effect with a
  // null value (early return). If we cleared the timer in the effect cleanup,
  // that parent state update would cancel the timer before it fires and the
  // highlight would never disappear. Managing the timer via a ref decouples
  // the two lifecycles correctly.
  useEffect(() => {
    if (focusAisleNum == null) return;
    const aisleIndex = aisles.findIndex(a => a.aisleNum === focusAisleNum);
    if (aisleIndex === -1) {
      onFocusFailed?.();
      return;
    }
    const rowIndex = Math.floor(aisleIndex / COLS);
    const y = rowScrollY(rowIndex, cellSize);
    scrollRef.current?.scrollToOffset({ offset: y, animated: true });
    setHighlightedAisle(focusAisleNum);
    onFocusConsumed?.();
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => {
      setHighlightedAisle(null);
      highlightTimerRef.current = null;
    }, HIGHLIGHT_DURATION_MS);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusAisleNum]);

  // Clear the highlight timer on unmount to avoid a state update on an
  // unmounted component.
  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, []);

  const zoomIn = () => setCellSize(s => Math.min(s + 24, CELL_MAX));
  const zoomOut = () => setCellSize(s => Math.max(s - 24, CELL_MIN));

  const aisleColor = useCallback((partCount: number): string => {
    const t = partCount / maxCount;
    if (t > 0.66) return "#f59e0b";
    if (t > 0.33) return "#fbbf24";
    return "#fde68a";
  }, [maxCount]);

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/* Toolbar */}
      <View style={[styles.toolbar, { borderBottomColor: colors.border }]}>
        <Text style={[styles.toolbarTitle, { color: colors.foreground }]}>
          Warehouse Floor Plan
        </Text>
        <View style={styles.zoomRow}>
          <Text style={[styles.zoomLabel, { color: colors.mutedForeground }]}>
            Zoom
          </Text>
          <Pressable
            onPress={zoomOut}
            style={[styles.zoomBtn, { borderColor: colors.border, backgroundColor: colors.card }]}
          >
            <Text style={[styles.zoomBtnText, { color: colors.foreground }]}>−</Text>
          </Pressable>
          <Pressable
            onPress={zoomIn}
            style={[styles.zoomBtn, { borderColor: colors.border, backgroundColor: colors.card }]}
          >
            <Text style={[styles.zoomBtnText, { color: colors.foreground }]}>+</Text>
          </Pressable>
        </View>
      </View>

      {/* Map canvas */}
      <FlatList
        ref={scrollRef}
        data={rows}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={[styles.canvas, { paddingBottom: windowHeight / 2 }]}
        showsVerticalScrollIndicator
        showsHorizontalScrollIndicator
        getItemLayout={(_, index) => ({
          length: cellSize + 6,
          offset: 54 + index * (cellSize + 6),
          index,
        })}
        ItemSeparatorComponent={() => <View style={{ height: 6 }} />}
        ListHeaderComponent={
          aisles.length > 0 ? (
            <View style={[styles.walkway, { backgroundColor: colors.muted, marginBottom: 6 }]}>
              <Text style={[styles.walkwayText, { color: colors.mutedForeground }]}>
                ← ENTRANCE / SHIPPING
              </Text>
            </View>
          ) : null
        }
        ListFooterComponent={
          aisles.length > 0 ? (
            <View style={[styles.walkway, { backgroundColor: colors.muted, marginTop: 6 }]}>
              <Text style={[styles.walkwayText, { color: colors.mutedForeground }]}>
                RECEIVING →
              </Text>
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              No inventory loaded yet.
            </Text>
            <Text style={[styles.emptyHint, { color: colors.mutedForeground }]}>
              Visit the Search tab to sync inventory, then return here.
            </Text>
          </View>
        }
        renderItem={({ item: row, index: ri }) => (
          <View style={styles.rowWrap}>
            <View style={[styles.rowGutter, { backgroundColor: colors.muted }]}>
              <Text style={[styles.rowGutterText, { color: colors.mutedForeground }]}>
                {String(ri + 1).padStart(2, "0")}
              </Text>
            </View>

            <View style={styles.rowCells}>
              {row.map(aisle => {
                const showPins = cellSize >= 100;
                const maxSec = Math.max(1, ...aisle.sections.map(s => s.partCount));
                return (
                  <Pressable
                    key={aisle.aisleNum}
                    onPress={() => onAislePress(aisle.aisleNum)}
                    style={({ pressed }) => {
                      const isPinned = pinnedAisleNums?.has(aisle.aisleNum);
                      const isVariant = variantAisleNums?.has(aisle.aisleNum);
                      const isFocused = highlightedAisle === aisle.aisleNum;
                      const borderColor = isFocused
                        ? "#2563eb"
                        : isPinned
                        ? "#92400e"
                        : isVariant
                        ? "#8b5cf6"
                        : "#d97706";
                      const borderWidth = isFocused || isPinned || isVariant ? 3 : 2;
                      const backgroundColor = isPinned
                        ? "rgba(245, 158, 11, 0.28)"
                        : isVariant
                        ? "rgba(139, 92, 246, 0.28)"
                        : aisleColor(aisle.partCount);
                      return [
                        styles.cell,
                        {
                          width: cellSize,
                          height: cellSize,
                          backgroundColor,
                          borderColor,
                          borderWidth,
                          opacity: pressed ? 0.7 : 1,
                        },
                      ];
                    }}
                  >
                    <Text style={styles.cellAisle}>
                      A{String(aisle.aisleNum).padStart(2, "0")}
                    </Text>
                    <Text style={styles.cellCount}>{aisle.partCount}</Text>
                    <Text style={styles.cellLabel}>parts</Text>
                    {/* Section pins — visible when zoomed in */}
                    {showPins && aisle.sections.length > 0 && (
                      <View style={styles.pinsRow}>
                        {aisle.sections.slice(0, 8).map(sec => {
                          const density = sec.partCount / maxSec;
                          const pinColor = density > 0.66 ? "#92400e" : density > 0.33 ? "#b45309" : "#d97706";
                          return (
                            <View
                              key={sec.sectionNum}
                              style={[styles.pin, { backgroundColor: pinColor }]}
                            />
                          );
                        })}
                      </View>
                    )}
                  </Pressable>
                );
              })}

              {/* Pad last row if odd number of aisles */}
              {row.length < COLS && (
                <View
                  style={[
                    styles.cell,
                    {
                      width: cellSize,
                      height: cellSize,
                      backgroundColor: colors.muted,
                      borderColor: colors.border,
                    },
                  ]}
                />
              )}
            </View>

            <View style={[styles.rowGutter, { backgroundColor: colors.muted }]}>
              <Text style={[styles.rowGutterText, { color: colors.mutedForeground }]}>
                {String(ri + 1).padStart(2, "0")}
              </Text>
            </View>
          </View>
        )}
      />

      {/* Legend */}
      <View style={[styles.legend, { borderTopColor: colors.border, backgroundColor: colors.card }]}>
        <Text style={[styles.legendHint, { color: colors.mutedForeground }]}>
          Tap an aisle to browse its inventory
        </Text>
        <View style={styles.legendDots}>
          <View style={[styles.dot, { backgroundColor: "#fde68a" }]} />
          <Text style={[styles.dotLabel, { color: colors.mutedForeground }]}>Low</Text>
          <View style={[styles.dot, { backgroundColor: "#fbbf24" }]} />
          <Text style={[styles.dotLabel, { color: colors.mutedForeground }]}>Med</Text>
          <View style={[styles.dot, { backgroundColor: "#f59e0b" }]} />
          <Text style={[styles.dotLabel, { color: colors.mutedForeground }]}>High</Text>
          {variantAisleNums && variantAisleNums.size > 0 && (
            <>
              <View style={[styles.dot, { backgroundColor: "#a855f7" }]} />
              <Text style={[styles.dotLabel, { color: colors.mutedForeground }]}>Alt bin</Text>
            </>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  toolbarTitle: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  zoomRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  zoomLabel: { fontSize: 12, fontFamily: "Inter_400Regular", marginRight: 2 },
  zoomBtn: {
    width: 32,
    height: 32,
    borderRadius: 6,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  zoomBtnText: { fontSize: 18, lineHeight: 22, fontFamily: "Inter_700Bold" },
  canvas: { padding: 20, alignItems: "center" },
  grid: { gap: 6 },
  walkway: {
    height: 28,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  walkwayText: { fontSize: 11, fontFamily: "Inter_400Regular", letterSpacing: 1 },
  rowWrap: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowGutter: {
    width: 28,
    height: 28,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  rowGutterText: { fontSize: 10, fontFamily: "Inter_400Regular" },
  rowCells: { flexDirection: "row", gap: 6 },
  cell: {
    borderRadius: 8,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
    padding: 6,
  },
  cellAisle: { fontSize: 16, fontFamily: "Inter_700Bold", color: "#92400e" },
  cellCount: { fontSize: 20, fontFamily: "Inter_700Bold", color: "#78350f", marginTop: 2 },
  cellLabel: { fontSize: 10, fontFamily: "Inter_400Regular", color: "#78350f" },
  pinsRow: { flexDirection: "row", flexWrap: "wrap", gap: 3, marginTop: 6, justifyContent: "center" },
  pin: { width: 8, height: 8, borderRadius: 4 },
  empty: { paddingVertical: 80, alignItems: "center", gap: 12 },
  emptyText: { fontSize: 16, fontFamily: "Inter_600SemiBold" },
  emptyHint: { fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center" },
  legend: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderTopWidth: 1,
  },
  legendHint: { fontSize: 11, fontFamily: "Inter_400Regular" },
  legendDots: { flexDirection: "row", alignItems: "center", gap: 4 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  dotLabel: { fontSize: 10, fontFamily: "Inter_400Regular" },
});
