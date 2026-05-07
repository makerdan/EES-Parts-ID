/**
 * Aisle drill-down — Aisle → Section → Shelf → Parts.
 *
 * Read-only and offline-capable: the hierarchy is built on-device by
 * `lib/aisleHierarchy.ts` from the cached inventory's `binLocations`
 * arrays, so workers can keep walking the warehouse with no signal.
 * Closing the overlay returns them to their prior search/filter state.
 */
import React, { useMemo, useState } from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import type { InventoryItem, SearchResult } from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/contexts/AppContext";
import { ResultCard } from "@/components/ResultCard";
import {
  buildAisleHierarchy,
  type AisleNode,
  type SectionNode,
  type ShelfNode,
  type PartOnShelf,
} from "@/lib/aisleHierarchy";

interface Props {
  /** All inventory items currently cached locally (from the Search tab's
   *  Fuse cache). Hierarchy is derived purely on the client — no fresh API
   *  round-trip is issued per drill-down level. */
  inventory: InventoryItem[];
  /** Whether the local inventory cache has finished its first sync. Used to
   *  show an offline-with-empty-cache helpful empty state. */
  cacheReady: boolean;
  /** Returns the worker to the Search tab's main screen. */
  onClose: () => void;
  /** Per-card font scale (matches Search tab). */
  fontScale: number;
  /** Pass-through edit affordance so leaf cards behave the same as in Search. */
  onEditKeywords: (item: InventoryItem) => void;
  /** When true, the parts level shows a visual shelf diagram instead of a flat list. */
  shelfViewEnabled?: boolean;
}

type Level = "aisles" | "sections" | "shelves" | "parts";

interface CrumbState {
  aisle: AisleNode | null;
  section: SectionNode | null;
  shelf: ShelfNode | null;
}

