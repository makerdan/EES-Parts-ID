/**
 * Web-only interactive warehouse floor plan.
 *
 * Renders a zoomable, scrollable grid of aisle zones derived from live
 * inventory data. Tapping a zone fires onAislePress to open BrowseByAisle.
 * Uses only React Native primitives (works in-browser via react-native-web).
 */
import React, { useMemo, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { InventoryItem } from "@workspace/api-client-react";
import { buildAisleHierarchy } from "@/lib/aisleHierarchy";
import { useColors } from "@/hooks/useColors";

type Props = {
  inventory: InventoryItem[];
  onAislePress: (aisleNum: number) => void;
};

const COLS = 2;
const CELL_MIN = 80;
const CELL_MAX = 200;
const CELL_BASE = 120;

export function WarehouseMapWeb({ inventory, onAislePress }: Props) {
  const colors = useColors();
  const [cellSize, setCellSize] = useState(CELL_BASE);

  const { aisles } = useMemo(() => buildAisleHierarchy(inventory), [inventory]);

  const maxCount = Math.max(1, ...aisles.map(a => a.partCount));

  const rows: (typeof aisles)[] = [];
  for (let i = 0; i < aisles.length; i += COLS) {
    rows.push(aisles.slice(i, i + COLS));
  }

  const zoomIn = () => setCellSize(s => Math.min(s + 24, CELL_MAX));
  const zoomOut = () => setCellSize(s => Math.max(s - 24, CELL_MIN));

  function aisleColor(partCount: number): string {
    const t = partCount / maxCount;
    if (t > 0.66) return "#f59e0b";
    if (t > 0.33) return "#fbbf24";
    return "#fde68a";
  }

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
      <ScrollView
        contentContainerStyle={styles.canvas}
        showsVerticalScrollIndicator
        showsHorizontalScrollIndicator
      >
        {aisles.length === 0 ? (
          <View style={styles.empty}>
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              No inventory loaded yet.
            </Text>
            <Text style={[styles.emptyHint, { color: colors.mutedForeground }]}>
              Visit the Search tab to sync inventory, then return here.
            </Text>
          </View>
        ) : (
          <View style={styles.grid}>
            {/* Entrance marker */}
            <View style={[styles.walkway, { backgroundColor: colors.muted }]}>
              <Text style={[styles.walkwayText, { color: colors.mutedForeground }]}>
                ← ENTRANCE / SHIPPING
              </Text>
            </View>

            {rows.map((row, ri) => (
              <View key={ri} style={styles.rowWrap}>
                <View style={[styles.rowGutter, { backgroundColor: colors.muted }]}>
                  <Text style={[styles.rowGutterText, { color: colors.mutedForeground }]}>
                    {String(ri + 1).padStart(2, "0")}
                  </Text>
                </View>

                <View style={styles.rowCells}>
                  {row.map(aisle => (
                    <Pressable
                      key={aisle.aisleNum}
                      onPress={() => onAislePress(aisle.aisleNum)}
                      style={({ pressed }) => [
                        styles.cell,
                        {
                          width: cellSize,
                          height: cellSize,
                          backgroundColor: aisleColor(aisle.partCount),
                          borderColor: "#d97706",
                          opacity: pressed ? 0.7 : 1,
                        },
                      ]}
                    >
                      <Text style={styles.cellAisle}>
                        A{String(aisle.aisleNum).padStart(2, "0")}
                      </Text>
                      <Text style={styles.cellCount}>{aisle.partCount}</Text>
                      <Text style={styles.cellLabel}>parts</Text>
                    </Pressable>
                  ))}

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
            ))}

            {/* Receiving marker */}
            <View style={[styles.walkway, { backgroundColor: colors.muted }]}>
              <Text style={[styles.walkwayText, { color: colors.mutedForeground }]}>
                RECEIVING →
              </Text>
            </View>
          </View>
        )}
      </ScrollView>

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
