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
 *
 * Floor-plan rendering strategy (crisp at any zoom level):
 *   Web    — The fetched SVG XML is stripped of its outer <svg> wrapper and the
 *            inner content is injected via dangerouslySetInnerHTML into a <g>
 *            element that lives inside the zone-overlay <Svg>.  Both the floor
 *            plan and the zone rectangles therefore share one SVG viewport;
 *            no separate CSS-scaled layer exists, so there is no rasterisation
 *            blur however far the user zooms in.
 *   Native — <SvgUri> is rendered at the SVG's natural viewBox dimensions
 *            (SVG_VIEWBOX_W × SVG_VIEWBOX_H) via an overscale wrapper, then a
 *            compensating scale-down transform brings it back to screen size at
 *            zoom level 1.  When the user zooms in the raster already has
 *            sufficient pixels so the platform compositor never has to upscale
 *            a low-resolution texture — no blur at any zoom level up to MAX_SCALE.
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
import {
  getCachedData,
  getIfValid,
  hasCachedData,
  initPersistRead,
  setCached,
  setFallbackEmpty,
  type SvgData,
} from "@/utils/floorPlanCache";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { Svg, Rect, G, Text as SvgText, SvgUri } from "react-native-svg";
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

// ── Module-level SVG cache ────────────────────────────────────────────────────
// Managed by utils/floorPlanCache (two-tier: in-memory + AsyncStorage).
// Kick off the AsyncStorage read immediately at module load so the data is
// typically ready before the first component mount.
const _persistReadPromise = initPersistRead();

// Single in-flight asset-load promise so concurrent mounts don't issue
// duplicate network requests.
let _svgLoadPromise: Promise<void> | null = null;

// Base URL for API calls — matches the pattern used elsewhere in the app.
const SVG_API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : "";

export function prefetchSvgAsset(): Promise<void> {
  if (hasCachedData()) return Promise.resolve();
  return loadSvgAsset();
}

/**
 * Load the floor plan SVG: try the server first (admin-uploadable), fall back
 * to the bundled asset, and finally set an empty fallback if both fail.
 * Uses hash-based cache invalidation so cold-start renders skip network.
 */
function loadSvgAsset(): Promise<void> {
  if (_svgLoadPromise) return _svgLoadPromise;
  _svgLoadPromise = _loadFloorPlanFromServer()
    .catch(() => _loadFloorPlanFromBundle())
    .catch(() => { setFallbackEmpty(); });
  return _svgLoadPromise;
}

async function _loadFloorPlanFromServer(): Promise<void> {
  const metaRes = await fetch(`${SVG_API_BASE}/floor-plan/meta`);
  if (!metaRes.ok) throw new Error("no server floor plan");

  const { hash } = await metaRes.json() as { hash: string };
  // Cache hit — skip re-fetching the SVG bytes entirely.
  if (getIfValid(hash) !== null) return;

  const svgRes = await fetch(`${SVG_API_BASE}/floor-plan/svg`);
  if (!svgRes.ok) throw new Error("floor-plan svg fetch failed");
  const xml = await svgRes.text();

  let newData: SvgData;
  if (Platform.OS === "web") {
    // Strip the outer <svg> wrapper so the content can be embedded
    // directly inside the main SVG canvas as a child <g> element.
    const innerXml = xml
      .replace(/^[\s\S]*?<svg[^>]*>/, "")
      .replace(/<\/svg>\s*$/, "");
    newData = { xml, innerXml, uri: "" };
  } else {
    // On native, SvgUri can render directly from an http:// URL.
    newData = { xml, innerXml: "", uri: `${SVG_API_BASE}/floor-plan/svg` };
  }
  setCached(hash, newData);
}

