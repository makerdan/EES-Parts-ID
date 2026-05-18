/**
 * WarehouseMapView — native pan/zoom warehouse floor plan with SVG zone overlays.
 *
 * SVG viewBox: 0 0 3592.55 2457.41
 * Zone overlays rendered as SVG <Rect> elements in viewBox coordinate space
 * so coordinate mapping is handled by the SVG viewport transform.
 *
 * isInventory=true  → interactive (tap → browse, long-press → summary)
 * isInventory=false → muted, non-interactive label overlay
 * Empty zones       → instructional empty state card over the map
 */
import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Image,
  LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { Svg, Rect, G, Text as SvgText, SvgUri } from "react-native-svg";
import { useColors } from "@/hooks/useColors";
import type { ApiWarehouseZone } from "@/hooks/useWarehouseZones";

const SVG_VIEWBOX_W = 3592.55;
const SVG_VIEWBOX_H = 2457.41;
const SVG_ASPECT = SVG_VIEWBOX_W / SVG_VIEWBOX_H;

const MIN_SCALE = 0.8;
const MAX_SCALE = 6;

// Standalone worklet — no closure over JS values
function clamp(val: number, min: number, max: number) {
  "worklet";
  return val < min ? min : val > max ? max : val;
}

// Gets the bundled SVG asset URI via React Native's asset resolver
function getSvgUri(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src = Image.resolveAssetSource(require("../assets/warehouse-map.svg"));
    return src.uri;
  } catch {
    return "";
  }
}

export interface WarehouseMapViewProps {
  zones: ApiWarehouseZone[];
  zonesLoading: boolean;
  zonesError: boolean;
  onZonesRetry: () => void;
  onZoneTap: (zone: ApiWarehouseZone) => void;
  onZoneLongPress?: (zone: ApiWarehouseZone) => void;
  isAdmin?: boolean;
}

