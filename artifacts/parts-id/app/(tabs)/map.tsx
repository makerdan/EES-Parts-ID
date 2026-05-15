/**
 * Warehouse Map tab.
 *
 * The SVG map rendering itself is planned for a future task. This tab
 * provides the BrowseByAisle overlay wiring and a stub placeholder until
 * the map visual is built.
 */
import React, { useRef, useState } from "react";
import {
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Feather } from "@expo/vector-icons";
import type { InventoryItem } from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/contexts/AppContext";
import { BrowseByAisle } from "@/components/BrowseByAisle";
import { AisleSummarySheet } from "@/components/AisleSummarySheet";
import type { WarehouseZone } from "@/lib/aisleHierarchy";

const FUSE_CACHE_KEY = "parts_id_fuse_cache_v2";

export default function MapScreen() {
  const colors = useColors();
  const { settings, isAdmin, textFontScale } = useApp();
  const [browseOpen, setBrowseOpen] = useState(false);
  const [drilldown, setDrilldown] = useState<WarehouseZone | null>(null);
  const [summaryZone, setSummaryZone] = useState<WarehouseZone | null>(null);
  const inventoryRef = useRef<InventoryItem[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  React.useEffect(() => {
    AsyncStorage.getItem(FUSE_CACHE_KEY)
      .then(raw => {
        if (!raw) return;
        try {
          const items = JSON.parse(raw) as InventoryItem[];
          inventoryRef.current = items;
          setInventory(items);
        } catch { /* ignore corrupt cache */ }
      })
      .finally(() => setLoaded(true));
  }, []);

  const handleBrowseFromSheet = (zone: WarehouseZone) => {
    setSummaryZone(null);
    setDrilldown(zone);
  };

  const handleBrowseClose = () => {
    setBrowseOpen(false);
    setDrilldown(null);
  };

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
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>🗺 Warehouse Map</Text>
      </View>

      {/* Placeholder until the SVG map is built */}
      <View style={styles.placeholder}>
        <Text style={[styles.placeholderEmoji]}>🏭</Text>
        <Text style={[styles.placeholderTitle, { color: colors.foreground }]}>Map coming soon</Text>
        <Text style={[styles.placeholderHint, { color: colors.mutedForeground }]}>
          The interactive warehouse map is under construction.{"\n"}
          Use Browse by Aisle to navigate now.
        </Text>

        <Pressable
          onPress={() => setBrowseOpen(true)}
          style={[styles.browseBtn, { backgroundColor: colors.primary, borderColor: "#000" }]}
        >
          <Feather name="map-pin" size={18} color={colors.primaryForeground} style={{ marginRight: 8 }} />
          <View>
            <Text style={[styles.browseBtnTitle, { color: colors.primaryForeground }]}>Browse by Aisle</Text>
            <Text style={[styles.browseBtnSub, { color: colors.primaryForeground + "bb" }]}>
              Aisle › Section › Shelf
            </Text>
          </View>
        </Pressable>

        {loaded && inventory.length === 0 ? (
          <Text style={[styles.noCache, { color: colors.mutedForeground }]}>
            No cached inventory. Visit the Search tab to sync.
          </Text>
        ) : null}
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
  header: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  headerTitle: { fontSize: 20, fontFamily: "Inter_700Bold" },
  placeholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
  placeholderEmoji: { fontSize: 56, marginBottom: 16 },
  placeholderTitle: { fontSize: 22, fontFamily: "Inter_700Bold", marginBottom: 8 },
  placeholderHint: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 22,
    marginBottom: 32,
  },
  browseBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 12,
    borderWidth: 2,
  },
  browseBtnTitle: { fontSize: 16, fontFamily: "Inter_700Bold" },
  browseBtnSub: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  noCache: { marginTop: 20, fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center" },
});
