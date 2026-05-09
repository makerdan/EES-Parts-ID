/**
 * Aisle drill-down — Aisle → Section → Shelf → Parts.
 *
 * Read-only and offline-capable: the hierarchy is built on-device by
 * `lib/aisleHierarchy.ts` from the cached inventory's `binLocations`
 * arrays, so workers can keep walking the warehouse with no signal.
 * Closing the overlay returns them to their prior search/filter state.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import type { InventoryItem, SearchResult } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { useApp } from '@/contexts/AppContext';
import { ResultCard } from '@/components/ResultCard';
import {
  buildAisleHierarchy,
  type AisleNode,
  type SectionNode,
  type ShelfNode,
  type PartOnShelf,
} from '@/lib/aisleHierarchy';

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
  /** Pass-through edit affordance so leaf cards behave the same as in Search.
   *  When omitted (non-admin) the "Edit Part Details" button is hidden. */
  onEditKeywords?: (item: InventoryItem) => void;
  /** When true, the parts level shows a visual shelf diagram instead of a flat list. */
  shelfViewEnabled?: boolean;
}

type Level = 'aisles' | 'sections' | 'shelves' | 'parts';

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
  const warehouseShelfView = settings.shelfViewEnabled;
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
    ? 'parts'
    : crumbs.section
      ? 'shelves'
      : crumbs.aisle
        ? 'sections'
        : 'aisles';

  // ── Scroll-position restoration for the sections list ─────────────────────
  const sectionsFlatListRef = useRef<FlatList>(null);
  const sectionsScrollOffsetRef = useRef(0);
  useEffect(() => {
    if (level === 'sections' && sectionsScrollOffsetRef.current > 0) {
      const id = setTimeout(() => {
        sectionsFlatListRef.current?.scrollToOffset({
          offset: sectionsScrollOffsetRef.current,
          animated: false,
        });
      }, 0);
      return () => clearTimeout(id);
    }
  }, [level]);

  // Memoized so the BackHandler effect below only re-registers when the
  // drill `level` actually changes (not on every parent re-render).
  const goBack = useCallback(() => {
    setCrumbs((c) => {
      if (c.shelf) return { ...c, shelf: null };
      if (c.section) return { ...c, section: null };
      if (c.aisle) return { ...c, aisle: null };
      return c;
    });
  }, []);

  const goHome = useCallback(() => setCrumbs({ aisle: null, section: null, shelf: null }), []);

  // ── Section-to-section navigation (Prev / Next within the same aisle) ─────
  // Derived inline — cheap lookup that re-evaluates whenever crumbs changes.
  const currentSectionIdx =
    crumbs.aisle && crumbs.section
      ? crumbs.aisle.sections.findIndex((s) => s.section === crumbs.section!.section)
      : -1;
  const prevSection =
    currentSectionIdx > 0 ? (crumbs.aisle?.sections[currentSectionIdx - 1] ?? null) : null;
  const nextSection =
    currentSectionIdx >= 0 && crumbs.aisle && currentSectionIdx < crumbs.aisle.sections.length - 1
      ? (crumbs.aisle.sections[currentSectionIdx + 1] ?? null)
      : null;

  const goToPrevSection = useCallback(() => {
    if (prevSection) setCrumbs((c) => ({ ...c, section: prevSection, shelf: null }));
  }, [prevSection]);

  const goToNextSection = useCallback(() => {
    if (nextSection) setCrumbs((c) => ({ ...c, section: nextSection, shelf: null }));
  }, [nextSection]);

  // ── Android hardware back gesture ─────────────────────────────────────────
  // When the overlay is open, intercept the hardware back press:
  //   • At root (aisles) → close the overlay entirely (call onClose)
  //   • Deeper levels    → pop one level up (call goBack)
  // Return true in both cases to prevent the event from bubbling to the tab
  // navigator. The effect re-registers whenever the drill level changes so
  // the handler always has the correct behaviour for the current depth.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const handler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (level === 'aisles') {
        onClose();
      } else {
        goBack();
      }
      return true;
    });
    return () => handler.remove();
  }, [level, goBack, onClose]);

  // Empty-state: the local cache is empty (offline first-run case).
  if (inventory.length === 0) {
    return (
      <View style={styles.wrapper}>
        <Header colors={colors} crumbs={crumbs} onClose={onClose} onBack={goBack} onHome={goHome} />
        <View
          style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}
        >
          <Text allowFontScaling={false} style={[styles.emptyTitle, { color: colors.foreground }]}>
            {cacheReady ? 'No inventory loaded' : 'Inventory not synced yet'}
          </Text>
          <Text
            allowFontScaling={false}
            style={[styles.emptyHint, { color: colors.mutedForeground }]}
          >
            {cacheReady
              ? 'There are no parts to browse.'
              : 'Browse by Aisle works offline once the inventory has been synced once. Connect to the network and wait for the sync badge in the header to finish.'}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.wrapper}>
      <Header colors={colors} crumbs={crumbs} onClose={onClose} onBack={goBack} onHome={goHome} />

      {level === 'aisles' ? (
        <FlatList
          data={hierarchy.aisles}
          keyExtractor={(a) => a.aisle}
          renderItem={({ item }) => (
            <DrillRow
              colors={colors}
              label={item.label}
              count={item.partCount}
              onPress={() => setCrumbs({ aisle: item, section: null, shelf: null })}
            />
          )}
          ListFooterComponent={
            hierarchy.unsorted ? (
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
                    label: 'Unsorted',
                    partCount: hierarchy.unsorted!.partCount,
                    parts: hierarchy.unsorted!.parts.map((item) => ({
                      item,
                      bin: (item.binLocations ?? [])[0] ?? '',
                      position: 0,
                    })),
                  };
                  const fakeSection: SectionNode = {
                    section: '—',
                    label: 'Unsorted',
                    partCount: hierarchy.unsorted!.partCount,
                    shelves: [fakeShelf],
                  };
                  const fakeAisle: AisleNode = {
                    aisle: '—',
                    label: 'Unsorted',
                    partCount: hierarchy.unsorted!.partCount,
                    sections: [fakeSection],
                  };
                  setCrumbs({ aisle: fakeAisle, section: fakeSection, shelf: fakeShelf });
                }}
              />
            ) : null
          }
          contentContainerStyle={styles.listContent}
        />
      ) : null}

      {level === 'sections' && crumbs.aisle ? (
        <FlatList
          ref={sectionsFlatListRef}
          data={crumbs.aisle.sections}
          keyExtractor={(s) => s.section}
          renderItem={({ item }) => (
            <DrillRow
              colors={colors}
              label={item.label}
              count={item.partCount}
              onPress={() => setCrumbs((c) => ({ ...c, section: item, shelf: null }))}
            />
          )}
          onScroll={(e) => {
            sectionsScrollOffsetRef.current = e.nativeEvent.contentOffset.y;
          }}
          scrollEventThrottle={16}
          contentContainerStyle={styles.listContent}
        />
      ) : null}

      {level === 'shelves' && crumbs.section ? (
        warehouseShelfView ? (
          <SectionShelfView
            section={crumbs.section}
            crumbs={crumbs}
            colors={colors}
            fontScale={fontScale}
            onEditKeywords={onEditKeywords}
            prevSectionLabel={prevSection?.label ?? null}
            nextSectionLabel={nextSection?.label ?? null}
            onPrevSection={goToPrevSection}
            onNextSection={goToNextSection}
          />
        ) : (
          <FlatList
            data={crumbs.section.shelves}
            keyExtractor={(s) => String(s.shelfHundreds)}
            renderItem={({ item }) => (
              <DrillRow
                colors={colors}
                label={item.label}
                count={item.partCount}
                onPress={() => setCrumbs((c) => ({ ...c, shelf: item }))}
              />
            )}
            contentContainerStyle={styles.listContent}
          />
        )
      ) : null}

      {level === 'parts' && crumbs.shelf ? (
        shelfViewEnabled ? (
          <ShelfView
            parts={crumbs.shelf.parts}
            crumbs={crumbs}
            colors={colors}
            fontScale={fontScale}
            onEditKeywords={onEditKeywords}
            prevSectionLabel={prevSection?.label ?? null}
            nextSectionLabel={nextSection?.label ?? null}
            onPrevSection={goToPrevSection}
            onNextSection={goToNextSection}
          />
        ) : (
          <FlatList
            data={crumbs.shelf.parts}
            keyExtractor={(p, i) => `${p.item.id}-${p.bin}-${i}`}
            renderItem={({ item, index }) => {
              const result: SearchResult = {
                item: item.item,
                confidence: 1,
                matchReason: `On ${crumbs.aisle?.label ?? ''} › ${crumbs.section?.label ?? ''} › ${crumbs.shelf?.label ?? ''}`,
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

// ── Swipe-to-navigate hook ────────────────────────────────────────────────────
// Detects horizontal swipes on the container view and calls the appropriate
// callback. Uses refs for callbacks so the PanResponder (created once) never
// holds stale closures.
//
// Conflict avoidance: `onStartShouldSetPanResponder` is false, and we rely on
// `onMoveShouldSetPanResponder` (non-capture) with a high horizontal ratio so
// nested horizontal ScrollViews — which claim the responder at touch-start —
// refuse the termination request and keep their own scroll. Swipes on blank
// areas (shelf labels, gaps, the nav bar) where nothing else claimed the
// touch will be picked up cleanly here.
function useSectionSwipe({
  onSwipeLeft,
  onSwipeRight,
}: {
  onSwipeLeft: (() => void) | null;
  onSwipeRight: (() => void) | null;
}) {
  const leftRef = useRef(onSwipeLeft);
  const rightRef = useRef(onSwipeRight);
  leftRef.current = onSwipeLeft;
  rightRef.current = onSwipeRight;

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onStartShouldSetPanResponderCapture: () => false,
      // Only claim if the swipe is clearly horizontal and no nested component
      // (horizontal ScrollView) already has the responder and won't yield.
      onMoveShouldSetPanResponder: (_, gs) =>
        Math.abs(gs.dx) > 10 && Math.abs(gs.dx) > Math.abs(gs.dy) * 2.5,
      onMoveShouldSetPanResponderCapture: () => false,
      onPanResponderRelease: (_, gs) => {
        const threshold = Platform.OS === 'ios' ? 75 : 60;
        if (Math.abs(gs.dx) < threshold) return;
        if (gs.dx < 0 && leftRef.current) leftRef.current();
        else if (gs.dx > 0 && rightRef.current) rightRef.current();
      },
    })
  ).current;

  return panResponder.panHandlers;
}

// ── Card-item swipe hook (iOS only) ──────────────────────────────────────────
// Navigates between individual parts on the same shelf when the user swipes
// left/right on the detail card area. iOS-only: returns false from
// onMoveShouldSetPanResponder on other platforms so the PanResponder is inert.
//
// Must be instantiated BEFORE useSectionSwipe in every consuming component so
// its PanResponder config occupies a lower index in the panConfigs capture
// array used by tests. That keeps panConfigs[panConfigs.length - 1] as the
// section-swipe config, leaving the existing swipe() test helper unchanged.
function useCardItemSwipe({
  onSwipeLeft,
  onSwipeRight,
}: {
  onSwipeLeft: (() => void) | null;
  onSwipeRight: (() => void) | null;
}) {
  const leftRef = useRef(onSwipeLeft);
  const rightRef = useRef(onSwipeRight);
  leftRef.current = onSwipeLeft;
  rightRef.current = onSwipeRight;

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onStartShouldSetPanResponderCapture: () => false,
      // iOS-only: claim clearly-horizontal moves on the card detail area before
      // the outer section-swipe PanResponder can claim them. On Android the
      // section swipe alone handles horizontal navigation.
      onMoveShouldSetPanResponder: (_, gs) =>
        Platform.OS === 'ios' && Math.abs(gs.dx) > 10 && Math.abs(gs.dx) > Math.abs(gs.dy) * 2.5,
      onMoveShouldSetPanResponderCapture: () => false,
      onPanResponderRelease: (_, gs) => {
        if (Platform.OS !== 'ios') return;
        if (Math.abs(gs.dx) < 40) return;
        if (gs.dx < 0 && leftRef.current) leftRef.current();
        else if (gs.dx > 0 && rightRef.current) rightRef.current();
      },
    })
  ).current;

  return panResponder.panHandlers;
}