export function BrowseByAisle({
  inventory,
  cacheReady,
  onClose,
  fontScale,
  onEditKeywords,
  shelfViewEnabled = false,
}: Props) {
  const colors = useColors();
  const { settings } = useApp();
  const warehouseShelfView = settings.warehouseShelfView;
  const [crumbs, setCrumbs] = useState<CrumbState>({
    aisle: null,
    section: null,
    shelf: null,
  });

  // Derived from the latest local inventory snapshot. Memoized because the
  // hierarchy build is O(N) and we don't want to re-walk on every keystroke
  // elsewhere in the screen.
  const hierarchy = useMemo(() => buildAisleHierarchy(inventory), [inventory]);

  const level: Level = crumbs.shelf
    ? "parts"
    : crumbs.section
    ? "shelves"
    : crumbs.aisle
    ? "sections"
    : "aisles";

  const goBack = () => {
    setCrumbs(c => {
      if (c.shelf) return { ...c, shelf: null };
      if (c.section) return { ...c, section: null };
      if (c.aisle) return { ...c, aisle: null };
      return c;
    });
  };

  const goHome = () => setCrumbs({ aisle: null, section: null, shelf: null });

  // Empty-state: the local cache is empty (offline first-run case).
  if (inventory.length === 0) {
    return (
      <View style={styles.wrapper}>
        <Header
          colors={colors}
          crumbs={crumbs}
          onClose={onClose}
          onBack={goBack}
          onHome={goHome}
        />
        <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
            {cacheReady ? "No inventory loaded" : "Inventory not synced yet"}
          </Text>
          <Text style={[styles.emptyHint, { color: colors.mutedForeground }]}>
            {cacheReady
              ? "There are no parts to browse."
              : "Browse by Aisle works offline once the inventory has been synced once. Connect to the network and wait for the sync badge in the header to finish."}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.wrapper}>
      <Header
        colors={colors}
        crumbs={crumbs}
        onClose={onClose}
        onBack={goBack}
        onHome={goHome}
      />

      {level === "aisles" ? (
        <FlatList
          data={hierarchy.aisles}
          keyExtractor={a => a.aisle}
          renderItem={({ item }) => (
            <DrillRow
              colors={colors}
              label={item.label}
              count={item.partCount}
              onPress={() => setCrumbs({ aisle: item, section: null, shelf: null })}
            />
          )}
          ListFooterComponent={hierarchy.unsorted ? (
            <DrillRow
              colors={colors}
              label="Unsorted"
              count={hierarchy.unsorted.partCount}
              hint="bins that don't match the AA-SS-SHP pattern"
              onPress={() => {
                // Synthetic aisle/section/shelf so the parts level can render
                // the unsorted list using the same path as a regular shelf.
                const fakeShelf: ShelfNode = {
                  shelfHundreds: -1,
                  label: "Unsorted",
                  partCount: hierarchy.unsorted!.partCount,
                  parts: hierarchy.unsorted!.parts.map(item => ({
                    item,
                    bin: (item.binLocations ?? [])[0] ?? "",
                    position: 0,
                  })),
                };
                const fakeSection: SectionNode = {
                  section: "—",
                  label: "Unsorted",
                  partCount: hierarchy.unsorted!.partCount,
                  shelves: [fakeShelf],
                };
                const fakeAisle: AisleNode = {
                  aisle: "—",
                  label: "Unsorted",
                  partCount: hierarchy.unsorted!.partCount,
                  sections: [fakeSection],
                };
                setCrumbs({ aisle: fakeAisle, section: fakeSection, shelf: fakeShelf });
              }}
            />
          ) : null}
          contentContainerStyle={styles.listContent}
        />
      ) : null}

      {level === "sections" && crumbs.aisle ? (
        <FlatList
          data={crumbs.aisle.sections}
          keyExtractor={s => s.section}
          renderItem={({ item }) => (
            <DrillRow
              colors={colors}
              label={item.label}
              count={item.partCount}
              onPress={() => setCrumbs(c => ({ ...c, section: item, shelf: null }))}
            />
          )}
          contentContainerStyle={styles.listContent}
        />
      ) : null}

      {level === "shelves" && crumbs.section ? (
        warehouseShelfView ? (
          <SectionShelfView
            section={crumbs.section}
            crumbs={crumbs}
            colors={colors}
            fontScale={fontScale}
            onEditKeywords={onEditKeywords}
          />
        ) : (
          <FlatList
            data={crumbs.section.shelves}
            keyExtractor={s => String(s.shelfHundreds)}
            renderItem={({ item }) => (
              <DrillRow
                colors={colors}
                label={item.label}
                count={item.partCount}
                onPress={() => setCrumbs(c => ({ ...c, shelf: item }))}
              />
            )}
            contentContainerStyle={styles.listContent}
          />
        )
      ) : null}

      {level === "parts" && crumbs.shelf ? (
        shelfViewEnabled ? (
          <ShelfView
            parts={crumbs.shelf.parts}
            crumbs={crumbs}
            colors={colors}
            fontScale={fontScale}
            onEditKeywords={onEditKeywords}
          />
        ) : (
          <FlatList
            data={crumbs.shelf.parts}
            keyExtractor={(p, i) => `${p.item.id}-${p.bin}-${i}`}
            renderItem={({ item, index }) => {
              const result: SearchResult = {
                item: item.item,
                confidence: 1,
                matchReason: `On ${crumbs.aisle?.label ?? ""} › ${crumbs.section?.label ?? ""} › ${crumbs.shelf?.label ?? ""}`,
                seriesLabel: undefined,
                variants: [],
              };
              return (
                <View style={styles.partRow}>
                  <ResultCard
                    result={result}
                    rank={index}
                    showRank={false}
                    fontScale={fontScale}
                    onEditKeywords={onEditKeywords}
                    highlightBin={item.bin}
                  />
                </View>
              );
            }}
            contentContainerStyle={styles.listContent}
          />
        )
      ) : null}
    </View>
  );
}

// ── Visual shelf view ─────────────────────────────────────────────────────────

const BIN_SLOT_W = 84;
const BIN_SLOT_H = 76;
const GAP_BASE   = 8;   // minimum px gap between slots
const GAP_PER_POS = 7;  // additional px per position unit of separation

