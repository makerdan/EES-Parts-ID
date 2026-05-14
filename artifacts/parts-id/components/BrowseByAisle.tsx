/**
 * BrowseByAisle — full-screen overlay for walking the warehouse digitally.
 *
 * Drill-down: Aisles → Sections → Parts (ShelfView or ResultCard list).
 * Works entirely from the locally cached inventory snapshot — no network needed.
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  BackHandler,
  FlatList,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  ActivityIndicator,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import type { InventoryItem } from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";
import { ResultCard } from "@/components/ResultCard";
import {
  buildAisleHierarchy,
  filterSections,
  type AisleNode,
  type AisleHierarchy,
  type SectionNode,
  type PartOnShelf,
  type ShelfNode,
} from "@/lib/aisleHierarchy";

export interface BrowseByAisleProps {
  inventory: InventoryItem[];
  isSyncing: boolean;
  shelfViewEnabled: boolean;
  fontScale?: number;
  onClose: () => void;
  onEditKeywords?: (item: InventoryItem) => void;
  onEditBins?: (item: InventoryItem) => void;
  initialAisle?: number;
  sectionParity?: "odd" | "even";
  sectionNumbers?: number[];
}

type CrumbState = {
  aisle: AisleNode | null;
  section: SectionNode | null;
};

// ── Swipe hooks ──────────────────────────────────────────────────────────────

function useSectionSwipe(
  onPrev: () => void,
  onNext: () => void,
  enabled = true,
) {
  const prevRef = useRef(onPrev);
  const nextRef = useRef(onNext);
  useEffect(() => { prevRef.current = onPrev; }, [onPrev]);
  useEffect(() => { nextRef.current = onNext; }, [onNext]);
  const threshold = Platform.OS === "ios" ? 75 : 60;
  return useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) =>
          enabled &&
          Math.abs(g.dx) > threshold &&
          Math.abs(g.dx) > Math.abs(g.dy) * 2,
        onPanResponderRelease: (_, g) => {
          if (g.dx < -threshold) nextRef.current();
          else if (g.dx > threshold) prevRef.current();
        },
      }),
    [enabled, threshold],
  );
}

function useCardItemSwipe(
  onPrev: () => void,
  onNext: () => void,
  enabled = true,
) {
  const prevRef = useRef(onPrev);
  const nextRef = useRef(onNext);
  useEffect(() => { prevRef.current = onPrev; }, [onPrev]);
  useEffect(() => { nextRef.current = onNext; }, [onNext]);
  const threshold = 40;
  return useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) =>
          enabled &&
          Platform.OS === "ios" &&
          Math.abs(g.dx) > threshold &&
          Math.abs(g.dx) > Math.abs(g.dy) * 2,
        onPanResponderRelease: (_, g) => {
          if (g.dx < -threshold) nextRef.current();
          else if (g.dx > threshold) prevRef.current();
        },
      }),
    [enabled, threshold],
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function BrowseHeader({
  title,
  subtitle,
  onBack,
  onHome,
  showHome,
  colors,
}: {
  title: string;
  subtitle?: string;
  onBack: () => void;
  onHome: () => void;
  showHome: boolean;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={[hdrStyles.row, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
      <Pressable onPress={onBack} hitSlop={10} style={hdrStyles.iconBtn}>
        <Feather name="arrow-left" size={22} color={colors.primary} />
      </Pressable>
      <View style={{ flex: 1, alignItems: "center" }}>
        <Text style={[hdrStyles.title, { color: colors.foreground }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[hdrStyles.sub, { color: colors.mutedForeground }]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {showHome ? (
        <Pressable onPress={onHome} hitSlop={10} style={hdrStyles.iconBtn}>
          <Feather name="home" size={20} color={colors.mutedForeground} />
        </Pressable>
      ) : (
        <View style={hdrStyles.iconBtn} />
      )}
    </View>
  );
}

const hdrStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    gap: 8,
  },
  iconBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  title: { fontSize: 16, fontFamily: "Inter_700Bold" },
  sub: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 1 },
});

function DrillRow({
  label,
  hint,
  count,
  onPress,
  colors,
}: {
  label: string;
  hint?: string;
  count: number;
  onPress: () => void;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        drillStyles.row,
        { backgroundColor: pressed ? colors.muted : colors.card, borderBottomColor: colors.border },
      ]}
    >
      <View style={{ flex: 1 }}>
        <Text style={[drillStyles.label, { color: colors.foreground }]}>{label}</Text>
        {hint ? (
          <Text style={[drillStyles.hint, { color: colors.mutedForeground }]}>{hint}</Text>
        ) : null}
      </View>
      <View style={[drillStyles.countBadge, { backgroundColor: colors.primary + "22" }]}>
        <Text style={[drillStyles.countText, { color: colors.primary }]}>{count}</Text>
      </View>
      <Feather name="chevron-right" size={18} color={colors.mutedForeground} style={{ marginLeft: 4 }} />
    </Pressable>
  );
}

const drillStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    gap: 10,
  },
  label: { fontSize: 15, fontFamily: "SpaceMono_400Regular", letterSpacing: 0.4 },
  hint: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  countBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  countText: { fontSize: 12, fontFamily: "Inter_700Bold" },
});

function SectionNavBar({
  onPrev,
  onNext,
  prevDisabled,
  nextDisabled,
  prevLabel,
  nextLabel,
  colors,
}: {
  onPrev: () => void;
  onNext: () => void;
  prevDisabled: boolean;
  nextDisabled: boolean;
  prevLabel: string;
  nextLabel: string;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={[navStyles.bar, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
      <Pressable
        onPress={onPrev}
        disabled={prevDisabled}
        style={[navStyles.btn, { opacity: prevDisabled ? 0.38 : 1 }]}
      >
        <Feather name="chevron-left" size={16} color={colors.primary} />
        <Text style={[navStyles.btnText, { color: colors.primary }]} numberOfLines={1}>
          {prevLabel}
        </Text>
      </Pressable>
      <View style={[navStyles.divider, { backgroundColor: colors.border }]} />
      <Pressable
        onPress={onNext}
        disabled={nextDisabled}
        style={[navStyles.btn, { opacity: nextDisabled ? 0.38 : 1, justifyContent: "flex-end" }]}
      >
        <Text style={[navStyles.btnText, { color: colors.primary }]} numberOfLines={1}>
          {nextLabel}
        </Text>
        <Feather name="chevron-right" size={16} color={colors.primary} />
      </Pressable>
    </View>
  );
}

const navStyles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    height: 44,
  },
  btn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    gap: 4,
    height: "100%",
  },
  btnText: { fontSize: 13, fontFamily: "Inter_600SemiBold", flexShrink: 1 },
  divider: { width: 1, height: 24 },
});

function BinSlot({
  part,
  selected,
  onPress,
  gapRight,
  colors,
}: {
  part: PartOnShelf;
  selected: boolean;
  onPress: () => void;
  gapRight: number;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[
        slotStyles.slot,
        {
          backgroundColor: selected ? colors.primary : colors.muted,
          borderColor: selected ? colors.primary : colors.border,
          marginRight: gapRight,
        },
      ]}
    >
      <Text style={[slotStyles.binCode, { color: selected ? colors.primaryForeground : colors.foreground }]}>
        {part.bin.raw}
      </Text>
      <Text
        style={[slotStyles.catalog, { color: selected ? colors.primaryForeground + "cc" : colors.mutedForeground }]}
        numberOfLines={1}
      >
        {part.item.catalog}
      </Text>
    </Pressable>
  );
}

const slotStyles = StyleSheet.create({
  slot: {
    width: 84,
    height: 76,
    borderRadius: 8,
    borderWidth: 1.5,
    padding: 6,
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  binCode: { fontSize: 10, fontFamily: "SpaceMono_400Regular", letterSpacing: 0.3 },
  catalog: { fontSize: 10, fontFamily: "Inter_500Medium" },
});

function ShelfRow({
  shelf,
  selectedKey,
  onSelectPart,
  colors,
}: {
  shelf: ShelfNode;
  selectedKey: string | null;
  onSelectPart: (part: PartOnShelf) => void;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View>
      <Text style={[shelfRowStyles.label, { color: colors.mutedForeground }]}>
        {shelf.label}
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={shelfRowStyles.row} contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 4, gap: 0 }}>
        {shelf.parts.map((part, idx) => {
          const nextPart = shelf.parts[idx + 1];
          const gap = nextPart
            ? Math.min(16, Math.max(4, (nextPart.bin.position - part.bin.position) * 2))
            : 12;
          return (
            <BinSlot
              key={`${part.item.id}-${part.bin.raw}`}
              part={part}
              selected={selectedKey === `${part.item.id}-${part.bin.raw}`}
              onPress={() => onSelectPart(part)}
              gapRight={gap}
              colors={colors}
            />
          );
        })}
      </ScrollView>
      <View style={[shelfRowStyles.plank, { backgroundColor: colors.steel + "55" }]} />
    </View>
  );
}

const shelfRowStyles = StyleSheet.create({
  label: { fontSize: 11, fontFamily: "Inter_600SemiBold", letterSpacing: 0.8, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 4 },
  row: { paddingVertical: 4 },
  plank: { height: 6, marginHorizontal: 12, borderRadius: 3, marginBottom: 4 },
});

function SectionShelfView({
  section,
  onPrev,
  onNext,
  prevDisabled,
  nextDisabled,
  prevLabel,
  nextLabel,
  fontScale,
  onEditKeywords,
  onEditBins,
  colors,
  cardItemPanHandlers,
  sectionPanHandlers,
}: {
  section: SectionNode;
  onPrev: () => void;
  onNext: () => void;
  prevDisabled: boolean;
  nextDisabled: boolean;
  prevLabel: string;
  nextLabel: string;
  fontScale: number;
  onEditKeywords?: (item: InventoryItem) => void;
  onEditBins?: (item: InventoryItem) => void;
  colors: ReturnType<typeof useColors>;
  cardItemPanHandlers: ReturnType<typeof PanResponder.create>["panHandlers"];
  sectionPanHandlers: ReturnType<typeof PanResponder.create>["panHandlers"];
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedPart, setSelectedPart] = useState<PartOnShelf | null>(null);

  const handleSelectPart = useCallback((part: PartOnShelf) => {
    const key = `${part.item.id}-${part.bin.raw}`;
    setSelectedKey(prev => {
      if (prev === key) {
        setSelectedPart(null);
        return null;
      }
      setSelectedPart(part);
      return key;
    });
  }, []);

  const breadcrumb = `${section.label} · ${selectedPart?.bin.raw ?? ""}`;

  const orderedShelves = useMemo(
    () => [...section.shelves].sort((a, b) => a.shelfHundreds - b.shelfHundreds),
    [section.shelves],
  );

  return (
    <View style={{ flex: 1 }} {...sectionPanHandlers}>
      <SectionNavBar
        onPrev={onPrev}
        onNext={onNext}
        prevDisabled={prevDisabled}
        nextDisabled={nextDisabled}
        prevLabel={prevLabel}
        nextLabel={nextLabel}
        colors={colors}
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 160 }}
        {...cardItemPanHandlers}
      >
        {orderedShelves.map(shelf => (
          <ShelfRow
            key={shelf.shelfHundreds}
            shelf={shelf}
            selectedKey={selectedKey}
            onSelectPart={handleSelectPart}
            colors={colors}
          />
        ))}
        {selectedPart ? (
          <View style={{ marginHorizontal: 12, marginTop: 12 }}>
            <ResultCard
              result={{
                item: selectedPart.item,
                confidence: 1,
                matchReason: breadcrumb,
                seriesLabel: undefined,
                variants: [],
              }}
              onEditKeywords={onEditKeywords}
              onEditBins={onEditBins}
              rank={0}
              fontScale={fontScale}
            />
          </View>
        ) : (
          <View style={{ alignItems: "center", padding: 24, marginTop: 8 }}>
            <Text style={{ color: colors.mutedForeground, fontFamily: "Inter_400Regular", fontSize: 13 }}>
              Tap a bin above to view part details
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function PartsListView({
  section,
  onPrev,
  onNext,
  prevDisabled,
  nextDisabled,
  prevLabel,
  nextLabel,
  fontScale,
  onEditKeywords,
  onEditBins,
  colors,
  sectionPanHandlers,
}: {
  section: SectionNode;
  onPrev: () => void;
  onNext: () => void;
  prevDisabled: boolean;
  nextDisabled: boolean;
  prevLabel: string;
  nextLabel: string;
  fontScale: number;
  onEditKeywords?: (item: InventoryItem) => void;
  onEditBins?: (item: InventoryItem) => void;
  colors: ReturnType<typeof useColors>;
  sectionPanHandlers: ReturnType<typeof PanResponder.create>["panHandlers"];
}) {
  const allParts = useMemo(() => {
    const seen = new Set<number>();
    const out: PartOnShelf[] = [];
    for (const shelf of section.shelves) {
      for (const p of shelf.parts) {
        if (!seen.has(p.item.id)) {
          seen.add(p.item.id);
          out.push(p);
        }
      }
    }
    return out;
  }, [section]);

  return (
    <View style={{ flex: 1 }} {...sectionPanHandlers}>
      <SectionNavBar
        onPrev={onPrev}
        onNext={onNext}
        prevDisabled={prevDisabled}
        nextDisabled={nextDisabled}
        prevLabel={prevLabel}
        nextLabel={nextLabel}
        colors={colors}
      />
      <FlatList
        data={allParts}
        keyExtractor={p => `${p.item.id}-${p.bin.raw}`}
        renderItem={({ item: part }) => (
          <View style={{ paddingHorizontal: 12, paddingTop: 8 }}>
            <ResultCard
              result={{
                item: part.item,
                confidence: 1,
                matchReason: `${section.label} · ${part.bin.raw}`,
                seriesLabel: undefined,
                variants: [],
              }}
              onEditKeywords={onEditKeywords}
              onEditBins={onEditBins}
              rank={0}
              fontScale={fontScale}
            />
          </View>
        )}
        contentContainerStyle={{ paddingBottom: 120 }}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function BrowseByAisle({
  inventory,
  isSyncing,
  shelfViewEnabled,
  fontScale = 1.0,
  onClose,
  onEditKeywords,
  onEditBins,
  initialAisle,
  sectionParity,
  sectionNumbers,
}: BrowseByAisleProps) {
  const colors = useColors();

  const hierarchy: AisleHierarchy = useMemo(
    () => buildAisleHierarchy(inventory),
    [inventory],
  );

  const [crumbs, setCrumbs] = useState<CrumbState>({ aisle: null, section: null });

  const level = crumbs.aisle === null ? "aisles" : crumbs.section === null ? "sections" : "parts";

  const filteredSections = useMemo(() => {
    if (!crumbs.aisle) return [];
    return filterSections(crumbs.aisle.sections, sectionNumbers, sectionParity);
  }, [crumbs.aisle, sectionNumbers, sectionParity]);

  const sectionsListRef = useRef<FlatList<SectionNode> | null>(null);
  const sectionsScrollOffset = useRef(0);

  const lastDrilledKey = useRef<string | null>(null);
  useEffect(() => {
    if (initialAisle == null) return;
    const key = `${initialAisle}-${sectionParity ?? ""}-${(sectionNumbers ?? []).join(",")}`;
    if (lastDrilledKey.current === key) return;
    lastDrilledKey.current = key;
    const aisleNode = hierarchy.aisles.find(a => a.aisleNum === initialAisle);
    if (!aisleNode) return;
    setCrumbs({ aisle: aisleNode, section: null });
  }, [initialAisle, sectionParity, sectionNumbers, hierarchy]);

  const goBack = useCallback(() => {
    setCrumbs(prev => {
      if (prev.section !== null) return { ...prev, section: null };
      if (prev.aisle !== null) return { aisle: null, section: null };
      return prev;
    });
  }, []);

  const goHome = useCallback(() => {
    setCrumbs({ aisle: null, section: null });
  }, []);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const handler = BackHandler.addEventListener("hardwareBackPress", () => {
      if (level === "aisles") return false;
      goBack();
      return true;
    });
    return () => handler.remove();
  }, [level, goBack]);

  const aisleIdx = crumbs.aisle
    ? hierarchy.aisles.findIndex(a => a.aisleNum === crumbs.aisle!.aisleNum)
    : -1;
  const sectionIdx = crumbs.section
    ? filteredSections.findIndex(s => s.sectionNum === crumbs.section!.sectionNum)
    : -1;

  const goToPrevAisle = useCallback(() => {
    if (aisleIdx <= 0) return;
    setCrumbs({ aisle: hierarchy.aisles[aisleIdx - 1]!, section: null });
  }, [aisleIdx, hierarchy.aisles]);

  const goToNextAisle = useCallback(() => {
    if (aisleIdx < 0 || aisleIdx >= hierarchy.aisles.length - 1) return;
    setCrumbs({ aisle: hierarchy.aisles[aisleIdx + 1]!, section: null });
  }, [aisleIdx, hierarchy.aisles]);

  const goToPrevSection = useCallback(() => {
    if (sectionIdx <= 0) return;
    setCrumbs(prev => ({ ...prev, section: filteredSections[sectionIdx - 1]! }));
  }, [sectionIdx, filteredSections]);

  const goToNextSection = useCallback(() => {
    if (sectionIdx < 0 || sectionIdx >= filteredSections.length - 1) return;
    setCrumbs(prev => ({ ...prev, section: filteredSections[sectionIdx + 1]! }));
  }, [sectionIdx, filteredSections]);

  const cardItemSwipe = useCardItemSwipe(
    level === "parts" ? goToPrevSection : goToPrevAisle,
    level === "parts" ? goToNextSection : goToNextAisle,
    level === "parts",
  );

  const sectionSwipe = useSectionSwipe(
    level === "sections" ? goToPrevAisle : goToPrevSection,
    level === "sections" ? goToNextAisle : goToNextSection,
    level !== "aisles",
  );

  const headerTitle =
    level === "aisles"
      ? "Browse Aisles"
      : level === "sections"
      ? crumbs.aisle!.label
      : `${crumbs.aisle!.label} · ${crumbs.section!.label}`;

  const headerSubtitle =
    level === "sections"
      ? `${filteredSections.length} section${filteredSections.length !== 1 ? "s" : ""}`
      : level === "parts"
      ? `${crumbs.section!.partCount} part${crumbs.section!.partCount !== 1 ? "s" : ""}`
      : undefined;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <BrowseHeader
        title={headerTitle}
        subtitle={headerSubtitle}
        onBack={level === "aisles" ? onClose : goBack}
        onHome={goHome}
        showHome={level !== "aisles"}
        colors={colors}
      />

      {/* ── Aisles level ── */}
      {level === "aisles" ? (
        <FlatList
          data={hierarchy.aisles}
          keyExtractor={a => String(a.aisleNum)}
          ListHeaderComponent={
            isSyncing ? (
              <View style={{ flexDirection: "row", alignItems: "center", padding: 12, gap: 8 }}>
                <ActivityIndicator size="small" color={colors.primary} />
                <Text style={{ color: colors.mutedForeground, fontFamily: "Inter_400Regular", fontSize: 12 }}>
                  Syncing inventory…
                </Text>
              </View>
            ) : hierarchy.aisles.length === 0 ? (
              <View style={{ padding: 32, alignItems: "center" }}>
                <Text style={{ color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center" }}>
                  No bin data available yet. Try syncing the inventory cache.
                </Text>
              </View>
            ) : null
          }
          ListFooterComponent={
            hierarchy.unsorted.parts.length > 0 ? (
              <View style={[footerStyles.unsortedRow, { borderTopColor: colors.border }]}>
                <View style={{ flex: 1 }}>
                  <Text style={[footerStyles.unsortedLabel, { color: colors.mutedForeground }]}>Unsorted</Text>
                  <Text style={[footerStyles.unsortedHint, { color: colors.mutedForeground }]}>
                    {hierarchy.unsorted.parts.length} part{hierarchy.unsorted.parts.length !== 1 ? "s" : ""} with missing or unrecognized bin codes
                  </Text>
                </View>
              </View>
            ) : null
          }
          renderItem={({ item: aisle }) => (
            <DrillRow
              label={aisle.label}
              count={aisle.partCount}
              hint={`${aisle.sections.length} section${aisle.sections.length !== 1 ? "s" : ""}`}
              onPress={() => setCrumbs({ aisle, section: null })}
              colors={colors}
            />
          )}
          contentContainerStyle={{ paddingBottom: 80 }}
          showsVerticalScrollIndicator={false}
        />
      ) : null}

      {/* ── Sections level ── */}
      {level === "sections" ? (
        <View style={{ flex: 1 }} {...sectionSwipe.panHandlers}>
          <SectionNavBar
            onPrev={goToPrevAisle}
            onNext={goToNextAisle}
            prevDisabled={aisleIdx <= 0}
            nextDisabled={aisleIdx >= hierarchy.aisles.length - 1}
            prevLabel={hierarchy.aisles[aisleIdx - 1]?.label ?? ""}
            nextLabel={hierarchy.aisles[aisleIdx + 1]?.label ?? ""}
            colors={colors}
          />
          <FlatList
            ref={sectionsListRef}
            data={filteredSections}
            keyExtractor={s => String(s.sectionNum)}
            onScroll={e => { sectionsScrollOffset.current = e.nativeEvent.contentOffset.y; }}
            scrollEventThrottle={16}
            onLayout={() => {
              if (sectionsScrollOffset.current > 0) {
                sectionsListRef.current?.scrollToOffset({
                  offset: sectionsScrollOffset.current,
                  animated: false,
                });
              }
            }}
            ListEmptyComponent={
              <View style={{ padding: 32, alignItems: "center" }}>
                <Text style={{ color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
                  No sections match the current filter.
                </Text>
              </View>
            }
            renderItem={({ item: section }) => (
              <DrillRow
                label={section.label}
                count={section.partCount}
                hint={`${section.shelves.length} shelf row${section.shelves.length !== 1 ? "s" : ""}`}
                onPress={() => {
                  sectionsScrollOffset.current = 0;
                  setCrumbs(prev => ({ ...prev, section }));
                }}
                colors={colors}
              />
            )}
            contentContainerStyle={{ paddingBottom: 80 }}
            showsVerticalScrollIndicator={false}
          />
        </View>
      ) : null}

      {/* ── Parts level ── */}
      {level === "parts" ? (
        shelfViewEnabled ? (
          <SectionShelfView
            section={crumbs.section!}
            onPrev={goToPrevSection}
            onNext={goToNextSection}
            prevDisabled={sectionIdx <= 0}
            nextDisabled={sectionIdx >= filteredSections.length - 1}
            prevLabel={filteredSections[sectionIdx - 1]?.label ?? ""}
            nextLabel={filteredSections[sectionIdx + 1]?.label ?? ""}
            fontScale={fontScale}
            onEditKeywords={onEditKeywords}
            onEditBins={onEditBins}
            colors={colors}
            cardItemPanHandlers={cardItemSwipe.panHandlers}
            sectionPanHandlers={sectionSwipe.panHandlers}
          />
        ) : (
          <PartsListView
            section={crumbs.section!}
            onPrev={goToPrevSection}
            onNext={goToNextSection}
            prevDisabled={sectionIdx <= 0}
            nextDisabled={sectionIdx >= filteredSections.length - 1}
            prevLabel={filteredSections[sectionIdx - 1]?.label ?? ""}
            nextLabel={filteredSections[sectionIdx + 1]?.label ?? ""}
            fontScale={fontScale}
            onEditKeywords={onEditKeywords}
            onEditBins={onEditBins}
            colors={colors}
            sectionPanHandlers={sectionSwipe.panHandlers}
          />
        )
      ) : null}
    </View>
  );
}

const footerStyles = StyleSheet.create({
  unsortedRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: 1,
    gap: 10,
  },
  unsortedLabel: { fontSize: 14, fontFamily: "Inter_500Medium" },
  unsortedHint: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
});
