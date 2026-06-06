/**
 * AisleSummarySheet — bottom-sheet modal shown when the user long-presses
 * a zone on the Warehouse Map. Provides a quick stat summary and a CTA to
 * launch BrowseByAisle for that zone.
 */
import React, { useMemo } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { InventoryItem } from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";
import { filterSections, parseBin, type WarehouseZone } from "@/lib/aisleHierarchy";

interface SummaryStats {
  skuCount: number;
  sectionCount: number;
  topCategories: string[];
}

function summarise(zone: WarehouseZone, inventory: InventoryItem[]): SummaryStats | null {
  const inZone = inventory.filter(item => {
    const bins = item.binLocations ?? [];
    return bins.some(raw => {
      const p = parseBin(raw);
      return p?.aisle === zone.aisleNum;
    });
  });

  if (inZone.length === 0) return null;

  const sectionSet = new Set<number>();
  for (const item of inZone) {
    for (const raw of item.binLocations ?? []) {
      const p = parseBin(raw);
      if (p?.aisle === zone.aisleNum) sectionSet.add(p.section);
    }
  }

  const filteredSecs = filterSections(
    Array.from(sectionSet).map(n => ({ sectionNum: n, label: `Section ${n}`, shelves: [], partCount: 0 })),
    zone.sectionNumbers,
  );

  const kwCounts: Record<string, number> = {};
  for (const item of inZone) {
    for (const kw of item.aiKeywords ?? []) {
      kwCounts[kw] = (kwCounts[kw] ?? 0) + 1;
    }
  }
  const topCategories = Object.entries(kwCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([kw]) => kw);

  return {
    skuCount: inZone.length,
    sectionCount: filteredSecs.length,
    topCategories,
  };
}

interface AisleSummarySheetProps {
  zone: WarehouseZone | null;
  inventory: InventoryItem[];
  onClose: () => void;
  onBrowse: (zone: WarehouseZone) => void;
}

export function AisleSummarySheet({ zone, inventory, onClose, onBrowse }: AisleSummarySheetProps) {
  const colors = useColors();

  const summary = useMemo(() => {
    if (!zone) return null;
    return summarise(zone, inventory);
  }, [zone, inventory]);

  if (!zone || !summary) return null;

  const sectionHint = zone.sectionNumbers && zone.sectionNumbers.length > 0
    ? `Section ${zone.sectionNumbers.join(", ")}`
    : null;

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={[sheetStyles.backdrop, { backgroundColor: colors.overlay }]} onPress={onClose} />
      <View style={[sheetStyles.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
        {/* Handle bar */}
        <View style={[sheetStyles.handle, { backgroundColor: colors.border }]} />

        <Text style={[sheetStyles.title, { color: colors.foreground }]}>{`Aisle ${zone.aisleNum}`}</Text>

        {sectionHint ? (
          <Text style={[sheetStyles.parityHint, { color: colors.mutedForeground }]}>{sectionHint}</Text>
        ) : null}

        {/* Stats row */}
        <View style={sheetStyles.statsRow}>
          <View style={[sheetStyles.statBox, { backgroundColor: colors.muted }]}>
            <Text style={[sheetStyles.statValue, { color: colors.primary }]}>{summary.skuCount}</Text>
            <Text style={[sheetStyles.statLabel, { color: colors.mutedForeground }]}>SKUs</Text>
          </View>
          <View style={[sheetStyles.statBox, { backgroundColor: colors.muted }]}>
            <Text style={[sheetStyles.statValue, { color: colors.primary }]}>{summary.sectionCount}</Text>
            <Text style={[sheetStyles.statLabel, { color: colors.mutedForeground }]}>Sections</Text>
          </View>
        </View>

        {/* Top categories */}
        {summary.topCategories.length > 0 ? (
          <View style={sheetStyles.tagsRow}>
            {summary.topCategories.map(cat => (
              <View key={cat} style={[sheetStyles.tag, { backgroundColor: colors.primary + "22" }]}>
                <Text style={[sheetStyles.tagText, { color: colors.primary }]}>{cat}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {/* CTA */}
        <Pressable
          onPress={() => { onBrowse(zone); onClose(); }}
          style={[sheetStyles.cta, { backgroundColor: colors.primary }]}
        >
          <Text style={[sheetStyles.ctaText, { color: colors.primaryForeground }]}>
            Browse this aisle
          </Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const sheetStyles = StyleSheet.create({
  backdrop: { flex: 1 },
  sheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    padding: 24,
    paddingTop: 12,
    paddingBottom: 40,
  },
  handle: { width: 36, height: 4, borderRadius: 2, alignSelf: "center", marginBottom: 16 },
  title: { fontSize: 20, fontFamily: "Inter_700Bold", marginBottom: 4 },
  parityHint: { fontSize: 13, fontFamily: "Inter_400Regular", marginBottom: 16 },
  statsRow: { flexDirection: "row", gap: 12, marginBottom: 16 },
  statBox: { flex: 1, alignItems: "center", padding: 12, borderRadius: 10 },
  statValue: { fontSize: 28, fontFamily: "Inter_700Bold" },
  statLabel: { fontSize: 12, fontFamily: "Inter_500Medium", marginTop: 2 },
  tagsRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 20 },
  tag: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6 },
  tagText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  cta: { borderRadius: 10, paddingVertical: 14, alignItems: "center" },
  ctaText: { fontSize: 16, fontFamily: "Inter_700Bold" },
});
