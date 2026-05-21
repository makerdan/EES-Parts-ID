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
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  LayoutChangeEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { Asset } from "expo-asset";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { Svg, Rect, G, Text as SvgText, SvgUri, SvgXml } from "react-native-svg";
import { useColors } from "@/hooks/useColors";
import type { ApiWarehouseZone } from "@/hooks/useWarehouseZones";

const SVG_VIEWBOX_W = 3592.55;
const SVG_VIEWBOX_H = 2457.41;
const SVG_ASPECT = SVG_VIEWBOX_W / SVG_VIEWBOX_H;

const MIN_SCALE = 0.8;
const MAX_SCALE = 50;

// Standalone worklet — no closure over JS values
function clamp(val: number, min: number, max: number) {
  "worklet";
  return val < min ? min : val > max ? max : val;
}


export interface WarehouseMapViewProps {
  zones: ApiWarehouseZone[];
  zonesLoading: boolean;
  zonesError: boolean;
  onZonesRetry: () => void;
  onZoneTap: (zone: ApiWarehouseZone) => void;
  onZoneLongPress?: (zone: ApiWarehouseZone) => void;
  isAdmin?: boolean;
  cycleMode?: boolean;
  cycleLocked?: boolean;
  countedZoneIds?: ReadonlySet<number>;
}