// ── Visual shelf view ─────────────────────────────────────────────────────────

const BIN_SLOT_W = 84;
const BIN_SLOT_H = 76;
const GAP_BASE = 8; // minimum px gap between slots
const GAP_PER_POS = 7; // additional px per position unit of separation

function ShelfView({
  parts,
  crumbs,
  colors,
  fontScale,
  onEditKeywords,
  prevSectionLabel,
  nextSectionLabel,
  onPrevSection,
  onNextSection,
}: {
  parts: PartOnShelf[];
  crumbs: CrumbState;
  colors: ReturnType<typeof useColors>;
  fontScale: number;
  onEditKeywords?: (item: InventoryItem) => void;
  prevSectionLabel: string | null;
  nextSectionLabel: string | null;
  onPrevSection: () => void;
  onNextSection: () => void;
}) {
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const selectedPart = selectedIdx !== null ? (parts[selectedIdx] ?? null) : null;

  const scrollRef = useRef<ScrollView>(null);

  const sectionKey = crumbs.section?.label ?? null;
  useEffect(() => {
    scrollRef.current?.scrollTo({ x: 0, y: 0, animated: false });
    setSelectedIdx(null);
  }, [sectionKey]);

  const locationLabel = [crumbs.aisle?.label, crumbs.section?.label, crumbs.shelf?.label]
    .filter(Boolean)
    .join(' › ');

  // Card-to-card swipe (iOS-only). Created before useSectionSwipe so its
  // PanResponder sits at a lower panConfigs index, keeping the section-swipe
  // config last (preserving the existing swipe() test helper).
  const cardSwipeHandlers = useCardItemSwipe({
    onSwipeLeft:
      selectedIdx !== null && selectedIdx < parts.length - 1
        ? () => setSelectedIdx(selectedIdx + 1)
        : null,
    onSwipeRight:
      selectedIdx !== null && selectedIdx > 0 ? () => setSelectedIdx(selectedIdx - 1) : null,
  });

  const swipeHandlers = useSectionSwipe({
    onSwipeLeft: nextSectionLabel ? onNextSection : null,
    onSwipeRight: prevSectionLabel ? onPrevSection : null,
  });

  return (
    <View style={{ flex: 1 }} {...swipeHandlers}>
      <SectionNavBar
        prevLabel={prevSectionLabel}
        nextLabel={nextSectionLabel}
        onPrev={onPrevSection}
        onNext={onNextSection}
        colors={colors}
      />
      {/* ── Shelf diagram ── */}
      <View style={shelfStyles.diagramWrap}>
        <ScrollView
          ref={scrollRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={shelfStyles.diagramScroll}
        >
          <View style={shelfStyles.slotsRow}>
            {parts.map((p, i) => {
              const prevPos = i === 0 ? p.position : parts[i - 1]!.position;
              const gap =
                i === 0 ? 0 : GAP_BASE + Math.max(0, (p.position - prevPos - 1) * GAP_PER_POS);
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
                    accessibilityLabel={`Bin ${p.bin}: ${p.item.catalog ?? p.item.description ?? 'part'}`}
                    accessibilityState={{ selected: isSelected }}
                  >
                    <Text
                      allowFontScaling={false}
                      style={[shelfStyles.slotPos, { color: '#000000' }]}
                    >
                      {p.bin.split('-').pop() ?? p.bin}
                    </Text>
                    <Text
                      allowFontScaling={false}
                      numberOfLines={1}
                      style={[
                        shelfStyles.slotName,
                        { color: isSelected ? colors.primaryForeground : colors.foreground },
                      ]}
                    >
                      {p.item.catalog ?? p.item.description ?? '—'}
                    </Text>
                    {p.item.vendor ? (
                      <Text
                        allowFontScaling={false}
                        numberOfLines={1}
                        style={[
                          shelfStyles.slotVendor,
                          {
                            color: isSelected
                              ? colors.primaryForeground + 'aa'
                              : colors.mutedForeground,
                          },
                        ]}
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
          <View
            style={[
              shelfStyles.rail,
              { backgroundColor: colors.muted, borderColor: colors.border },
            ]}
          />
        </ScrollView>
        <Text
          allowFontScaling={false}
          style={[shelfStyles.locationLabel, { color: colors.mutedForeground }]}
        >
          {`${locationLabel} · ${parts.length} ${parts.length === 1 ? 'part' : 'parts'}`}
        </Text>
      </View>

      {/* ── Part detail ── */}
      {selectedPart ? (
        <View style={{ flex: 1 }} {...cardSwipeHandlers}>
          <FlatList
            data={[selectedPart]}
            keyExtractor={(p) => `${p.bin}-detail`}
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
                    initiallyExpanded
                  />
                </View>
              );
            }}
            contentContainerStyle={{ paddingBottom: 140 }}
          />
        </View>
      ) : (
        <View style={shelfStyles.hint}>
          <Feather
            name="mouse-pointer"
            size={20}
            color={colors.mutedForeground}
            style={{ marginBottom: 8 }}
          />
          <Text
            allowFontScaling={false}
            style={[shelfStyles.hintText, { color: colors.mutedForeground }]}
          >
            Tap a bin above to see part details
          </Text>
        </View>
      )}
    </View>
  );
}

const shelfStyles = StyleSheet.create({
  diagramWrap: { flexGrow: 0 },
  diagramScroll: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 0,
    alignItems: 'flex-end',
  },
  slotsRow: { flexDirection: 'row', alignItems: 'flex-end' },
  slot: {
    width: BIN_SLOT_W,
    height: BIN_SLOT_H,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'flex-end',
  },
  slotPos: {
    fontSize: 15,
    fontFamily: 'Inter_500Medium',
    marginBottom: 3,
    textAlign: 'center',
    textDecorationLine: 'underline',
  },
  slotName: { fontSize: 11, fontFamily: 'Inter_600SemiBold', lineHeight: 14 },
  slotVendor: { fontSize: 9, fontFamily: 'Inter_400Regular', marginTop: 2 },
  rail: {
    height: 8,
    borderRadius: 4,
    borderWidth: 1,
    marginTop: 4,
  },
  locationLabel: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    paddingHorizontal: 16,
    paddingTop: 5,
    paddingBottom: 2,
  },
  hint: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  hintText: { fontSize: 13, fontFamily: 'Inter_400Regular' },
});

// ── Section-wide shelf view (all shelves in a section stacked) ────────────────

function SectionShelfView({
  section,
  crumbs,
  colors,
  fontScale,
  onEditKeywords,
  prevSectionLabel,
  nextSectionLabel,
  onPrevSection,
  onNextSection,
}: {
  section: SectionNode;
  crumbs: CrumbState;
  colors: ReturnType<typeof useColors>;
  fontScale: number;
  onEditKeywords?: (item: InventoryItem) => void;
  prevSectionLabel: string | null;
  nextSectionLabel: string | null;
  onPrevSection: () => void;
  onNextSection: () => void;
}) {
  const [selected, setSelected] = useState<{ shelfIdx: number; partIdx: number } | null>(null);

  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ y: 0, animated: false });
    setSelected(null);
  }, [section]);

  // Render lowest hundreds at top, highest (e.g. 900) at bottom — mirrors
  // a physical shelf stack viewed straight-on from the front.
  const shelves = [...section.shelves].reverse();

  const selectedPart =
    selected !== null ? (shelves[selected.shelfIdx]?.parts[selected.partIdx] ?? null) : null;

  const locationLabel = [crumbs.aisle?.label, section.label].filter(Boolean).join(' › ');

  // Card-to-card swipe (iOS-only). Created before useSectionSwipe so its
  // PanResponder sits at a lower panConfigs index, keeping the section-swipe
  // config last (preserving the existing swipe() test helper).
  const selectedShelf = selected !== null ? (shelves[selected.shelfIdx] ?? null) : null;
  const cardSwipeHandlers = useCardItemSwipe({
    onSwipeLeft:
      selected !== null &&
      selectedShelf !== null &&
      selected.partIdx < selectedShelf.parts.length - 1
        ? () => setSelected((s) => (s ? { ...s, partIdx: s.partIdx + 1 } : null))
        : null,
    onSwipeRight:
      selected !== null && selected.partIdx > 0
        ? () => setSelected((s) => (s ? { ...s, partIdx: s.partIdx - 1 } : null))
        : null,
  });

  const swipeHandlers = useSectionSwipe({
    onSwipeLeft: nextSectionLabel ? onNextSection : null,
    onSwipeRight: prevSectionLabel ? onPrevSection : null,
  });

  return (
    <View style={{ flex: 1 }} {...swipeHandlers}>
      <SectionNavBar
        prevLabel={prevSectionLabel}
        nextLabel={nextSectionLabel}
        onPrev={onPrevSection}
        onNext={onNextSection}
        colors={colors}
      />
      <ScrollView ref={scrollRef} contentContainerStyle={{ paddingBottom: 140 }}>
        {shelves.map((shelf, shelfIdx) => (
          <View key={shelf.shelfHundreds} style={sectionStyles.shelfBlock}>
            {shelfIdx > 0 ? (
              <View style={[sectionStyles.shelfPlank, { backgroundColor: colors.foreground }]} />
            ) : null}
            <Text
              allowFontScaling={false}
              style={[sectionStyles.shelfLabel, { color: colors.foreground }]}
            >
              {`${shelf.label} · ${shelf.partCount} ${shelf.partCount === 1 ? 'part' : 'parts'}`}
            </Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={shelfStyles.diagramScroll}
            >
              <View style={shelfStyles.slotsRow}>
                {shelf.parts.map((p, partIdx) => {
                  const prevPos = partIdx === 0 ? p.position : shelf.parts[partIdx - 1]!.position;
                  const gap =
                    partIdx === 0
                      ? 0
                      : GAP_BASE + Math.max(0, (p.position - prevPos - 1) * GAP_PER_POS);
                  const isSelected =
                    selected?.shelfIdx === shelfIdx && selected?.partIdx === partIdx;
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
                        accessibilityLabel={`Bin ${p.bin}: ${p.item.catalog ?? p.item.description ?? 'part'}`}
                        accessibilityState={{ selected: isSelected }}
                      >
                        <Text
                          allowFontScaling={false}
                          style={[shelfStyles.slotPos, { color: '#000000' }]}
                        >
                          {p.bin.split('-').pop() ?? p.bin}
                        </Text>
                        <Text
                          allowFontScaling={false}
                          numberOfLines={1}
                          style={[
                            shelfStyles.slotName,
                            { color: isSelected ? colors.primaryForeground : colors.foreground },
                          ]}
                        >
                          {p.item.catalog ?? p.item.description ?? '—'}
                        </Text>
                        {p.item.vendor ? (
                          <Text
                            allowFontScaling={false}
                            numberOfLines={1}
                            style={[
                              shelfStyles.slotVendor,
                              {
                                color: isSelected
                                  ? colors.primaryForeground + 'aa'
                                  : colors.mutedForeground,
                              },
                            ]}
                          >
                            {p.item.vendor}
                          </Text>
                        ) : null}
                      </Pressable>
                    </React.Fragment>
                  );
                })}
              </View>
              <View
                style={[
                  shelfStyles.rail,
                  { backgroundColor: colors.muted, borderColor: colors.border },
                ]}
              />
            </ScrollView>
            {shelfIdx === shelves.length - 1 && shelf.partCount > 3 ? (
              <View style={[sectionStyles.shelfPlank, { backgroundColor: colors.foreground }]} />
            ) : null}
          </View>
        ))}

        {selectedPart ? (
          <View style={{ paddingHorizontal: 12, paddingTop: 4 }} {...cardSwipeHandlers}>
            <ResultCard
              key={`${selectedPart.item.id}-${selectedPart.bin}`}
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
              initiallyExpanded
            />
          </View>
        ) : (
          <View style={[shelfStyles.hint, { minHeight: 80 }]}>
            <Feather
              name="mouse-pointer"
              size={20}
              color={colors.mutedForeground}
              style={{ marginBottom: 8 }}
            />
            <Text
              allowFontScaling={false}
              style={[shelfStyles.hintText, { color: colors.mutedForeground }]}
            >
              Tap a bin above to see part details
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const sectionStyles = StyleSheet.create({
  shelfBlock: { marginBottom: 0 },
  shelfLabel: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    paddingHorizontal: 16,
    paddingBottom: 4,
    paddingTop: 8,
  },
  shelfPlank: { height: 2, backgroundColor: '#000000', marginHorizontal: 0 },
});

// ── Prev / Next section navigation bar ───────────────────────────────────────

function SectionNavBar({
  prevLabel,
  nextLabel,
  onPrev,
  onNext,
  colors,
}: {
  prevLabel: string | null;
  nextLabel: string | null;
  onPrev: () => void;
  onNext: () => void;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={[navStyles.bar, { borderColor: colors.border, backgroundColor: colors.card }]}>
      <Pressable
        onPress={onPrev}
        disabled={!prevLabel}
        hitSlop={8}
        style={[navStyles.btn, !prevLabel && navStyles.btnDisabled]}
        accessibilityRole="button"
        accessibilityLabel={prevLabel ? `Previous section: ${prevLabel}` : 'No previous section'}
      >
        <Feather
          name="chevron-left"
          size={16}
          color={prevLabel ? colors.foreground : colors.mutedForeground}
        />
        <Text
          allowFontScaling={false}
          numberOfLines={1}
          style={[
            navStyles.btnText,
            { color: prevLabel ? colors.foreground : colors.mutedForeground },
          ]}
        >
          {prevLabel ?? 'Previous'}
        </Text>
      </Pressable>
      <View style={[navStyles.divider, { backgroundColor: colors.border }]} />
      <Pressable
        onPress={onNext}
        disabled={!nextLabel}
        hitSlop={8}
        style={[navStyles.btn, !nextLabel && navStyles.btnDisabled]}
        accessibilityRole="button"
        accessibilityLabel={nextLabel ? `Next section: ${nextLabel}` : 'No next section'}
      >
        <Text
          allowFontScaling={false}
          numberOfLines={1}
          style={[
            navStyles.btnText,
            { color: nextLabel ? colors.foreground : colors.mutedForeground },
          ]}
        >
          {nextLabel ?? 'Next'}
        </Text>
        <Feather
          name="chevron-right"
          size={16}
          color={nextLabel ? colors.foreground : colors.mutedForeground}
        />
      </Pressable>
    </View>
  );
}

const navStyles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 12,
    marginBottom: 6,
    borderRadius: 10,
    borderWidth: 1,
    overflow: 'hidden',
  },
  btn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  btnDisabled: { opacity: 0.38 },
  btnText: { fontSize: 13, fontFamily: 'Inter_500Medium', flexShrink: 1 },
  divider: { width: 1, alignSelf: 'stretch' },
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
  const isRoot = !crumbs.aisle;
  const locationTitle = crumbs.aisle
    ? crumbs.section
      ? `${crumbs.aisle.label} - ${crumbs.section.label}`
      : crumbs.aisle.label
    : null;
  return (
    <View style={[styles.header, { borderColor: colors.border, backgroundColor: colors.card }]}>
      <Pressable
        onPress={isRoot ? onClose : onBack}
        hitSlop={8}
        style={styles.headerBtn}
        accessibilityRole="button"
        accessibilityLabel={isRoot ? 'Close Browse by Aisle' : 'Go back one level'}
      >
        <Feather name={isRoot ? 'x' : 'chevron-left'} size={18} color={colors.foreground} />
        <Text allowFontScaling={false} style={[styles.headerBtnText, { color: colors.foreground }]}>
          {isRoot ? 'Close' : 'Back'}
        </Text>
      </Pressable>
      <View style={styles.crumbWrap}>
        {locationTitle ? (
          <Text
            allowFontScaling={false}
            style={[styles.crumbPath, { color: colors.foreground }]}
            numberOfLines={1}
          >
            {locationTitle}
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
      accessibilityLabel={`${label}, ${count} ${count === 1 ? 'part' : 'parts'}`}
    >
      <View style={{ flex: 1 }}>
        <Text allowFontScaling={false} style={[styles.drillLabel, { color: colors.foreground }]}>
          {label}
        </Text>
        {hint ? (
          <Text
            allowFontScaling={false}
            style={[styles.drillHint, { color: colors.mutedForeground }]}
          >
            {hint}
          </Text>
        ) : null}
      </View>
      <Text allowFontScaling={false} style={[styles.drillCount, { color: colors.mutedForeground }]}>
        {count} {count === 1 ? 'part' : 'parts'}
      </Text>
      <Feather
        name="chevron-right"
        size={18}
        color={colors.mutedForeground}
        style={{ marginLeft: 6 }}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrapper: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginHorizontal: 12,
    marginBottom: 6,
    borderRadius: 10,
    borderWidth: 1,
    gap: 10,
  },
  headerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  headerBtnText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  crumbWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
  },
  crumbHome: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  crumbPath: {
    fontSize: 18,
    fontFamily: 'Inter_700Bold',
    flexShrink: 1,
    textAlign: 'center',
  },
  drillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 14,
    marginHorizontal: 12,
    marginBottom: 8,
    borderRadius: 10,
    borderWidth: 1,
  },
  drillLabel: {
    fontSize: 15,
    fontFamily: Platform.select({ ios: 'Courier New', android: 'monospace', default: 'monospace' }),
    fontWeight: '600',
  },
  drillHint: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 2 },
  drillCount: {
    fontSize: 13,
    fontFamily: Platform.select({ ios: 'Courier New', android: 'monospace', default: 'monospace' }),
  },
  partRow: { paddingHorizontal: 12 },
  listContent: { paddingBottom: 140 },
  emptyCard: {
    margin: 16,
    padding: 20,
    borderRadius: 12,
    borderWidth: 1,
  },
  emptyTitle: { fontSize: 16, fontFamily: 'Inter_700Bold', marginBottom: 8 },
  emptyHint: { fontSize: 13, fontFamily: 'Inter_400Regular', lineHeight: 18 },
});
