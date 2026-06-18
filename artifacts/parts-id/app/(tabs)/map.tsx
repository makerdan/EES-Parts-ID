/**
 * Warehouse Map tab — pan/zoom SVG floor plan with DB zone overlays.
 *
 * WarehouseMapView is used on all platforms (web and native).
 *
 * Zone sync:
 *   - useWarehouseZones fetches on mount, on tab focus, and on app foreground.
 *   - Cached data is served immediately; background refresh keeps it fresh.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Linking,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useFocusEffect, useRouter } from "expo-router";
import * as ScreenOrientation from "expo-screen-orientation";
import { Feather } from "@expo/vector-icons";
import type { InventoryItem } from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/contexts/AppContext";
import { BrowseByAisle } from "@/components/BrowseByAisle";
import { AisleSummarySheet } from "@/components/AisleSummarySheet";
import { ZoneActionMenu } from "@/components/ZoneActionMenu";
import type { WarehouseZone } from "@/lib/aisleHierarchy";
import { parseBin } from "@/lib/aisleHierarchy";
import { WarehouseMapView } from "@/components/WarehouseMapView";
import { useWarehouseZones, type ApiWarehouseZone } from "@/hooks/useWarehouseZones";
import { FUSE_CACHE_KEY } from "@/utils/offlineBarcode";
import { swallowOrientationNotAvailable } from "@/utils/orientationLock";
import { useTrackScreen } from "@/utils/useTrackScreen";

const CYCLE_COUNTED_KEY = "CYCLE_COUNTED_IDS";

const ZONE_EDITOR_URL = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/__mockup/zone-editor`
  : "http://localhost:8081/__mockup/zone-editor";

function toAisleZone(zone: ApiWarehouseZone): WarehouseZone {
  const aisleNum = parseInt(zone.aisleId, 10) || 0;
  return {
    aisleNum,
    sectionNumbers: [zone.sectionNum],
  };
}

export default function MapScreen() {
  "use no memo";
  useTrackScreen("Map");
  const colors = useColors();
  const router = useRouter();
  const { settings, isAdmin, textFontScale, pendingMapFocus, setPendingMapFocus, pinnedParts, setPinnedParts, showToast } = useApp();

  /**
   * For each pinned aisle, build a label containing the actual bin code
   * (which encodes aisle + section + position, e.g. "17-06-204") and, when
   * multiple bins share the same aisle, the additional section numbers so the
   * worker knows exactly where in the aisle to look.
   */
  const pinnedBinLabels = useMemo(() => {
    const m = new Map<number, string>();
    const aisleSections = new Map<number, Set<number>>();
    for (const p of pinnedParts) {
      const parsed = parseBin(p.binCode);
      if (!parsed) continue;
      // First bin in this aisle → use its full code as the primary label
      if (!m.has(p.aisleNum)) m.set(p.aisleNum, p.binCode);
      // Track all distinct sections so we can append extras
      const secs = aisleSections.get(p.aisleNum) ?? new Set<number>();
      secs.add(parsed.section);
      aisleSections.set(p.aisleNum, secs);
    }
    // When more than one section exists in an aisle, append "·§SS" for each extra
    for (const [aisle, secs] of aisleSections) {
      if (secs.size <= 1) continue;
      const firstCode = m.get(aisle)!;
      const firstSection = parseBin(firstCode)?.section ?? -1;
      const extras = [...secs]
        .filter(s => s !== firstSection)
        .sort((a, b) => a - b)
        .map(s => `§${String(s).padStart(2, "0")}`);
      m.set(aisle, `${firstCode} ${extras.join("·")}`);
    }
    return m;
  }, [pinnedParts]);

  /**
   * Maps aisleNum → list of distinct section numbers (0-99) for PRIMARY pins.
   * Passed to WarehouseMapView so each aisle zone can render per-section
   * Circle markers that show the worker exactly where in the aisle to walk.
   */
  const pinnedSections = useMemo(() => {
    const m = new Map<number, Array<number>>();
    for (const p of pinnedParts) {
      if (p.variant) continue;
      const parsed = parseBin(p.binCode);
      if (!parsed) continue;
      const secs = m.get(p.aisleNum) ?? [];
      if (!secs.includes(parsed.section)) secs.push(parsed.section);
      m.set(p.aisleNum, secs);
    }
    return m;
  }, [pinnedParts]);

  /**
   * Maps aisleNum → list of distinct section numbers for VARIANT pins.
   */
  const variantSections = useMemo(() => {
    const m = new Map<number, Array<number>>();
    for (const p of pinnedParts) {
      if (!p.variant) continue;
      const parsed = parseBin(p.binCode);
      if (!parsed) continue;
      const secs = m.get(p.aisleNum) ?? [];
      if (!secs.includes(parsed.section)) secs.push(parsed.section);
      m.set(p.aisleNum, secs);
    }
    return m;
  }, [pinnedParts]);

  const hasPrimaryPins = pinnedParts.some(p => !p.variant);
  const hasVariantPins = pinnedParts.some(p => !!p.variant);

  /**
   * Human-readable chip label — distinct primary labels, first + count,
   * e.g. "Part 42A" or "Part 42A +2 more".
   */
  const pinnedChipLabel = useMemo(() => {
    const primaryLabels = [...new Set(pinnedParts.filter(p => !p.variant).map(p => p.label))];
    if (primaryLabels.length > 0) {
      const first = primaryLabels[0];
      return primaryLabels.length === 1 ? `📍 ${first}` : `📍 ${first} +${primaryLabels.length - 1} more`;
    }
    const variantLabels = [...new Set(pinnedParts.map(p => p.label))];
    if (variantLabels.length > 0) {
      const first = variantLabels[0];
      return variantLabels.length === 1 ? `📍 ${first}` : `📍 ${first} +${variantLabels.length - 1} more`;
    }
    return "📍 Pinned";
  }, [pinnedParts]);

  const primaryBinText = useMemo(() => {
    const first = pinnedParts.find(p => !p.variant);
    return first?.binCode ?? null;
  }, [pinnedParts]);

  // Keep a ref to pinnedParts so useFocusEffect can read the latest value
  // without needing to add it as a dependency (which would re-register the effect).
  const pinnedPartsRef = useRef(pinnedParts);
  useEffect(() => { pinnedPartsRef.current = pinnedParts; }, [pinnedParts]);

  // Aisle (and optional section) to auto-center the map on when the user navigates
  // here via "Show on Map". Set from useFocusEffect when pendingMapFocus is consumed.
  const [focusAisleNum, setFocusAisleNum] = useState<number | null>(null);
  const [focusSectionNum, setFocusSectionNum] = useState<number | null>(null);

  // Zone data — owned at this level so useFocusEffect can trigger refetch
  const { zones, loading: zonesLoading, error: zonesError, refetch: refetchZones } = useWarehouseZones();

  /**
   * Zone IDs for primary pins — highlights every zone whose aisle contains
   * a pinned section, regardless of section parity.
   */
  const pinnedZoneIds = useMemo(() => {
    const ids = new Set<number>();
    for (const zone of zones) {
      const aisleNum = parseInt(zone.aisleId, 10);
      const sections = pinnedSections.get(aisleNum);
      if (sections && sections.includes(zone.sectionNum)) ids.add(zone.id);
    }
    return ids;
  }, [zones, pinnedSections]);

  /** Same as pinnedZoneIds but for variant/related-size pins. */
  const variantZoneIds = useMemo(() => {
    const ids = new Set<number>();
    for (const zone of zones) {
      const aisleNum = parseInt(zone.aisleId, 10);
      const sections = variantSections.get(aisleNum);
      if (sections && sections.includes(zone.sectionNum)) ids.add(zone.id);
    }
    return ids;
  }, [zones, variantSections]);

  // Mirror pendingMapFocus into a ref so useFocusEffect can read it without
  // re-registering the effect every time the value changes.
  const pendingMapFocusRef = useRef(pendingMapFocus);
  useEffect(() => { pendingMapFocusRef.current = pendingMapFocus; }, [pendingMapFocus]);

  // Re-sync zones every time the tab comes into focus; unlock landscape orientation.
  // Also consume any pending map focus set from the Search tab ("Show on map").
  useFocusEffect(
    useCallback(() => {
      refetchZones();
      // Defer orientation unlock past the tab-switch animation so it does not
      // block the JS thread during the transition and cause a visible freeze.
      const orientTimer = setTimeout(() => {
        void ScreenOrientation.unlockAsync().catch(swallowOrientationNotAvailable);
      }, 300);

      const focus = pendingMapFocusRef.current;
      if (focus) {
        setPendingMapFocus(null);
        // Auto-center the map on the first primary pinned aisle (and section when
        // known) so the worker does not have to scroll to find the right zone.
        setFocusAisleNum(focus.aisleNum);
        setFocusSectionNum(focus.sectionNum ?? null);
      }

      return () => {
        clearTimeout(orientTimer);
        void ScreenOrientation.lockAsync(
          ScreenOrientation.OrientationLock.PORTRAIT_UP,
        ).catch(swallowOrientationNotAvailable);
      };
    }, [refetchZones, setPendingMapFocus]),
  );

  const [focusFailedBanner, setFocusFailedBanner] = useState<string | null>(null);

  const [drilldown, setDrilldown] = useState<WarehouseZone | null>(null);
  const [summaryZone, setSummaryZone] = useState<WarehouseZone | null>(null);
  const [selectedZone, setSelectedZone] = useState<ApiWarehouseZone | null>(null);
  const inventoryRef = useRef<Array<InventoryItem>>([]);
  const [inventory, setInventory] = useState<Array<InventoryItem>>([]);

  // ── Select / zone-tap mode ─────────────────────────────────────────────────
  const [selectMode, setSelectMode] = useState(false);

  // ── Cycle count layer ──────────────────────────────────────────────────────
  const [cycleMode, setCycleMode] = useState(false);
  const [showZoneEditorTooltip, setShowZoneEditorTooltip] = useState(false);
  const zoneTooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zoneEditorLongPressed = useRef(false);
  const [showCycleCountTooltip, setShowCycleCountTooltip] = useState(false);
  const cycleCountTooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cycleCountLongPressed = useRef(false);

  useEffect(() => () => {
    if (zoneTooltipTimer.current) clearTimeout(zoneTooltipTimer.current);
    if (cycleCountTooltipTimer.current) clearTimeout(cycleCountTooltipTimer.current);
  }, []);
  const [countedZoneIds, setCountedZoneIds] = useState<Set<number>>(new Set());

  React.useEffect(() => {
    AsyncStorage.getItem(CYCLE_COUNTED_KEY).then((raw) => {
      if (!raw) return;
      try {
        const ids = JSON.parse(raw) as Array<number>;
        setCountedZoneIds(new Set(ids));
      } catch { /* ignore corrupt data */ }
    });
  }, []);

  React.useEffect(() => {
    AsyncStorage.getItem(FUSE_CACHE_KEY)
      .then(raw => {
        if (!raw) return;
        try {
          const items = JSON.parse(raw) as Array<InventoryItem>;
          inventoryRef.current = items;
          setInventory(items);
        } catch { /* ignore corrupt cache */ }
      });
  }, []);

  const handleZoneTap = useCallback((zone: ApiWarehouseZone) => {
    setSelectedZone(zone);
  }, []);

  const handleGoToSection = useCallback(() => {
    if (!selectedZone) return;
    setDrilldown(toAisleZone(selectedZone));
    setSelectedZone(null);
  }, [selectedZone]);

  const handleZoneMenuDismiss = useCallback(() => {
    setSelectedZone(null);
  }, []);

  const handleMapPanStart = useCallback(() => {
    setSelectedZone(null);
  }, []);

  const handleZoneLongPress = useCallback((zone: ApiWarehouseZone) => {
    if (cycleMode) {
      setCountedZoneIds((prev) => {
        const next = new Set(prev);
        if (next.has(zone.id)) {
          next.delete(zone.id);
        } else {
          next.add(zone.id);
        }
        void AsyncStorage.setItem(CYCLE_COUNTED_KEY, JSON.stringify([...next]));
        return next;
      });
      return;
    }
    setSummaryZone(toAisleZone(zone));
  }, [cycleMode]);

  const handleBrowseFromSheet = useCallback((zone: WarehouseZone) => {
    setSummaryZone(null);
    setDrilldown(zone);
  }, []);

  const handleBrowseClose = useCallback(() => {
    setDrilldown(null);
  }, []);

  if (drilldown !== null) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
        <BrowseByAisle
          inventory={inventory}
          isSyncing={false}
          shelfViewEnabled={settings.shelfViewEnabled}
          fontScale={textFontScale}
          onClose={handleBrowseClose}
          onRefresh={refetchZones}
          initialAisle={drilldown?.aisleNum}
          sectionNumbers={drilldown?.sectionNumbers}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>Warehouse Map</Text>
        <View style={styles.headerActions}>
          <View style={styles.cycleCountWrapper}>
            <Pressable
              onPress={() => {
                if (cycleCountLongPressed.current) {
                  cycleCountLongPressed.current = false;
                  return;
                }
                setCycleMode((v) => !v);
              }}
              onLongPress={() => {
                cycleCountLongPressed.current = true;
                if (cycleCountTooltipTimer.current) clearTimeout(cycleCountTooltipTimer.current);
                setShowCycleCountTooltip(true);
                cycleCountTooltipTimer.current = setTimeout(() => setShowCycleCountTooltip(false), 1500);
              }}
              onHoverIn={() => setShowCycleCountTooltip(true)}
              onHoverOut={() => setShowCycleCountTooltip(false)}
              delayLongPress={400}
              style={[
                styles.iconBtn,
                { borderColor: cycleMode ? colors.primary : colors.border },
              ]}
              accessibilityLabel={cycleMode ? "Hide cycle count layer" : "Show cycle count layer"}
              accessibilityHint="Long-press to see label"
            >
              <Feather
                name="layers"
                size={15}
                color={cycleMode ? colors.primary : colors.mutedForeground}
              />
            </Pressable>
            {showCycleCountTooltip && (
              <View style={[styles.zoneEditorTooltip, { backgroundColor: colors.foreground }]}>
                <Text style={[styles.zoneEditorTooltipText, { color: colors.background }]}>
                  Show Layers
                </Text>
              </View>
            )}
          </View>
          {/* Zone Editor: always visible; non-admins see a toast instead of opening the editor. */}
          <View style={styles.zoneEditorWrapper}>
              <Pressable
                onPress={() => {
                  if (zoneEditorLongPressed.current) {
                    zoneEditorLongPressed.current = false;
                    return;
                  }
                  if (!isAdmin) {
                    showToast("Please log in as admin to access the Zone Editor.", "info");
                    return;
                  }
                  if (Platform.OS === "web") {
                    Linking.openURL(ZONE_EDITOR_URL);
                  } else {
                    Clipboard.setStringAsync(ZONE_EDITOR_URL);
                    showToast("Zone Editor URL copied — open in your browser", "info");
                  }
                }}
                onLongPress={() => {
                  zoneEditorLongPressed.current = true;
                  if (zoneTooltipTimer.current) clearTimeout(zoneTooltipTimer.current);
                  setShowZoneEditorTooltip(true);
                  zoneTooltipTimer.current = setTimeout(() => setShowZoneEditorTooltip(false), 1500);
                }}
                onHoverIn={() => setShowZoneEditorTooltip(true)}
                onHoverOut={() => setShowZoneEditorTooltip(false)}
                delayLongPress={400}
                style={[styles.iconBtn, { borderColor: colors.border }]}
                accessibilityLabel="Open Zone Editor"
                accessibilityHint="Long-press to see label"
              >
                <Feather name="edit-2" size={15} color={colors.foreground} />
              </Pressable>
              {showZoneEditorTooltip && (
                <View style={[styles.zoneEditorTooltip, { backgroundColor: colors.foreground }]}>
                  <Text style={[styles.zoneEditorTooltipText, { color: colors.background }]}>
                    Zone Editor
                  </Text>
                </View>
              )}
            </View>
        </View>
      </View>

      {pinnedParts.length > 0 && (
        <View style={[styles.pinBanner, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
          <View style={styles.pinBannerLeft}>
            <Text
              style={[styles.pinBannerLabel, { color: colors.foreground }]}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {pinnedChipLabel}
            </Text>
            {primaryBinText !== null && (
              <Text
                style={[styles.pinBannerBin, { color: colors.mutedForeground }]}
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {primaryBinText}
              </Text>
            )}
          </View>
          <View style={styles.pinBannerRight}>
            {(hasPrimaryPins || hasVariantPins) && (
              <View style={styles.legendRow}>
                {hasPrimaryPins && (
                  <>
                    <View style={[styles.legendDot, { backgroundColor: "#f59e0b" }]} />
                    <Text style={[styles.legendLabel, { color: colors.mutedForeground }]}>Primary</Text>
                  </>
                )}
                {hasVariantPins && (
                  <>
                    <View style={[styles.legendDot, { backgroundColor: "#8b5cf6" }]} />
                    <Text style={[styles.legendLabel, { color: colors.mutedForeground }]}>Variant</Text>
                  </>
                )}
              </View>
            )}
            <Pressable
              onPress={() => setPinnedParts([])}
              style={[styles.pinBannerClear, { borderColor: colors.border }]}
              accessibilityLabel="Clear pinned parts"
            >
              <Feather name="x" size={13} color={colors.mutedForeground} />
              <Text style={[styles.pinBannerClearText, { color: colors.mutedForeground }]}>Clear</Text>
            </Pressable>
          </View>
        </View>
      )}

      {focusFailedBanner ? (
        <View style={[styles.focusFailBanner, { backgroundColor: colors.warning + "18", borderBottomColor: colors.warning + "44" }]}>
          <Text style={[styles.focusFailBannerText, { color: colors.warning, flex: 1 }]} numberOfLines={2}>
            {focusFailedBanner}
          </Text>
          <Pressable
            onPress={() => { setFocusFailedBanner(null); router.navigate("/"); }}
            style={[styles.focusFailBackBtn, { backgroundColor: colors.warning, }]}
            accessibilityLabel="Back to search results"
            accessibilityRole="button"
          >
            <Text style={styles.focusFailBackBtnText}>Back to results</Text>
          </Pressable>
          <Pressable
            onPress={() => setFocusFailedBanner(null)}
            hitSlop={8}
            accessibilityLabel="Dismiss zone not found message"
            accessibilityRole="button"
          >
            <Feather name="x" size={16} color={colors.warning} />
          </Pressable>
        </View>
      ) : null}

      <View style={styles.mapWrapper}>
        <WarehouseMapView
          zones={zones}
          zonesLoading={zonesLoading}
          zonesError={zonesError}
          onZonesRetry={refetchZones}
          onZoneTap={handleZoneTap}
          onZoneLongPress={handleZoneLongPress}
          isAdmin={isAdmin}
          cycleMode={cycleMode}
          selectMode={selectMode}
          onSelectModeChange={setSelectMode}
          countedZoneIds={countedZoneIds}
          pinnedZoneIds={pinnedZoneIds.size > 0 ? pinnedZoneIds : undefined}
          variantZoneIds={variantZoneIds.size > 0 ? variantZoneIds : undefined}
          pinnedBinLabels={pinnedBinLabels.size > 0 ? pinnedBinLabels : undefined}
          pinnedSectionsMap={pinnedSections.size > 0 ? pinnedSections : undefined}
          variantSectionsMap={variantSections.size > 0 ? variantSections : undefined}
          focusAisleNum={focusAisleNum}
          focusSectionNum={focusSectionNum}
          onFocusConsumed={() => { setFocusAisleNum(null); setFocusSectionNum(null); }}
          onFocusFailed={() => {
            setFocusFailedBanner(`No map zone found for aisle ${focusAisleNum} — check the warehouse configuration.`);
            setFocusAisleNum(null);
            setFocusSectionNum(null);
          }}
          selectedZoneId={selectedZone?.id}
          onPanStart={handleMapPanStart}
        />

        {selectedZone !== null && (
          <>
            <Pressable
              style={styles.menuDismissOverlay}
              onPress={handleZoneMenuDismiss}
              accessibilityLabel="Dismiss zone menu"
            />
            <ZoneActionMenu
              zone={selectedZone}
              onGoToSection={handleGoToSection}
              onDismiss={handleZoneMenuDismiss}
            />
          </>
        )}
      </View>

      <AisleSummarySheet
        zone={summaryZone}
        inventory={inventory}
        onClose={() => setSummaryZone(null)}
        onBrowse={handleBrowseFromSheet}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  mapWrapper: {
    flex: 1,
    position: "relative",
  },
  menuDismissOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  headerTitle: { fontSize: 20, fontFamily: "Inter_700Bold" },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  cycleCountWrapper: {
    position: "relative",
  },
  zoneEditorWrapper: {
    position: "relative",
  },
  zoneEditorTooltip: {
    position: "absolute",
    top: 35,
    right: 0,
    borderRadius: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    zIndex: 100,
  },
  zoneEditorTooltipText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
  },
  iconBtn: {
    borderWidth: 1,
    borderRadius: 6,
    padding: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  pinBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: 1,
    gap: 8,
  },
  pinBannerLeft: {
    flex: 1,
    flexDirection: "column",
    gap: 1,
  },
  pinBannerLabel: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  pinBannerBin: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
  },
  pinBannerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flexShrink: 0,
  },
  legendRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  legendDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  legendLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    marginRight: 4,
  },
  pinBannerClear: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  pinBannerClearText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  focusFailBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  focusFailBannerText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    lineHeight: 18,
  },
  focusFailBackBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    flexShrink: 0,
  },
  focusFailBackBtnText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "#fff",
  },
});
