/**
 * WarehouseMapView — native pan/zoom warehouse floor plan with zone overlays.
 *
 * SVG viewBox: 0 0 3592.55 2457.41
 * - Tap a zone  → BrowseByAisle for that aisle
 * - Long-press  → AisleSummarySheet summary + CTA
 * - Empty zones → instructional empty state over the map
 */
import React, {
  useCallback,
  useMemo,
  useState,
} from "react";
import {
  ActivityIndicator,
  Image,
  LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { SvgUri } from "react-native-svg";
import type { InventoryItem } from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";
import { useWarehouseZones, type ApiWarehouseZone } from "@/hooks/useWarehouseZones";

const SVG_VIEWBOX_W = 3592.55;
const SVG_VIEWBOX_H = 2457.41;
const SVG_ASPECT = SVG_VIEWBOX_W / SVG_VIEWBOX_H;

const MIN_SCALE = 0.8;
const MAX_SCALE = 6;

interface WarehouseMapViewProps {
  inventory: InventoryItem[];
  onZoneTap: (zone: ApiWarehouseZone) => void;
  onZoneLongPress?: (zone: ApiWarehouseZone) => void;
  isAdmin?: boolean;
}

// Clamp a value between min and max
function clamp(val: number, min: number, max: number) {
  "worklet";
  return Math.min(Math.max(val, min), max);
}

// Gets the SVG asset URI using react-native's asset resolver (works without expo-asset)
function getSvgUri(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src = Image.resolveAssetSource(require("../assets/warehouse-map.svg"));
    return src.uri;
  } catch {
    return "";
  }
}

