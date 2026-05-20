/**
 * Warehouse Map tab — pan/zoom SVG floor plan with DB zone overlays.
 *
 * WarehouseMapView is used on all platforms (web and native).
 *
 * Zone sync:
 *   - useWarehouseZones fetches on mount, on tab focus, and on app foreground.
 *   - Cached data is served immediately; background refresh keeps it fresh.
 */
import React, { useCallback, useRef, useState } from "react";
import {
  Linking,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useFocusEffect } from "expo-router";
import * as ScreenOrientation from "expo-screen-orientation";
import { Feather } from "@expo/vector-icons";
import type { InventoryItem } from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/contexts/AppContext";
import { BrowseByAisle } from "@/components/BrowseByAisle";
import { AisleSummarySheet } from "@/components/AisleSummarySheet";
import type { WarehouseZone } from "@/lib/aisleHierarchy";
import { WarehouseMapView } from "@/components/WarehouseMapView";
import { useWarehouseZones, type ApiWarehouseZone } from "@/hooks/useWarehouseZones";
import { FUSE_CACHE_KEY } from "@/utils/offlineBarcode";

const CYCLE_COUNTED_KEY = "CYCLE_COUNTED_IDS";

const ZONE_EDITOR_URL = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/__mockup/zone-editor`
  : "http://localhost:8081/__mockup/zone-editor";

function toAisleZone(zone: ApiWarehouseZone): WarehouseZone {
  return {
    aisleNum: parseInt(zone.aisleId, 10) || 0,
    label: zone.label,
    sectionParity:
      zone.sectionParity === "odd" || zone.sectionParity === "even"
        ? zone.sectionParity
        : undefined,
  };
}

export default function MapScreen() {
  const colors = useColors();
  const { settings, isAdmin, textFontScale } = useApp();

  // Zone data — owned at this level so useFocusEffect can trigger refetch
  const { zones, loading: zonesLoading, error: zonesError, refetch: refetchZones } = useWarehouseZones();

  // Re-sync zones every time the tab comes into focus; unlock landscape orientation
  useFocusEffect(
    useCallback(() => {
      refetchZones();
      void ScreenOrientation.unlockAsync();
      return () => {
        void ScreenOrientation.lockAsync(
          ScreenOrientation.OrientationLock.PORTRAIT_UP,
        );
      };
    }, [refetchZones]),
  );

  const [browseOpen, setBrowseOpen] = useState(false);
  const [drilldown, setDrilldown] = useState<WarehouseZone | null>(null);
  const [summaryZone, setSummaryZone] = useState<WarehouseZone | null>(null);
  const inventoryRef = useRef<InventoryItem[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);

  // ── Cycle count layer ──────────────────────────────────────────────────────
  const [cycleMode, setCycleMode] = useState(false);
  const [cycleLocked, setCycleLocked] = useState(false);
  const [countedZoneIds, setCountedZoneIds] = useState<Set<number>>(new Set());

  React.useEffect(() => {
    AsyncStorage.getItem(CYCLE_COUNTED_KEY).then((raw) => {
      if (!raw) return;
      try {
        const ids = JSON.parse(raw) as number[];
        setCountedZoneIds(new Set(ids));
      } catch { /* ignore corrupt data */ }
    });
  }, []);

  React.useEffect(() => {
    AsyncStorage.getItem(FUSE_CACHE_KEY)
      .then(raw => {
        if (!raw) return;
        try {
          const items = JSON.parse(raw) as InventoryItem[];
          inventoryRef.current = items;
          setInventory(items);
        } catch { /* ignore corrupt cache */ }
      });
  }, []);

  const handleZoneTap = useCallback((zone: ApiWarehouseZone) => {
    setDrilldown(toAisleZone(zone));
  }, []);

  const handleZoneLongPress = useCallback((zone: ApiWarehouseZone) => {
    if (cycleMode) {
      if (cycleLocked) return;
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
  }, [cycleMode, cycleLocked]);

  const handleBrowseFromSheet = useCallback((zone: WarehouseZone) => {
    setSummaryZone(null);
    setDrilldown(zone);
  }, []);

  const handleBrowseClose = useCallback(() => {
    setBrowseOpen(false);
    setDrilldown(null);
  }, []);

  if (browseOpen || drilldown !== null) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
        <BrowseByAisle
          inventory={inventory}
          isSyncing={false}
          shelfViewEnabled={settings.shelfViewEnabled}
          fontScale={textFontScale}
          onClose={handleBrowseClose}
          initialAisle={drilldown?.aisleNum}
          sectionParity={drilldown?.sectionParity}
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
          {cycleMode && (
            <Pressable
              onPress={() => setCycleLocked((v) => !v)}
              style={[
                styles.iconBtn,
                { borderColor: cycleLocked ? colors.primary : colors.border },
              ]}
              accessibilityLabel={cycleLocked ? "Unlock cycle layer" : "Lock cycle layer"}
            >
              <Feather
                name={cycleLocked ? "lock" : "unlock"}
                size={15}
                color={cycleLocked ? colors.primary : colors.mutedForeground}
              />
            </Pressable>
          )}
          <Pressable
            onPress={() => setCycleMode((v) => !v)}
            style={[
              styles.iconBtn,
              { borderColor: cycleMode ? colors.primary : colors.border },
            ]}
            accessibilityLabel={cycleMode ? "Hide cycle count layer" : "Show cycle count layer"}
          >
            <Feather
              name="layers"
              size={15}
              color={cycleMode ? colors.primary : colors.mutedForeground}
            />
          </Pressable>
          <Pressable
            onPress={() => setBrowseOpen(true)}
            style={[styles.iconBtn, { borderColor: colors.border }]}
            accessibilityLabel="List view"
          >
            <Feather name="list" size={15} color={colors.foreground} />
          </Pressable>
          {isAdmin && (
            <Pressable
              onPress={() => Linking.openURL(ZONE_EDITOR_URL)}
              style={[styles.iconBtn, { borderColor: colors.border }]}
              accessibilityLabel="Open Zone Editor"
            >
              <Feather name="edit-2" size={15} color={colors.mutedForeground} />
            </Pressable>
          )}
        </View>
      </View>

      <WarehouseMapView
        zones={zones}
        zonesLoading={zonesLoading}
        zonesError={zonesError}
        onZonesRetry={refetchZones}
        onZoneTap={cycleMode ? () => undefined : handleZoneTap}
        onZoneLongPress={handleZoneLongPress}
        isAdmin={isAdmin}
        cycleMode={cycleMode}
        cycleLocked={cycleLocked}
        countedZoneIds={countedZoneIds}
      />

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
  iconBtn: {
    borderWidth: 1,
    borderRadius: 6,
    padding: 7,
    alignItems: "center",
    justifyContent: "center",
  },
});