function ShelfView({
  parts,
  crumbs,
  colors,
  fontScale,
  onEditKeywords,
}: {
  parts: PartOnShelf[];
  crumbs: CrumbState;
  colors: ReturnType<typeof useColors>;
  fontScale: number;
  onEditKeywords: (item: InventoryItem) => void;
}) {
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const selectedPart = selectedIdx !== null ? (parts[selectedIdx] ?? null) : null;

  const locationLabel = [
    crumbs.aisle?.label,
    crumbs.section?.label,
    crumbs.shelf?.label,
  ].filter(Boolean).join(" › ");

  return (
    <View style={{ flex: 1 }}>
      {/* ── Shelf diagram ── */}
      <View style={shelfStyles.diagramWrap}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={shelfStyles.diagramScroll}
        >
          <View style={shelfStyles.slotsRow}>
            {parts.map((p, i) => {
              const prevPos = i === 0 ? p.position : parts[i - 1]!.position;
              const gap = i === 0 ? 0 : GAP_BASE + Math.max(0, (p.position - prevPos - 1) * GAP_PER_POS);
              const isSelected = selectedIdx === i;
              return (
                <React.Fragment key={`${p.bin}-${i}`}>
                  {gap > 0 ? <View style={{ width: gap }} /> : null}
                  <Pressable
                    onPress={() => setSelectedIdx(isSelected ? null : i)}
                    style={[
                      shelfStyles.slot,
                      {
                        backgroundColor: isSelected ? colors.primary : colors.card,
                        borderColor: isSelected ? colors.primary : colors.border,
                      },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={`Bin ${p.bin}: ${p.item.catalog ?? p.item.description ?? "part"}`}
                  >
                    <Text style={[shelfStyles.slotPos, { color: "#000000" }]}>
                      {p.bin.split("-").pop() ?? p.bin}
                    </Text>
                    <Text
                      numberOfLines={1}
                      style={[shelfStyles.slotName, { color: isSelected ? colors.primaryForeground : colors.foreground }]}
                    >
                      {p.item.catalog ?? p.item.description ?? "—"}
                    </Text>
                    {p.item.vendor ? (
                      <Text
                        numberOfLines={1}
                        style={[shelfStyles.slotVendor, { color: isSelected ? colors.primaryForeground + "aa" : colors.mutedForeground }]}
                      >
                        {p.item.vendor}
                      </Text>
                    ) : null}
                  </Pressable>
                </React.Fragment>
              );
            })}
          </View>
          {/* Physical shelf rail */}
          <View style={[shelfStyles.rail, { backgroundColor: colors.muted, borderColor: colors.border }]} />
        </ScrollView>
        <Text style={[shelfStyles.locationLabel, { color: colors.mutedForeground }]}>
          {`${locationLabel} · ${parts.length} ${parts.length === 1 ? "part" : "parts"}`}
        </Text>
      </View>

      {/* ── Part detail ── */}
      {selectedPart ? (
        <FlatList
          data={[selectedPart]}
          keyExtractor={p => `${p.bin}-detail`}
          renderItem={({ item: p }) => {
            const result: SearchResult = {
              item: p.item,
              confidence: 1,
              matchReason: locationLabel,
              seriesLabel: undefined,
              variants: [],
            };
            return (
              <View style={{ paddingHorizontal: 12, paddingTop: 8 }}>
                <ResultCard
                  result={result}
                  rank={0}
                  showRank={false}
                  fontScale={fontScale}
                  onEditKeywords={onEditKeywords}
                  highlightBin={p.bin}
                />
              </View>
            );
          }}
          contentContainerStyle={{ paddingBottom: 140 }}
        />
      ) : (
        <View style={shelfStyles.hint}>
          <Feather name="mouse-pointer" size={20} color={colors.mutedForeground} style={{ marginBottom: 8 }} />
          <Text style={[shelfStyles.hintText, { color: colors.mutedForeground }]}>
            Tap a bin above to see part details
          </Text>
        </View>
      )}
    </View>
  );
}

const shelfStyles = StyleSheet.create({
  diagramWrap:   { flexGrow: 0 },
  diagramScroll: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 0, alignItems: "flex-end" },
  slotsRow:      { flexDirection: "row", alignItems: "flex-end" },
  slot: {
    width: BIN_SLOT_W,
    height: BIN_SLOT_H,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: "flex-end",
  },
  slotPos:    { fontSize: 15, fontFamily: "Inter_500Medium", marginBottom: 3, textAlign: "center", textDecorationLine: "underline" },
  slotName:   { fontSize: 11, fontFamily: "Inter_600SemiBold", lineHeight: 14 },
  slotVendor: { fontSize: 9,  fontFamily: "Inter_400Regular", marginTop: 2 },
  rail: {
    height: 8,
    borderRadius: 4,
    borderWidth: 1,
    marginTop: 4,
  },
  locationLabel: { fontSize: 11, fontFamily: "Inter_400Regular", paddingHorizontal: 16, paddingTop: 5, paddingBottom: 2 },
  hint:     { flex: 1, alignItems: "center", justifyContent: "center" },
  hintText: { fontSize: 13, fontFamily: "Inter_400Regular" },
});

// ── Section-wide shelf view (all shelves in a section stacked) ────────────────

function SectionShelfView({
  section,
  crumbs,
  colors,
  fontScale,
  onEditKeywords,
}: {
  section: SectionNode;
  crumbs: CrumbState;
  colors: ReturnType<typeof useColors>;
  fontScale: number;
  onEditKeywords: (item: InventoryItem) => void;
}) {
  const [selected, setSelected] = useState<{ shelfIdx: number; partIdx: number } | null>(null);

  // Render lowest hundreds at top, highest (e.g. 900) at bottom — mirrors
  // a physical shelf stack viewed straight-on from the front.
  const shelves = [...section.shelves].reverse();

  const selectedPart =
    selected !== null
      ? (shelves[selected.shelfIdx]?.parts[selected.partIdx] ?? null)
      : null;

  const locationLabel = [crumbs.aisle?.label, section.label].filter(Boolean).join(" › ");

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 140 }}>
      {shelves.map((shelf, shelfIdx) => (
        <View key={shelf.shelfHundreds} style={sectionStyles.shelfBlock}>
          {shelfIdx > 0 ? <View style={sectionStyles.shelfPlank} /> : null}
          <Text style={[sectionStyles.shelfLabel, { color: colors.foreground }]}>
            {`${shelf.label} · ${shelf.partCount} ${shelf.partCount === 1 ? "part" : "parts"}`}
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={shelfStyles.diagramScroll}
          >
            <View style={shelfStyles.slotsRow}>
              {shelf.parts.map((p, partIdx) => {
                const prevPos = partIdx === 0 ? p.position : shelf.parts[partIdx - 1]!.position;
                const gap = partIdx === 0 ? 0 : GAP_BASE + Math.max(0, (p.position - prevPos - 1) * GAP_PER_POS);
                const isSelected = selected?.shelfIdx === shelfIdx && selected?.partIdx === partIdx;
                return (
                  <React.Fragment key={`${p.bin}-${partIdx}`}>
                    {gap > 0 ? <View style={{ width: gap }} /> : null}
                    <Pressable
                      onPress={() => setSelected(isSelected ? null : { shelfIdx, partIdx })}
                      style={[
                        shelfStyles.slot,
                        {
                          backgroundColor: isSelected ? colors.primary : colors.card,
                          borderColor: isSelected ? colors.primary : colors.border,
                        },
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel={`Bin ${p.bin}: ${p.item.catalog ?? p.item.description ?? "part"}`}
                    >
                      <Text style={[shelfStyles.slotPos, { color: "#000000" }]}>
                        {p.bin.split("-").pop() ?? p.bin}
                      </Text>
                      <Text
                        numberOfLines={1}
                        style={[shelfStyles.slotName, { color: isSelected ? colors.primaryForeground : colors.foreground }]}
                      >
                        {p.item.catalog ?? p.item.description ?? "—"}
                      </Text>
                      {p.item.vendor ? (
                        <Text
                          numberOfLines={1}
                          style={[shelfStyles.slotVendor, { color: isSelected ? colors.primaryForeground + "aa" : colors.mutedForeground }]}
                        >
                          {p.item.vendor}
                        </Text>
                      ) : null}
                    </Pressable>
                  </React.Fragment>
                );
              })}
            </View>
            <View style={[shelfStyles.rail, { backgroundColor: colors.muted, borderColor: colors.border }]} />
          </ScrollView>
          {shelfIdx === shelves.length - 1 && shelf.partCount > 3 ? (
            <View style={sectionStyles.shelfPlank} />
          ) : null}
        </View>
      ))}

      {selectedPart ? (
        <View style={{ paddingHorizontal: 12, paddingTop: 4 }}>
          <ResultCard
            result={{
              item: selectedPart.item,
              confidence: 1,
              matchReason: locationLabel,
              seriesLabel: undefined,
              variants: [],
            }}
            rank={0}
            showRank={false}
            fontScale={fontScale}
            onEditKeywords={onEditKeywords}
            highlightBin={selectedPart.bin}
          />
        </View>
      ) : (
        <View style={[shelfStyles.hint, { minHeight: 80 }]}>
          <Feather name="mouse-pointer" size={20} color={colors.mutedForeground} style={{ marginBottom: 8 }} />
          <Text style={[shelfStyles.hintText, { color: colors.mutedForeground }]}>
            Tap a bin above to see part details
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

const sectionStyles = StyleSheet.create({
  shelfBlock: { marginBottom: 0 },
  shelfLabel: { fontSize: 13, fontFamily: "Inter_600SemiBold", paddingHorizontal: 16, paddingBottom: 4, paddingTop: 8 },
  shelfPlank: { height: 2, backgroundColor: "#000000", marginHorizontal: 0 },
});

// ──────────────────────────────────────────────────────────────────────────────

function Header({
  colors,
  crumbs,
  onClose,
  onBack,
  onHome,
}: {
  colors: ReturnType<typeof useColors>;
  crumbs: CrumbState;
  onClose: () => void;
  onBack: () => void;
  onHome: () => void;
}) {
  const parts: string[] = [];
  if (crumbs.aisle) parts.push(crumbs.aisle.label);
  if (crumbs.section) parts.push(crumbs.section.label);
  if (crumbs.shelf) parts.push(crumbs.shelf.label);
  const isRoot = !crumbs.aisle;
  return (
    <View style={[styles.header, { borderColor: colors.border, backgroundColor: colors.card }]}>
      <Pressable
        onPress={isRoot ? onClose : onBack}
        hitSlop={8}
        style={styles.headerBtn}
        accessibilityRole="button"
        accessibilityLabel={isRoot ? "Close Browse by Aisle" : "Go back one level"}
      >
        <Feather name={isRoot ? "x" : "chevron-left"} size={18} color={colors.foreground} />
        <Text style={[styles.headerBtnText, { color: colors.foreground }]}>
          {isRoot ? "Close" : "Back"}
        </Text>
      </Pressable>
      <View style={styles.crumbWrap}>
        {parts.length > 0 ? (
          <Text style={[styles.crumbPath, { color: "#000000" }]} numberOfLines={1}>
            {parts.join(" › ")}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function DrillRow({
  colors,
  label,
  count,
  hint,
  onPress,
}: {
  colors: ReturnType<typeof useColors>;
  label: string;
  count: number;
  hint?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.drillRow,
        {
          backgroundColor: pressed ? colors.muted : colors.card,
          borderColor: colors.border,
        },
      ]}
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${count} ${count === 1 ? "part" : "parts"}`}
    >
      <View style={{ flex: 1 }}>
        <Text style={[styles.drillLabel, { color: colors.foreground }]}>{label}</Text>
        {hint ? (
          <Text style={[styles.drillHint, { color: colors.mutedForeground }]}>{hint}</Text>
        ) : null}
      </View>
      <Text style={[styles.drillCount, { color: colors.mutedForeground }]}>
        {count} {count === 1 ? "part" : "parts"}
      </Text>
      <Feather name="chevron-right" size={18} color={colors.mutedForeground} style={{ marginLeft: 6 }} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrapper: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginHorizontal: 12,
    marginBottom: 6,
    borderRadius: 10,
    borderWidth: 1,
    gap: 10,
  },
  headerBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  headerBtnText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  crumbWrap: {
    flex: 1,
    flexDirection: "row",
    flexWrap: "nowrap",
    alignItems: "center",
    justifyContent: "center",
  },
  crumbHome: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  crumbPath: { fontSize: 12, fontFamily: "Inter_700Bold", flexShrink: 1, textAlign: "center" },
  drillRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 14,
    marginHorizontal: 12,
    marginBottom: 8,
    borderRadius: 10,
    borderWidth: 1,
  },
  drillLabel: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  drillHint: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 2 },
  drillCount: { fontSize: 13, fontFamily: "Inter_500Medium" },
  partRow: { paddingHorizontal: 12 },
  listContent: { paddingBottom: 140 },
  emptyCard: {
    margin: 16,
    padding: 20,
    borderRadius: 12,
    borderWidth: 1,
  },
  emptyTitle: { fontSize: 16, fontFamily: "Inter_700Bold", marginBottom: 8 },
  emptyHint: { fontSize: 13, fontFamily: "Inter_400Regular", lineHeight: 18 },
});