async function _loadFloorPlanFromBundle(): Promise<void> {
  const [asset] = await Asset.loadAsync(
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("../assets/warehouse-map.svg"),
  );
  const currentHash = asset.hash ?? "";
  // Cache hit — persisted hash matches; skip the URI fetch entirely.
  if (getIfValid(currentHash) !== null) return;

  const uri = asset.localUri ?? asset.uri ?? "";
  let newData: SvgData;
  if (Platform.OS === "web") {
    const res = await fetch(uri);
    const xml = await res.text();
    // Strip the outer <svg> wrapper so the content can be embedded
    // directly inside the main SVG canvas as a child <g> element.
    // This matches the approach used in the Zone Editor and keeps the
    // floor plan and zone overlays in the same SVG viewport, eliminating
    // any CSS-transform rasterisation blur at high zoom levels.
    const innerXml = xml
      .replace(/^[\s\S]*?<svg[^>]*>/, "")
      .replace(/<\/svg>\s*$/, "");
    newData = { xml, innerXml, uri: "" };
  } else {
    newData = { xml: "", innerXml: "", uri };
  }
  // Write to both in-memory cache and AsyncStorage so the next cold start
  // skips the network fetch.  Also updates the stored hash so subsequent
  // getIfValid calls are correct.
  setCached(currentHash, newData);
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
  "use no memo";
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
  //
  // Web path  — fetches the SVG text, strips the outer <svg> wrapper, and
  //             stores the inner content via floorPlanCache.  The content is
  //             injected via dangerouslySetInnerHTML into a <g> element inside
  //             the main SVG canvas so everything shares one viewport.
  // Native path — stores only the local file URI; <SvgUri> reads it directly.
  //
  // getCachedData() reads the module-level cache in utils/floorPlanCache.
  // On repeat tab visits within the same session it is already populated so
  // state initialises with cached values and svgLoading starts as false —
  // no skeleton, no fetch.
  const [svgUri, setSvgUri] = useState(() => getCachedData()?.uri ?? "");
  const [innerXml, setInnerXml] = useState(() => getCachedData()?.innerXml ?? "");
  const [svgLoading, setSvgLoading] = useState(() => !hasCachedData());
  useEffect(() => {
    if (hasCachedData()) return; // already cached (in-memory) — nothing to do

    (async () => {
      // Wait for the AsyncStorage read that was kicked off at module load.
      // For returning users this is typically already resolved by the time
      // the component mounts, so it costs at most one microtick.
      await _persistReadPromise;

      // getCachedData() returns SvgData | null — no cast needed here since it
      // is a function call (TypeScript narrows const locals correctly).
      const afterPersist = getCachedData();
      if (afterPersist !== null) {
        // Persisted data available — update state right away so the skeleton
        // never appears for returning users.
        setSvgUri(afterPersist.uri);
        setInnerXml(afterPersist.innerXml);
        setSvgLoading(false);
      }

      // Resolve the asset and validate the hash.  If the hash matches the
      // persisted entry, loadSvgAsset() returns after Asset.loadAsync with
      // no network fetch.  If the hash has changed (new build), it re-fetches
      // and writes the updated entry back to AsyncStorage.
      await loadSvgAsset();
      const afterLoad = getCachedData();
      if (afterLoad) {
        setSvgUri(afterLoad.uri);
        setInnerXml(afterLoad.innerXml);
      }
      setSvgLoading(false);
    })();
  }, []);

  // Skeleton shimmer — pulsing opacity while SVG is fetching.
  // Starts unmounted when the cache is already populated so there is no
  // visible skeleton flash on repeat visits.
  const [skeletonMounted, setSkeletonMounted] = useState(() => !hasCachedData());
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
      const labelColor = "#000000";

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
      <View style={styles.mapCenter}>
      <GestureDetector gesture={mainGesture}>
        <Animated.View style={animatedStyle}>
          {/* ── Native floor plan layer ──────────────────────────────────────
              On web the floor plan is embedded inside the SVG canvas below so
              that both layers share one SVG viewport (no separate CSS-scaled
              div, therefore no rasterisation blur at any zoom level).
              On native, <SvgUri> is rendered at the SVG's natural viewBox
              dimensions (SVG_VIEWBOX_W × SVG_VIEWBOX_H) and a compensating
              scale-down transform brings it back to screen size.  The
              platform rasterises at full viewBox resolution, so when the
              user zooms in there is always enough pixel density — no blur. */}
          {Platform.OS !== "web" ? (
            svgUri ? (
              // Outer view establishes the layout footprint (screen-width × proportional height).
              // Inner view is rendered at the SVG's natural dimensions then scaled down
              // so that at zoom=1 it looks identical to a screen-width render, but the
              // raster has enough pixels to stay crisp at any zoom up to MAX_SCALE.
              <View style={{ width: svgRenderW, height: svgRenderH }}>
                <View
                  style={[
                    {
                      position: "absolute",
                      width: SVG_VIEWBOX_W,
                      height: SVG_VIEWBOX_H,
                      // Scale around the view's center (RN default origin).
                      // The center of this overscale view in parent coords is
                      // (SVG_VIEWBOX_W/2, SVG_VIEWBOX_H/2).  After scaling by
                      // s = svgRenderW/SVG_VIEWBOX_W the visual size is svgRenderW,
                      // but the visual left edge lands at SVG_VIEWBOX_W/2 - svgRenderW/2.
                      // The leading translateX/Y corrects that offset so the visual
                      // top-left aligns with the parent's top-left corner.
                      transform: [
                        { translateX: (svgRenderW - SVG_VIEWBOX_W) / 2 },
                        { translateY: (svgRenderH - SVG_VIEWBOX_H) / 2 },
                        { scale: svgRenderW / SVG_VIEWBOX_W },
                      ],
                    },
                    isDark && styles.svgDarkFilter,
                  ]}
                >
                  <SvgUri uri={svgUri} width={SVG_VIEWBOX_W} height={SVG_VIEWBOX_H} />
                </View>
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
            )
          ) : (
            /* Web: no separate floor plan div — floor plan is inside the SVG
               below.  Show "Map unavailable" only if the fetch failed. */
            !svgLoading && !innerXml ? (
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
            )
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

          {/* Zone overlay SVG — shares the same viewBox as the floor plan so
              zone coordinates align exactly.
              On web: the floor plan inner content is embedded here as the first
              child <g> element (dangerouslySetInnerHTML), keeping floor plan
              and zones in one SVG viewport for crisp rendering at any zoom.
              On native: the zone rects are layered on top of the <SvgUri>
              rendered above via absoluteFill. */}
          <Svg
            style={StyleSheet.absoluteFill}
            viewBox={`0 0 ${SVG_VIEWBOX_W} ${SVG_VIEWBOX_H}`}
            width={svgRenderW}
            height={svgRenderH}
          >
            {Platform.OS === "web" && innerXml
              ? React.createElement(
                  "g" as unknown as React.ElementType,
                  {
                    dangerouslySetInnerHTML: { __html: innerXml },
                    ...(isDark && { style: { filter: "invert(1) brightness(0.88)" } }),
                  },
                )
              : null}
            {zoneOverlays}
          </Svg>
        </Animated.View>
      </GestureDetector>
      </View>

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
  fill: { flex: 1, overflow: "hidden" },
  mapCenter: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
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