export function WarehouseMapView({
  zones,
  zonesLoading,
  zonesError,
  onZonesRetry,
  onZoneTap,
  onZoneLongPress,
  isAdmin,
}: WarehouseMapViewProps) {
  const colors = useColors();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";

  // JS state for rendering (drives SVG dimensions)
  const [containerW, setContainerW] = useState(0);
  const [containerH, setContainerH] = useState(0);
  const svgRenderW = containerW;
  const svgRenderH = containerW > 0 ? containerW / SVG_ASPECT : 0;

  // Shared values for gesture computations (UI thread safe)
  const containerWV = useSharedValue(0);
  const containerHV = useSharedValue(0);
  const svgRenderWV = useSharedValue(0);
  const svgRenderHV = useSharedValue(0);

  const onLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const { width, height } = e.nativeEvent.layout;
      const rh = width > 0 ? width / SVG_ASPECT : 0;
      setContainerW(width);
      setContainerH(height);
      containerWV.value = width;
      containerHV.value = height;
      svgRenderWV.value = width;
      svgRenderHV.value = rh;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Pan/zoom shared values
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTX = useSharedValue(0);
  const savedTY = useSharedValue(0);

  const svgUri = useMemo(() => getSvgUri(), []);

  // ── Pinch gesture ──────────────────────────────────────────────────────────
  const pinchGesture = Gesture.Pinch()
    .onUpdate((e) => {
      const newScale = clamp(savedScale.value * e.scale, MIN_SCALE, MAX_SCALE);
      scale.value = newScale;
      const scaledW = svgRenderWV.value * newScale;
      const scaledH = svgRenderHV.value * newScale;
      const maxX = Math.max(0, (scaledW - containerWV.value) / 2);
      const maxY = Math.max(0, (scaledH - containerHV.value) / 2);
      translateX.value = clamp(savedTX.value, -maxX, maxX);
      translateY.value = clamp(savedTY.value, -maxY, maxY);
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      savedTX.value = translateX.value;
      savedTY.value = translateY.value;
    });

  // ── Pan gesture (minDistance prevents tap interference) ────────────────────
  const panGesture = Gesture.Pan()
    .minPointers(1)
    .minDistance(6)
    .onUpdate((e) => {
      const scaledW = svgRenderWV.value * scale.value;
      const scaledH = svgRenderHV.value * scale.value;
      const maxX = Math.max(0, (scaledW - containerWV.value) / 2);
      const maxY = Math.max(0, (scaledH - containerHV.value) / 2);
      translateX.value = clamp(savedTX.value + e.translationX, -maxX, maxX);
      translateY.value = clamp(savedTY.value + e.translationY, -maxY, maxY);
    })
    .onEnd(() => {
      savedTX.value = translateX.value;
      savedTY.value = translateY.value;
    });

  // ── Double-tap to reset zoom ────────────────────────────────────────────────
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

  const mainGesture = Gesture.Exclusive(
    doubleTapGesture,
    Gesture.Simultaneous(pinchGesture, panGesture),
  );

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  // ── SVG zone overlays (viewBox coordinate space) ───────────────────────────
  const zoneOverlays = useMemo(() => {
    if (!zones.length) return null;
    return zones.map((zone) => {
      const isActive = zone.isInventory;
      const fillColor = isActive ? colors.primary + "30" : colors.mutedForeground + "18";
      const strokeColor = isActive ? colors.primary : colors.mutedForeground;
      const strokeWidth = isActive ? 8 : 4;
      const labelColor = isActive ? colors.primary : colors.mutedForeground;

      return (
        <G
          key={zone.id}
          onPress={isActive ? () => onZoneTap(zone) : undefined}
          onLongPress={isActive ? () => onZoneLongPress?.(zone) : undefined}
          delayLongPress={400}
        >
          <Rect
            x={zone.svgX}
            y={zone.svgY}
            width={zone.svgWidth}
            height={zone.svgHeight}
            fill={fillColor}
            stroke={strokeColor}
            strokeWidth={strokeWidth}
            strokeDasharray={isActive ? undefined : "20 10"}
          />
          <SvgText
            x={zone.svgX + zone.svgWidth / 2}
            y={zone.svgY + zone.svgHeight / 2}
            fontSize={Math.max(24, Math.min(48, zone.svgHeight / 3))}
            fontWeight="bold"
            fill={labelColor}
            textAnchor="middle"
            alignmentBaseline="middle"
          >
            {zone.label}
          </SvgText>
        </G>
      );
    });
  }, [zones, colors, onZoneTap, onZoneLongPress]);

  // ── Early return before layout ─────────────────────────────────────────────
  if (containerW === 0) {
    return <View style={styles.fill} onLayout={onLayout} />;
  }

  return (
    <View style={styles.fill} onLayout={onLayout}>
      <GestureDetector gesture={mainGesture}>
        <Animated.View style={animatedStyle}>
          {/* Base floor plan SVG — dark mode: invert + darken for readable contrast */}
          {svgUri ? (
            <View
              style={[
                { width: svgRenderW, height: svgRenderH },
                isDark && styles.svgDarkFilter,
              ]}
            >
              <SvgUri uri={svgUri} width={svgRenderW} height={svgRenderH} />
            </View>
          ) : (
            <View
              style={[
                styles.svgFallback,
                { width: svgRenderW, height: svgRenderH, backgroundColor: colors.muted },
              ]}
            >
              <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>
                Map unavailable
              </Text>
            </View>
          )}

          {/* Zone overlays — same viewBox as base SVG → exact coordinate alignment */}
          <Svg
            style={StyleSheet.absoluteFill}
            viewBox={`0 0 ${SVG_VIEWBOX_W} ${SVG_VIEWBOX_H}`}
            width={svgRenderW}
            height={svgRenderH}
          >
            {zoneOverlays}
          </Svg>
        </Animated.View>
      </GestureDetector>

      {/* Zone loading spinner */}
      {zonesLoading && (
        <View
          style={[styles.floatingBadge, { backgroundColor: colors.card }]}
          pointerEvents="none"
        >
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={[styles.badgeText, { color: colors.mutedForeground }]}>
            Loading zones…
          </Text>
        </View>
      )}

      {/* Zone error badge */}
      {zonesError && !zonesLoading && (
        <Pressable
          style={[styles.floatingBadge, { backgroundColor: colors.destructive + "18" }]}
          onPress={onZonesRetry}
        >
          <Text style={[styles.badgeText, { color: colors.destructive }]}>
            Zone sync failed — tap to retry
          </Text>
        </Pressable>
      )}

      {/* Empty state: no zones defined yet */}
      {!zonesLoading && !zonesError && zones.length === 0 && (
        <View style={styles.emptyOverlay} pointerEvents="none">
          <View
            style={[
              styles.emptyCard,
              { backgroundColor: colors.card + "ee", borderColor: colors.border },
            ]}
          >
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

      {/* Hint: double-tap to reset zoom */}
      <View
        style={[
          styles.hintBadge,
          { backgroundColor: colors.card + "cc", borderColor: colors.border },
        ]}
        pointerEvents="none"
      >
        <Text style={[styles.hintText, { color: colors.mutedForeground }]}>
          Pinch/drag to pan · Double-tap to reset
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, overflow: "hidden" },
  svgFallback: { alignItems: "center", justifyContent: "center" },
  // Invert + slight brightness reduction for dark mode floor plan legibility
  svgDarkFilter: {
    filter: [{ invert: 1 }, { brightness: 0.88 }] as never,
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
    shadowOpacity: 0.12,
    shadowRadius: 4,
    elevation: 3,
  },
  badgeText: { fontSize: 12, fontFamily: "Inter_500Medium" },
  emptyOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "flex-end",
    alignItems: "center",
    paddingBottom: 44,
  },
  emptyCard: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 20,
    paddingVertical: 16,
    maxWidth: 280,
    alignItems: "center",
  },
  emptyTitle: { fontSize: 15, fontFamily: "Inter_700Bold", marginBottom: 6 },
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
