/**
 * Warehouse Map tab.
 *
 * Web  → WarehouseMapWeb (zoomable SVG floor plan + section pins)
 * iOS  → WarehouseMapView (pan/zoom SVG + DB zone overlays)
 *
 * Zone sync:
 *   - useWarehouseZones fetches on mount, on tab focus, and on app foreground.
 *   - Cached data is served immediately; background refresh keeps it fresh.
 */
import React, { useCallback, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useFocusEffect } from "expo-router";
import { Feather } from "@expo/vector-icons";
import type { InventoryItem } from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/contexts/AppContext";
import { BrowseByAisle } from "@/components/BrowseByAisle";
import { AisleSummarySheet } from "@/components/AisleSummarySheet";
import type { WarehouseZone } from "@/lib/aisleHierarchy";
import { WarehouseMapWeb } from "@/components/WarehouseMapWeb";
import { WarehouseMapView } from "@/components/WarehouseMapView";
import { useWarehouseZones, type ApiWarehouseZone } from "@/hooks/useWarehouseZones";

const FUSE_CACHE_KEY = "parts_id_fuse_cache_v2";

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

  // Re-sync zones every time the tab comes into focus
  useFocusEffect(
    useCallback(() => {
      refetchZones();
    }, [refetchZones]),
  );

  const [browseOpen, setBrowseOpen] = useState(false);
  const [drilldown, setDrilldown] = useState<WarehouseZone | null>(null);
  const [summaryZone, setSummaryZone] = useState<WarehouseZone | null>(null);
  const inventoryRef = useRef<InventoryItem[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);

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
    setSummaryZone(toAisleZone(zone));
  }, []);

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

  // ── Web: existing WarehouseMapWeb ─────────────────────────────────────────
  if (Platform.OS === "web") {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>Warehouse Map</Text>
          <Pressable
            onPress={() => setBrowseOpen(true)}
            style={[styles.browseLink, { borderColor: colors.border }]}
          >
            <Feather name="list" size={14} color={colors.foreground} style={{ marginRight: 4 }} />
            <Text style={[styles.browseLinkText, { color: colors.foreground }]}>List view</Text>
          </Pressable>
        </View>
        <WarehouseMapWeb
          inventory={inventory}
          onAislePress={(aisleNum) => {
            setDrilldown({ aisleNum, label: `Aisle ${String(aisleNum).padStart(2, "0")}` });
          }}
        />
      </SafeAreaView>
    );
  }

  // ── Native: SVG floor plan with zone overlays ─────────────────────────────
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>Warehouse Map</Text>
        <Pressable
          onPress={() => setBrowseOpen(true)}
          style={[styles.browseLink, { borderColor: colors.border }]}
        >
          <Feather name="list" size={14} color={colors.foreground} style={{ marginRight: 4 }} />
          <Text style={[styles.browseLinkText, { color: colors.foreground }]}>List view</Text>
        </Pressable>
      </View>

      <WarehouseMapView
        zones={zones}
        zonesLoading={zonesLoading}
        zonesError={zonesError}
        onZonesRetry={refetchZones}
        onZoneTap={handleZoneTap}
        onZoneLongPress={handleZoneLongPress}
        isAdmin={isAdmin}
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
  browseLink: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  browseLinkText: { fontSize: 13, fontFamily: "Inter_400Regular" },
});