export function WarehouseMapView({
  inventory,
  onZoneTap,
  onZoneLongPress,
  isAdmin,
}: WarehouseMapViewProps) {
  const colors = useColors();
  const { zones, loading, error, refetch } = useWarehouseZones();

  // Container dimensions
  const [containerW, setContainerW] = useState(0);
  const [containerH, setContainerH] = useState(0);

  // The SVG is rendered to fill container width, maintaining aspect ratio
  const svgRenderW = containerW;
  const svgRenderH = containerW > 0 ? containerW / SVG_ASPECT : 0;

  // Scale factors from SVG coords → rendered pixels
  const scaleX = containerW > 0 ? containerW / SVG_VIEWBOX_W : 0;
  const scaleY = svgRenderH > 0 ? svgRenderH / SVG_VIEWBOX_H : 0;

  // Reanimated shared values for pan/zoom
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTX = useSharedValue(0);
  const savedTY = useSharedValue(0);

  const svgUri = useMemo(() => getSvgUri(), []);


  const onLayout = useCallback((e: LayoutChangeEvent) => {
    setContainerW(e.nativeEvent.layout.width);
    setContainerH(e.nativeEvent.layout.height);
  }, []);

  // Clamp translate so the map can't be panned fully off-screen
  const clampTranslate = useCallback(
    (tx: number, ty: number, sc: number) => {
      "worklet";
      const scaledW = svgRenderW * sc;
      const scaledH = svgRenderH * sc;
      const maxX = Math.max(0, (scaledW - containerW) / 2);
      const maxY = Math.max(0, (scaledH - containerH) / 2);
      return {
        tx: clamp(tx, -maxX, maxX),
        ty: clamp(ty, -maxY, maxY),
      };
    },
    [svgRenderW, svgRenderH, containerW, containerH],
  );

  // ── Pinch gesture ─────────────────────────────────────────────────────────
  const pinchGesture = Gesture.Pinch()
    .onUpdate((e) => {
      const newScale = clamp(savedScale.value * e.scale, MIN_SCALE, MAX_SCALE);
      scale.value = newScale;
      const { tx, ty } = clampTranslate(savedTX.value, savedTY.value, newScale);
      translateX.value = tx;
      translateY.value = ty;
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      savedTX.value = translateX.value;
      savedTY.value = translateY.value;
    });

  // ── Pan gesture ────────────────────────────────────────────────────────────
  const panGesture = Gesture.Pan()
    .minPointers(1)
    .onUpdate((e) => {
      const { tx, ty } = clampTranslate(
        savedTX.value + e.translationX,
        savedTY.value + e.translationY,
        scale.value,
      );
      translateX.value = tx;
      translateY.value = ty;
    })
    .onEnd(() => {
      savedTX.value = translateX.value;
      savedTY.value = translateY.value;
    });

  const combinedGesture = Gesture.Simultaneous(pinchGesture, panGesture);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  // Reset zoom on double-tap
  const doubleTapGesture = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      scale.value = withSpring(1);
      savedScale.value = 1;
      translateX.value = withSpring(0);
      translateY.value = withSpring(0);
      savedTX.value = 0;
      savedTY.value = 0;
    });

  const mainGesture = Gesture.Exclusive(doubleTapGesture, combinedGesture);

  // ── Render zone overlays ───────────────────────────────────────────────────
  const zoneOverlays = useMemo(() => {
    if (scaleX === 0 || scaleY === 0) return null;
    return zones.map((zone) => {
      const x = zone.svgX * scaleX;
      const y = zone.svgY * scaleY;
      const w = zone.svgWidth * scaleX;
      const h = zone.svgHeight * scaleY;
      return (
        <Pressable
          key={zone.id}
          onPress={() => onZoneTap(zone)}
          onLongPress={() => setLongPressZone(toWarehouseZone(zone))}
          delayLongPress={400}
          style={[
            styles.zoneOverlay,
            {
              left: x,
              top: y,
              width: w,
              height: h,
              borderColor: colors.primary,
              backgroundColor: colors.primary + "28",
            },
          ]}
        >
          <Text
            style={[styles.zoneLabel, { color: colors.primary }]}
            numberOfLines={2}
          >
            {zone.label}
          </Text>
        </Pressable>
      );
    });
  }, [zones, scaleX, scaleY, colors, onZoneTap]);

  // ── Loading / error states ─────────────────────────────────────────────────
  if (containerW === 0) {
    return <View style={styles.fill} onLayout={onLayout} />;
  }

  return (
    <View style={styles.fill} onLayout={onLayout}>
      <GestureDetector gesture={mainGesture}>
        <Animated.View style={[styles.mapContainer, animatedStyle]}>
          {/* SVG floor plan */}
          {svgUri ? (
            <SvgUri
              uri={svgUri}
              width={svgRenderW}
              height={svgRenderH}
            />
          ) : (
            <View style={[styles.svgFallback, { width: svgRenderW, height: svgRenderH, backgroundColor: colors.muted }]}>
              <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>
                Map unavailable
              </Text>
            </View>
          )}

          {/* Zone overlays (absolute, positioned over the SVG) */}
          <View
            style={[
              styles.overlayContainer,
              { width: svgRenderW, height: svgRenderH },
            ]}
            pointerEvents="box-none"
          >
            {zoneOverlays}
          </View>
        </Animated.View>
      </GestureDetector>

      {/* Loading spinner */}
      {loading && (
        <View style={[styles.floatingBadge, { backgroundColor: colors.card }]} pointerEvents="none">
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={[styles.badgeText, { color: colors.mutedForeground }]}>
            Loading zones…
          </Text>
        </View>
      )}

      {/* Error badge */}
      {error && !loading && (
        <Pressable
          style={[styles.floatingBadge, { backgroundColor: colors.destructive + "18" }]}
          onPress={refetch}
        >
          <Text style={[styles.badgeText, { color: colors.destructive }]}>
            Zone sync failed — tap to retry
          </Text>
        </Pressable>
      )}

      {/* Empty state — shown only after zones have loaded and there are none */}
      {!loading && !error && zones.length === 0 && (
        <View style={[styles.emptyOverlay]} pointerEvents="none">
          <View style={[styles.emptyCard, { backgroundColor: colors.card + "ee", borderColor: colors.border }]}>
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
              No zones defined
            </Text>
            <Text style={[styles.emptyHint, { color: colors.mutedForeground }]}>
              {isAdmin
                ? "Use the Zone Drawing Tool to add aisle overlays."
                : "An admin can add aisle zones from the web interface."}
            </Text>
          </View>
        </View>
      )}

      {/* Hint badge — double tap to reset zoom */}
      <View style={[styles.hintBadge, { backgroundColor: colors.card + "cc", borderColor: colors.border }]} pointerEvents="none">
        <Text style={[styles.hintText, { color: colors.mutedForeground }]}>
          Pinch/drag to pan · Double-tap to reset
        </Text>
      </View>

      {/* AisleSummarySheet for long-press */}
      <AisleSummarySheet
        zone={longPressZone}
        inventory={inventory}
        onClose={() => setLongPressZone(null)}
        onBrowse={(z) => {
          setLongPressZone(null);
          onZoneTap(zones.find(zo => zo.aisleId === String(z.aisleNum)) ?? zones[0]!);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  mapContainer: {
    alignItems: "flex-start",
  },
  svgFallback: {
    alignItems: "center",
    justifyContent: "center",
  },
  overlayContainer: {
    position: "absolute",
    top: 0,
    left: 0,
  },
  zoneOverlay: {
    position: "absolute",
    borderWidth: 2,
    borderRadius: 4,
    justifyContent: "center",
    alignItems: "center",
    padding: 4,
  },
  zoneLabel: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    textAlign: "center",
  },
  floatingBadge: {
    position: "absolute",
    top: 12,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    gap: 6,
    shadowColor: "#000",
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  badgeText: { fontSize: 12, fontFamily: "Inter_500Medium" },
  emptyOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "flex-end",
    alignItems: "center",
    paddingBottom: 40,
  },
  emptyCard: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 20,
    paddingVertical: 16,
    maxWidth: 280,
    alignItems: "center",
  },
  emptyTitle: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    marginBottom: 6,
  },
  emptyHint: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 20,
  },
  hintBadge: {
    position: "absolute",
    bottom: 12,
    alignSelf: "center",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
  },
  hintText: { fontSize: 11, fontFamily: "Inter_400Regular" },
});