export function WarehouseMapView({
  zones,
  zonesLoading,
  zonesError,
  onZonesRetry,
  onZoneTap,
  onZoneLongPress,
  isAdmin,
  cycleMode = false,
  cycleLocked = false,
  countedZoneIds,
}: WarehouseMapViewProps) {
  const colors = useColors();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";

  // JS state for rendering (drives SVG dimensions)
  const [containerW, setContainerW] = useState(0);
  const [containerH, setContainerH] = useState(0);

  // Auto-dismiss empty-state banner after 3 s
  const [emptyDismissed, setEmptyDismissed] = useState(false);
  useEffect(() => {
    if (!zonesLoading && !zonesError && zones.length === 0) {
      setEmptyDismissed(false);
      const t = setTimeout(() => setEmptyDismissed(true), 3000);
      return () => clearTimeout(t);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zonesLoading, zonesError, zones.length]);
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

  // Resolve the bundled SVG asset.
  // On native: use the localUri/uri directly with SvgUri (reads from filesystem).
  // On web:    SvgUri fetches over HTTP; the proxied URI silently fails, so we
  //            fetch the SVG text ourselves and pass it to SvgXml instead.
  const [svgUri, setSvgUri] = useState("");
  const [svgXml, setSvgXml] = useState("");
  const [svgLoading, setSvgLoading] = useState(true);
  useEffect(() => {
    Asset.loadAsync(
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("../assets/warehouse-map.svg"),
    ).then(async ([asset]) => {
      const uri = asset.localUri ?? asset.uri ?? "";
      if (Platform.OS === "web") {
        const res = await fetch(uri);
        const xml = await res.text();
        setSvgXml(xml);
      } else {
        setSvgUri(uri);
      }
    }).catch(() => {
      setSvgUri("");
      setSvgXml("");
    }).finally(() => {
      setSvgLoading(false);
    });
  }, []);

  // Skeleton shimmer — pulsing opacity while SVG is fetching
  const [skeletonMounted, setSkeletonMounted] = useState(true);
  const skeletonOpacity = useSharedValue(1);
  const shimmerPulse = useSharedValue(0.45);
  useEffect(() => {
    shimmerPulse.value = withRepeat(
      withTiming(0.9, { duration: 850 }),
      -1,
      true,
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!svgLoading) {
      skeletonOpacity.value = withTiming(0, { duration: 350 }, (finished) => {
        if (finished) runOnJS(setSkeletonMounted)(false);
      });
    }
  }, [svgLoading, skeletonOpacity]);
  const skeletonStyle = useAnimatedStyle(() => ({
    opacity: skeletonOpacity.value,
  }));
  const shimmerStyle = useAnimatedStyle(() => ({
    opacity: shimmerPulse.value,
  }));

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

  // ── Programmatic zoom helpers (zoom buttons) ────────────────────────────────
  const applyZoom = useCallback((targetScale: number) => {
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, targetScale));
    const scaledW = svgRenderW * newScale;
    const scaledH = svgRenderH * newScale;
    const maxX = Math.max(0, (scaledW - containerW) / 2);
    const maxY = Math.max(0, (scaledH - containerH) / 2);
    const newTX = Math.max(-maxX, Math.min(maxX, translateX.value));
    const newTY = Math.max(-maxY, Math.min(maxY, translateY.value));
    scale.value = withSpring(newScale, { damping: 18, stiffness: 200 });
    translateX.value = withSpring(newTX, { damping: 18, stiffness: 200 });
    translateY.value = withSpring(newTY, { damping: 18, stiffness: 200 });
    savedScale.value = newScale;
    savedTX.value = newTX;
    savedTY.value = newTY;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svgRenderW, svgRenderH, containerW, containerH]);

  const handleZoomIn = useCallback(() => {
    applyZoom(scale.value * 1.5);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyZoom]);

  const handleZoomOut = useCallback(() => {
    applyZoom(scale.value / 1.5);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyZoom]);

  const handleFitScreen = useCallback(() => {
    scale.value = withSpring(1, { damping: 18, stiffness: 200 });
    translateX.value = withSpring(0, { damping: 18, stiffness: 200 });
    translateY.value = withSpring(0, { damping: 18, stiffness: 200 });
    savedScale.value = 1;
    savedTX.value = 0;
    savedTY.value = 0;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

      if (cycleMode) {
        const isCounted = countedZoneIds?.has(zone.id) ?? false;
        const fillColor = isCounted ? "#22c55ecc" : colors.primary + "18";
        const strokeColor = isCounted ? "#16a34a" : colors.primary + "50";
        const strokeWidth = isCounted ? 10 : 4;
        const labelColor = isCounted ? "#fff" : colors.primary + "80";
        return (
          <G
            key={zone.id}
            onLongPress={(!cycleLocked && isActive) ? () => onZoneLongPress?.(zone) : undefined}
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
      }

      const ZONE_GAP = 5;
      const fillColor = isActive ? "rgba(0, 112, 255, 0.14)" : "rgba(0, 112, 255, 0.06)";
      const strokeColor = "#0070ff";
      const strokeWidth = isActive ? 8 : 4;
      const labelColor = "#0070ff";

      return (
        <G
          key={zone.id}
          onPress={isActive ? () => onZoneTap(zone) : undefined}
          onLongPress={isActive ? () => onZoneLongPress?.(zone) : undefined}
          delayLongPress={400}
        >
          <Rect
            x={zone.svgX + ZONE_GAP}
            y={zone.svgY + ZONE_GAP}
            width={zone.svgWidth - ZONE_GAP * 2}
            height={zone.svgHeight - ZONE_GAP * 2}
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
  }, [zones, colors, onZoneTap, onZoneLongPress, cycleMode, cycleLocked, countedZoneIds]);

  // ── Early return before layout ─────────────────────────────────────────────
  if (containerW === 0) {
    return <View style={styles.fill} onLayout={onLayout} />;
  }

  return (
    <View style={styles.fill} onLayout={onLayout}>
      <GestureDetector gesture={mainGesture}>
        <Animated.View style={animatedStyle}>
          {/* Base floor plan SVG — dark mode: invert + darken for readable contrast */}
          {(svgUri || svgXml) ? (
            <View
              style={[
                { width: svgRenderW, height: svgRenderH },
                isDark && styles.svgDarkFilter,
              ]}
            >
              {svgXml ? (
                <SvgXml xml={svgXml} width={svgRenderW} height={svgRenderH} />
              ) : (
                <SvgUri uri={svgUri} width={svgRenderW} height={svgRenderH} />
              )}
            </View>
          ) : !svgLoading ? (
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
          ) : (
            <View style={{ width: svgRenderW, height: svgRenderH }} />
          )}

          {/* Skeleton placeholder — visible while SVG is fetching, fades out on load */}
          {skeletonMounted && (
            <Animated.View
              style={[
                StyleSheet.absoluteFill,
                { width: svgRenderW, height: svgRenderH, pointerEvents: "none" },
                skeletonStyle,
              ]}
            >
              <View
                style={[
                  styles.skeletonBase,
                  { backgroundColor: isDark ? "#2a2a2e" : "#e8e8ec" },
                ]}
              >
                {/* Sheen strip that pulses to simulate a shimmer */}
                <Animated.View
                  style={[
                    styles.skeletonSheen,
                    { backgroundColor: isDark ? "#3a3a40" : "#f0f0f4" },
                    shimmerStyle,
                  ]}
                />
                {/* Faint grid lines to hint at a floor-plan structure */}
                <View style={[styles.skeletonGrid, { pointerEvents: "none" }]}>
                  {[0.2, 0.4, 0.6, 0.8].map((frac) => (
                    <View
                      key={frac}
                      style={[
                        styles.skeletonGridLine,
                        {
                          top: `${frac * 100}%` as unknown as number,
                          backgroundColor: isDark ? "#ffffff10" : "#00000008",
                        },
                      ]}
                    />
                  ))}
                  {[0.25, 0.5, 0.75].map((frac) => (
                    <View
                      key={frac}
                      style={[
                        styles.skeletonGridLineV,
                        {
                          left: `${frac * 100}%` as unknown as number,
                          backgroundColor: isDark ? "#ffffff10" : "#00000008",
                        },
                      ]}
                    />
                  ))}
                </View>
              </View>
            </Animated.View>
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
          style={[styles.floatingBadge, { backgroundColor: colors.card, pointerEvents: "none" }]}
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

      {/* Empty state: no zones defined yet — auto-hides after 3 s */}
      {!zonesLoading && !zonesError && zones.length === 0 && !emptyDismissed && (
        <View style={[styles.emptyOverlay, { pointerEvents: "none" }]}>
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

      {/* Zoom controls — bottom-right cluster: + on top, − below, fit at bottom */}
      <View style={styles.zoomControls}>
        <Pressable
          onPress={handleZoomIn}
          style={({ pressed }) => [
            styles.zoomBtn,
            styles.zoomBtnTop,
            { backgroundColor: colors.card, borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
          ]}
          accessibilityLabel="Zoom in"
        >
          <Feather name="plus" size={16} color={colors.foreground} />
        </Pressable>
        <Pressable
          onPress={handleZoomOut}
          style={({ pressed }) => [
            styles.zoomBtn,
            styles.zoomBtnMid,
            { backgroundColor: colors.card, borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
          ]}
          accessibilityLabel="Zoom out"
        >
          <Feather name="minus" size={16} color={colors.foreground} />
        </Pressable>
        <Pressable
          onPress={handleFitScreen}
          style={({ pressed }) => [
            styles.zoomBtn,
            styles.zoomBtnBottom,
            { backgroundColor: colors.card, borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
          ]}
          accessibilityLabel="Fit to screen"
        >
          <Feather name="maximize" size={14} color={colors.mutedForeground} />
        </Pressable>
      </View>

      {/* Hint: double-tap to reset zoom / cycle layer instructions */}
      <View
        style={[
          styles.hintBadge,
          { backgroundColor: colors.card + "cc", borderColor: colors.border, pointerEvents: "none" },
        ]}
      >
        <Text style={[styles.hintText, { color: colors.mutedForeground }]}>
          {cycleMode
            ? cycleLocked
              ? "Cycle layer — locked"
              : "Long-press a zone to mark counted"
            : "Pinch/drag to pan · Double-tap to reset"}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, overflow: "hidden", justifyContent: "center" },
  svgFallback: { alignItems: "center", justifyContent: "center" },
  // Invert + slight brightness reduction for dark-mode floor plan legibility.
  // filter is supported in RN 0.76+ (Expo SDK 52+); type augmented in
  // artifacts/parts-id/types/react-native-filter.d.ts
  svgDarkFilter: {
    filter: [{ invert: 1 }, { brightness: 0.88 }],
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
  zoomControls: {
    position: "absolute",
    right: 12,
    bottom: 96,
    borderRadius: 8,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 4,
    elevation: 3,
  },
  zoomBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  zoomBtnTop: {
    borderBottomWidth: 0,
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
  },
  zoomBtnMid: {
    borderBottomWidth: 0,
  },
  zoomBtnBottom: {
    borderBottomLeftRadius: 8,
    borderBottomRightRadius: 8,
  },
  skeletonBase: {
    flex: 1,
    overflow: "hidden",
  },
  skeletonSheen: {
    ...StyleSheet.absoluteFillObject,
  },
  skeletonGrid: {
    ...StyleSheet.absoluteFillObject,
  },
  skeletonGridLine: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 1,
  },
  skeletonGridLineV: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 1,
  },
});
