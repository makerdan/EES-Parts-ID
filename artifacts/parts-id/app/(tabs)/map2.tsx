/**
 * Map2 tab — raw SVG diagnostic viewer.
 *
 * No tiling, no zone overlays, no custom pan/zoom logic.
 * Just the warehouse-map.svg rendered directly so you can verify
 * the raw asset looks correct, independent of WarehouseMapView.
 *
 * Native: loads SVG text via Asset + fetch, renders with SvgXml
 *         inside a ScrollView so the user can pinch-to-zoom.
 * Web:    renders an <img> at full viewport width inside a scrollable div.
 */
import { Asset } from "expo-asset";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SvgXml } from "react-native-svg";

import { useColors } from "@/hooks/useColors";
import { useTrackScreen } from "@/utils/useTrackScreen";

// SVG natural dimensions (from warehouse-map.svg viewBox)
const SVG_W = 3592.55;
const SVG_H = 2457.41;
const SVG_ASPECT = SVG_W / SVG_H;

export default function Map2Screen() {
  useTrackScreen("Map2");
  const colors = useColors();

  if (Platform.OS === "web") {
    return <Map2Web colors={colors} />;
  }
  return <Map2Native colors={colors} />;
}

// ── Web renderer ──────────────────────────────────────────────────────────────

function Map2Web({ colors }: { colors: ReturnType<typeof useColors> }) {
  // On web, Expo resolves require("*.svg") to a bundled URL.
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-assignment
  const src: string = require("../../assets/warehouse-map.svg");
  return (
    // overflow-y: auto lets the browser handle vertical scroll natively.
    <div
      style={{
        width: "100%",
        height: "100%",
        overflowY: "auto",
        overflowX: "hidden",
        backgroundColor: colors.background,
      }}
    >
      <img
        src={src}
        alt="Warehouse floor plan"
        style={{ width: "100%", height: "auto", display: "block" }}
      />
    </div>
  );
}

// ── Native renderer ───────────────────────────────────────────────────────────

function Map2Native({ colors }: { colors: ReturnType<typeof useColors> }) {
  const [svgXml, setSvgXml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [asset] = await Asset.loadAsync(
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          require("../../assets/warehouse-map.svg"),
        );
        if (!alive) return;
        if (!asset) throw new Error("Asset failed to load");

        const uri = asset.localUri ?? asset.uri ?? "";
        const res = await fetch(uri);
        if (!alive) return;
        if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
        const xml = await res.text();
        if (!alive) return;
        setSvgXml(xml);
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { alive = false; };
  }, []);

  const screenW = Dimensions.get("window").width;
  const svgH = screenW / SVG_ASPECT;

  if (error) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Text style={{ color: colors.destructive, textAlign: "center", padding: 16 }}>
          Failed to load SVG:{"\n"}{error}
        </Text>
      </View>
    );
  }

  if (!svgXml) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{ flexGrow: 1 }}
      maximumZoomScale={8}
      minimumZoomScale={1}
      bouncesZoom
      showsVerticalScrollIndicator
      showsHorizontalScrollIndicator
    >
      <SvgXml
        xml={svgXml}
        width={screenW}
        height={svgH}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
