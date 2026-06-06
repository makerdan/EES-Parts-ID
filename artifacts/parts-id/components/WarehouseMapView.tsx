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
 *   Native — Adaptive tiling: the floor plan is split into numTiles×numTiles
 *            tiles where numTiles = ceil(zoom).  Each tile renders
 *            svgRenderW×svgRenderH pt of SvgXml with a viewBox cropped to its
 *            1/N × 1/N fraction of the floor plan, so the rasteriser produces
 *            exactly the resolution the compositor needs — quality ratio N/Z
 *            always equals 1.  Only the tiles that overlap the current pan/
 *            zoom viewport (plus a 1-tile buffer) are instantiated, so memory
 *            stays constant regardless of zoom level.  A centred absolute-
 *            position + transform:scale(1/N) maps each tile's layout area to
 *            its correct visual slot in the floor plan.  Falls back to a single
 *            oversample SvgUri when the SVG XML is not yet available.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  LayoutChangeEvent,
  PixelRatio,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Feather } from "@expo/vector-icons";
import { Asset } from "expo-asset";
import {
  getCachedData,
  getIfValid,
  hasCachedData,
  initPersistRead,
  setCached,
  setFallbackEmpty,
  type SvgContentViewBox,
  type SvgData,
} from "@/utils/floorPlanCache";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { Svg, Rect, G, Text as SvgText, SvgUri, SvgXml } from "react-native-svg";

import { useColors } from "@/hooks/useColors";
import type { ApiWarehouseZone } from "@/hooks/useWarehouseZones";

// Must match the viewBox attribute of the floor-plan SVG served by /api/floor-plan/svg.
// Run: curl .../api/floor-plan/svg | grep -oP 'viewBox="[^"]+"' | head -1
const SVG_VIEWBOX_W = 7329.6001;
const SVG_VIEWBOX_H = 4997.2798;
const SVG_ASPECT = SVG_VIEWBOX_W / SVG_VIEWBOX_H;

const MIN_SCALE = 0.8;
const MAX_SCALE = 50;

const VIEWPORT_KEY = "@rdc34/warehouse_map_viewport_v2";

// Conservative iOS Metal GPU texture limit in physical pixels.
// Exceeding this causes patchwork tiles; keep high-res renders below it.
const IOS_MAX_TEXTURE_PX = 8192;

// Standalone worklet — no closure over JS values
function clamp(val: number, min: number, max: number) {
  "worklet";
  return val < min ? min : val > max ? max : val;
}

// Re-export SvgContentViewBox as ContentViewBox for internal use in this module.
type ContentViewBox = SvgContentViewBox;

const FIT_PADDING = 16;

/**
 * Parse the `viewBox="x y w h"` attribute from an SVG XML string.
 * Returns null when the attribute is absent or malformed.
 */
function parseContentViewBox(xml: string): ContentViewBox | null {
  const match = xml.match(/viewBox="([^"]+)"/);
  if (!match) return null;
  const parts = match[1].trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !isFinite(n))) return null;
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

/**
 * Compute a "fit to content" viewport that centres the content rect inside the
 * container using a meet-style scale with FIT_PADDING on every side.
 *
 * The SVG render area is svgRenderW × svgRenderH (= containerW × containerW/aspect)
 * and is centred in the container.  The Animated.View transform is
 *   [translateX, translateY, scale]
 * where scale pivots around the view centre, then the translation shifts it.
 * So the content centre in screen space = containerCentre + (tx, ty) + (dx, dy)*s
 * where dx/dy is the content-centre offset from the SVG render-area centre.
 * Setting that to zero gives tx = -dx*s, ty = -dy*s.
 */
function fitContentViewport(
  contentVB: ContentViewBox,
  containerW: number,
  containerH: number,
  svgVBW: number,
  svgVBH: number,
): { scale: number; tx: number; ty: number } {
  const svgRenderW = containerW;
  const svgRenderH = containerW / (svgVBW / svgVBH);
  const pixelW = (contentVB.w / svgVBW) * svgRenderW;
  const pixelH = (contentVB.h / svgVBH) * svgRenderH;
  const availW = containerW - FIT_PADDING * 2;
  const availH = containerH - FIT_PADDING * 2;
  const rawScale = Math.min(availW / pixelW, availH / pixelH);
  const fittedScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, rawScale));
  const contentCenterX = ((contentVB.x + contentVB.w / 2) / svgVBW) * svgRenderW;
  const contentCenterY = ((contentVB.y + contentVB.h / 2) / svgVBH) * svgRenderH;
  const dx = contentCenterX - svgRenderW / 2;
  const dy = contentCenterY - svgRenderH / 2;
  // Do NOT clamp to pan bounds here.  The centering translation is geometrically
  // correct: it moves exactly the content-centre to the container-centre.
  // Pan bounds (maxX/maxY) are derived from the full SVG render area, which is
  // often larger than the container in X but smaller in Y (letterboxed portrait).
  // Clamping ty to maxY=0 in the letterboxed case would leave the content
  // off-centre — the opposite of what this function is meant to achieve.
  // The gesture handlers apply their own per-axis clamping during user interaction.
  return { scale: fittedScale, tx: -dx * fittedScale, ty: -dy * fittedScale };
}

// Animated wrappers for SVG primitives — lets useAnimatedProps drive
// strokeWidth and fontSize on the UI thread with zero JS re-renders.
const AnimatedRect = Animated.createAnimatedComponent(Rect);
const AnimatedSvgText = Animated.createAnimatedComponent(SvgText);

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

  const contentViewBox = parseContentViewBox(xml) ?? undefined;
  let newData: SvgData;
  if (Platform.OS === "web") {
    // Strip the outer <svg> wrapper so the content can be embedded
    // directly inside the main SVG canvas as a child <g> element.
    const innerXml = xml
      .replace(/^[\s\S]*?<svg[^>]*>/, "")
      .replace(/<\/svg>\s*$/, "");
    newData = { xml, innerXml, uri: "", contentViewBox };
  } else {
    // On native, SvgUri can render directly from an http:// URL.
    newData = { xml, innerXml: "", uri: `${SVG_API_BASE}/floor-plan/svg`, contentViewBox };
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
    newData = { xml, innerXml, uri: "", contentViewBox: parseContentViewBox(xml) ?? undefined };
  } else {
    // Fetch the SVG text so the tile renderer can use SvgXml with per-tile
    // viewBox crops at high zoom.  This is a local-file read so it is fast.
    const res = await fetch(uri);
    const xml = res.ok ? await res.text() : "";
    newData = { xml, innerXml: "", uri, contentViewBox: parseContentViewBox(xml) ?? undefined };
  }
  // Write to both in-memory cache and AsyncStorage so the next cold start
  // skips the network fetch.  Also updates the stored hash so subsequent
  // getIfValid calls are correct.
  setCached(currentHash, newData);
}


// ── Per-zone overlay element ──────────────────────────────────────────────────
// Isolated into its own component so useAnimatedProps (which must be called
// unconditionally at the top of a component) can legally be called once per
// zone.  strokeWidth and fontSize are driven on the UI thread via
// useAnimatedProps — zero JS re-renders occur during pinch or spring animations.
// Zone geometry (x/y/w/h) remains static; only visual-weight properties animate.
interface ZoneOverlayItemProps {
  zone: ApiWarehouseZone;
  scale: SharedValue<number>;
  colors: ReturnType<typeof useColors>;
  onZoneTap: (zone: ApiWarehouseZone) => void;
  onZoneLongPress?: (zone: ApiWarehouseZone) => void;
  cycleMode: boolean;
  cycleLocked: boolean;
  isCounted: boolean;
}

function ZoneOverlayItem({
  zone,
  scale,
  colors,
  onZoneTap,
  onZoneLongPress,
  cycleMode,
  cycleLocked,
  isCounted,
}: ZoneOverlayItemProps) {
  const isActive = zone.isInventory;
  const baseFontSize = Math.max(24, Math.min(48, zone.svgHeight / 3));

  // Baseline stroke widths at scale=1; divide by scale.value to keep visual weight constant.
  const baseStroke = cycleMode ? (isCounted ? 10 : 4) : (isActive ? 8 : 4);

  const rectAnimatedProps = useAnimatedProps(() => ({
    strokeWidth: baseStroke / scale.value,
  }));

  const textAnimatedProps = useAnimatedProps(() => ({
    fontSize: baseFontSize / scale.value,
  }));

  if (cycleMode) {
    const fillColor = isCounted ? "#22c55ecc" : colors.primary + "18";
    const strokeColor = isCounted ? "#16a34a" : colors.primary + "50";
    const labelColor = isCounted ? "#fff" : colors.primary + "80";
    return (
      <G
        {...(Platform.OS !== "web" && (!cycleLocked && isActive) && {
          onLongPress: () => onZoneLongPress?.(zone),
          delayLongPress: 400,
        })}
      >
        <AnimatedRect
          x={zone.svgX}
          y={zone.svgY}
          width={zone.svgWidth}
          height={zone.svgHeight}
          fill={fillColor}
          stroke={strokeColor}
          animatedProps={rectAnimatedProps}
        />
        <AnimatedSvgText
          x={zone.svgX + zone.svgWidth / 2}
          y={zone.svgY + zone.svgHeight / 2}
          fontWeight="bold"
          fill={labelColor}
          textAnchor="middle"
          alignmentBaseline="middle"
          animatedProps={textAnimatedProps}
        >
          {zone.label}
        </AnimatedSvgText>
      </G>
    );
  }

  const ZONE_GAP = 5;
  const fillColor = isActive ? "rgba(0, 112, 255, 0.14)" : "rgba(0, 112, 255, 0.06)";
  const strokeColor = "#0070ff";
  const labelColor = "#000000";

  return (
    <G
      {...(Platform.OS === "web"
        ? (isActive ? { onClick: () => onZoneTap(zone) } : undefined)
        : {
            onPress: isActive ? () => onZoneTap(zone) : undefined,
            onLongPress: isActive ? () => onZoneLongPress?.(zone) : undefined,
            delayLongPress: 400,
          }
      )}
    >
      <AnimatedRect
        x={zone.svgX + ZONE_GAP}
        y={zone.svgY + ZONE_GAP}
        width={zone.svgWidth - ZONE_GAP * 2}
        height={zone.svgHeight - ZONE_GAP * 2}
        fill={fillColor}
        stroke={strokeColor}
        strokeDasharray={isActive ? undefined : "20 10"}
        animatedProps={rectAnimatedProps}
      />
      <AnimatedSvgText
        x={zone.svgX + zone.svgWidth / 2}
        y={zone.svgY + zone.svgHeight / 2}
        fontWeight="bold"
        fill={labelColor}
        textAnchor="middle"
        alignmentBaseline="middle"
        animatedProps={textAnimatedProps}
      >
        {zone.label}
      </AnimatedSvgText>
    </G>
  );
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

  // Track whether the first layout pass has occurred so we can skip the pan
  // clamp on initial mount.  The clamp is only meaningful after a rotation
  // (when the container dimensions actually change), not on the first call
  // when every value is coming from 0 — clamping there can incorrectly snap
  // the map when the device starts in landscape (svgRenderH < containerH
  // makes maxY=0 and immediately forces translateY to 0).
  const hasLaidOut = useRef(false);

  // Mirror container dimensions in refs so async callbacks (e.g. the viewport
  // restore useEffect) always read the latest values without closing over stale
  // JS state snapshots.
  const containerWRef = useRef(0);
  const containerHRef = useRef(0);

  // Viewport restore values that arrived from AsyncStorage before the first
  // layout pass completed.  onLayout drains this on its first call so the
  // tx/ty are always clamped to the real container bounds, regardless of
  // whether layout or the storage read wins the race.
  const pendingRestore = useRef<{ s: number; tx: number; ty: number } | null>(null);

  // Parsed content viewBox from the SVG XML — the tightly cropped bounding
  // box of the actual warehouse drawing within the full 3592×2457 coordinate
  // space.  Initialised synchronously from the cache when data is available;
  // the cache stores the parsed value alongside the XML so no re-parse is
  // needed on repeat cold-starts.
  const [contentVB, setContentVB] = useState<ContentViewBox | null>(
    () => getCachedData()?.contentViewBox ?? null,
  );
  const contentVBRef = useRef<ContentViewBox | null>(contentVB);

  // True when we need to apply a fit-to-content viewport as soon as both the
  // container dimensions and the content viewBox are known.  Set when the
  // AsyncStorage read returns null (no saved viewport).
  const pendingFit = useRef(false);

  // Indirection ref so onLayout (declared before the shared values) can call
  // applyFitIfReady (which needs the shared values) without a forward-reference
  // TypeScript error.  Assigned during each render before the first layout fires.
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  const applyFitIfReadyRef = useRef<() => void>(() => {});

  const onLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const { width, height } = e.nativeEvent.layout;
      const rh = width > 0 ? width / SVG_ASPECT : 0;

      // Capture the previous container width BEFORE overwriting the ref so we
      // can compute the correct translation to keep the same floor-plan point
      // centred after a device rotation.
      const prevW = containerWRef.current;

      setContainerW(width);
      setContainerH(height);
      containerWV.value = width;
      containerHV.value = height;
      containerWRef.current = width;
      containerHRef.current = height;

      if (!hasLaidOut.current) {
        hasLaidOut.current = true;

        // If the AsyncStorage restore already ran while we were still at size 0,
        // its tx/ty were saved unclamped in pendingRestore.  Apply them now that
        // we have real dimensions so portrait-saved offsets don't bleed into a
        // landscape session (and vice versa).
        const pending = pendingRestore.current;
        if (pending !== null) {
          pendingRestore.current = null;
          const scaledW = width * pending.s;
          const scaledH = rh * pending.s;
          const maxX = Math.max(0, (scaledW - width) / 2);
          const maxY = Math.max(0, (scaledH - height) / 2);
          const clampedTX = Math.max(-maxX, Math.min(maxX, pending.tx));
          const clampedTY = Math.max(-maxY, Math.min(maxY, pending.ty));
          translateX.value = clampedTX;
          translateY.value = clampedTY;
          savedTX.value = clampedTX;
          savedTY.value = clampedTY;
        } else {
          // No saved viewport — try to apply the fit-to-content position now
          // that we have real container dimensions.
          applyFitIfReadyRef.current();
        }
        return;
      }

      // After rotation the container dimensions change.  The floor plan is
      // always rendered at containerW × (containerW / SVG_ASPECT), so both
      // axes scale by the same ratio newW / oldW.  Multiplying the saved
      // translation by this ratio maps the previously centred floor-plan point
      // to exactly the same screen position in the new orientation.  We then
      // clamp to the new bounds (so the map never goes off-screen) and animate
      // the correction with a spring for a smooth, context-preserving feel.
      //
      // Why this works — the visible floor-plan centre in normalised [0,1]
      // coordinates is: (0.5 − tx / (Z × W)).  To keep the same normalised
      // centre after the resize:
      //   tx_new = tx_old × (W_new / W_old)
      // Both axes share the same ratio because H = W / SVG_ASPECT.
      const currentScale = savedScale.value;
      const sizeRatio = prevW > 0 ? width / prevW : 1;
      const centredTX = savedTX.value * sizeRatio;
      const centredTY = savedTY.value * sizeRatio;

      const scaledW = width * currentScale;
      const scaledH = rh * currentScale;
      const maxX = Math.max(0, (scaledW - width) / 2);
      const maxY = Math.max(0, (scaledH - height) / 2);
      const newTX = clamp(centredTX, -maxX, maxX);
      const newTY = clamp(centredTY, -maxY, maxY);
      translateX.value = withSpring(newTX, { damping: 18, stiffness: 200 });
      translateY.value = withSpring(newTY, { damping: 18, stiffness: 200 });
      savedTX.value = newTX;
      savedTY.value = newTY;
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

  // ── Viewport persistence (AsyncStorage) ────────────────────────────────────
  // Restore the saved viewport once on mount, before the first layout clamp
  // runs, so the user resumes exactly where they left off.
  const _persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persistViewport = useCallback((s: number, tx: number, ty: number) => {
    if (_persistTimer.current !== null) clearTimeout(_persistTimer.current);
    _persistTimer.current = setTimeout(() => {
      AsyncStorage.setItem(VIEWPORT_KEY, JSON.stringify({ s, tx, ty })).catch(() => {});
    }, 300);
  }, []);

  // ── Fit-to-content helpers ─────────────────────────────────────────────────
  // Declared after persistViewport so applyFit can reference it without
  // triggering the temporal dead zone.

  /**
   * Apply the fit viewport immediately (no animation) if pendingFit is set and
   * both the container dimensions and the parsed content viewBox are available.
   * Called from onLayout (first call) and from the svgXml-parse effect.
   */
  const applyFitIfReady = useCallback(() => {
    if (!pendingFit.current) return;
    const vb = contentVBRef.current;
    const w = containerWRef.current;
    const h = containerHRef.current;
    if (!vb || w === 0) return;
    pendingFit.current = false;
    const { scale: s, tx, ty } = fitContentViewport(vb, w, h, SVG_VIEWBOX_W, SVG_VIEWBOX_H);
    scale.value = s;
    savedScale.value = s;
    translateX.value = tx;
    translateY.value = ty;
    savedTX.value = tx;
    savedTY.value = ty;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the indirection ref current so onLayout always calls the latest version.
  applyFitIfReadyRef.current = applyFitIfReady;

  /**
   * Animate to the fit-to-content viewport.  Falls back to scale=1/tx=0/ty=0
   * if the SVG viewBox has not been parsed yet.  Used by the Fit button and the
   * double-tap-to-reset gesture.
   */
  const applyFit = useCallback(() => {
    const vb = contentVBRef.current;
    const w = containerWRef.current;
    const h = containerHRef.current;
    if (!vb || w === 0) {
      scale.value = withSpring(1, { damping: 18, stiffness: 200 });
      translateX.value = withSpring(0, { damping: 18, stiffness: 200 });
      translateY.value = withSpring(0, { damping: 18, stiffness: 200 });
      savedScale.value = 1;
      savedTX.value = 0;
      savedTY.value = 0;
      persistViewport(1, 0, 0);
      return;
    }
    const { scale: s, tx, ty } = fitContentViewport(vb, w, h, SVG_VIEWBOX_W, SVG_VIEWBOX_H);
    scale.value = withSpring(s, { damping: 18, stiffness: 200 });
    translateX.value = withSpring(tx, { damping: 18, stiffness: 200 });
    translateY.value = withSpring(ty, { damping: 18, stiffness: 200 });
    savedScale.value = s;
    savedTX.value = tx;
    savedTY.value = ty;
    persistViewport(s, tx, ty);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistViewport]);

  // Flush any pending debounced write and cancel the timer on unmount so a
  // stale timeout never fires against an unmounted component.
  useEffect(() => {
    return () => {
      if (_persistTimer.current !== null) {
        clearTimeout(_persistTimer.current);
        _persistTimer.current = null;
        // Immediate flush: write the latest saved values synchronously so
        // the last viewport is not lost if the tab is closed mid-debounce.
        AsyncStorage.setItem(
          VIEWPORT_KEY,
          JSON.stringify({ s: savedScale.value, tx: savedTX.value, ty: savedTY.value }),
        ).catch(() => {});
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    AsyncStorage.getItem(VIEWPORT_KEY)
      .then((raw) => {
        if (!raw) {
          // No saved viewport — signal that a fit-to-content position should
          // be applied as soon as both the container and the SVG viewBox are
          // ready.  applyFitIfReady() checks both conditions.
          pendingFit.current = true;
          applyFitIfReadyRef.current();
          return;
        }
        try {
          const { s, tx, ty } = JSON.parse(raw) as { s: number; tx: number; ty: number };
          if (
            typeof s === "number" && isFinite(s) &&
            typeof tx === "number" && isFinite(tx) &&
            typeof ty === "number" && isFinite(ty)
          ) {
            const clampedS = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
            scale.value = clampedS;
            savedScale.value = clampedS;

            // Always clamp tx/ty to the bounds that match the current container
            // dimensions so a portrait-saved viewport doesn't bleed off-screen
            // when the device is reopened in landscape (and vice versa).
            const w = containerWRef.current;
            const h = containerHRef.current;
            if (w > 0) {
              // Layout has already fired — we have real dimensions.
              const rh = w / SVG_ASPECT;
              const scaledW = w * clampedS;
              const scaledH = rh * clampedS;
              const maxX = Math.max(0, (scaledW - w) / 2);
              const maxY = Math.max(0, (scaledH - h) / 2);
              const clampedTX = Math.max(-maxX, Math.min(maxX, tx));
              const clampedTY = Math.max(-maxY, Math.min(maxY, ty));
              translateX.value = clampedTX;
              translateY.value = clampedTY;
              savedTX.value = clampedTX;
              savedTY.value = clampedTY;
            } else {
              // Layout hasn't fired yet — stash the raw values; onLayout will
              // clamp and apply them once real dimensions are known.
              pendingRestore.current = { s: clampedS, tx, ty };
              translateX.value = tx;
              translateY.value = ty;
              savedTX.value = tx;
              savedTY.value = ty;
            }
          }
        } catch {
          // Corrupted JSON — silently discard; starts at default position.
        }
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Adaptive-tiling floor-plan renderer ──────────────────────────────────
  // At zoom N the floor plan is split into N×N tiles.  Each tile renders at
  // svgRenderW×svgRenderH with a viewBox crop for its 1/N × 1/N slice of the
  // SVG, so the rasteriser always matches the resolution the compositor needs
  // (quality ratio N/Z = 1 at every zoom level).
  //
  // numTiles = ceil(scale) so the tile count advances by integer steps only.
  // Visible-range culling (via useAnimatedReaction) keeps the live tile count
  // to ~4-9 regardless of total numTiles, holding memory constant.
  //
  // Falls back to single-texture SvgUri (with capped oversample) while svgXml
  // is not yet available (first cold start before the bundle fetch completes).

  // Track the integer zoom tier on the JS thread (avoids churn during pinch).
  const [renderZoom, setRenderZoom] = useState(1);
  useAnimatedReaction(
    () => Math.ceil(scale.value),
    (tier, prevTier) => {
      if (tier !== prevTier) {
        runOnJS(setRenderZoom)(tier);
      }
    },
  );

  // numTiles is the tile-grid dimension; oversample is the single-texture
  // fallback factor (both derived from renderZoom).
  const { numTiles, oversample } = useMemo(() => {
    if (svgRenderW <= 0) return { numTiles: 1, oversample: 1 };
    const pixelRatio = PixelRatio.get();
    const maxByTexture = Math.max(
      1,
      Math.floor(IOS_MAX_TEXTURE_PX / (svgRenderW * pixelRatio)),
    );
    return {
      numTiles: renderZoom,                                  // N×N tiling
      oversample: Math.max(1, Math.min(renderZoom, maxByTexture)), // fallback cap
    };
  }, [renderZoom, svgRenderW]);

  // Single-texture fallback dimensions
  const hiResW = svgRenderW * oversample;
  const hiResH = svgRenderH * oversample;

  // ── Visible-tile culling ──────────────────────────────────────────────────
  // Shared values that mirror JS state so the UI-thread reaction can read them
  // without requiring runOnJS on every gesture frame.
  const numTilesV = useSharedValue(1);
  const svgRenderWV = useSharedValue(svgRenderW);
  useEffect(() => { numTilesV.value = numTiles; }, [numTiles, numTilesV]);
  useEffect(() => { svgRenderWV.value = svgRenderW; }, [svgRenderW, svgRenderWV]);

  // Tile range visible in the current viewport.  Updated when any tile
  // boundary is crossed during pan or zoom (not on every animation frame).
  interface VisibleRange { N: number; c0: number; c1: number; r0: number; r1: number; }
  const [visibleRange, setVisibleRange] = useState<VisibleRange>(
    { N: 1, c0: 0, c1: 0, r0: 0, r1: 0 },
  );
  useAnimatedReaction(
    () => {
      const N = numTilesV.value;
      const W = svgRenderWV.value;
      if (N <= 1 || W <= 0) return { N, c0: 0, c1: 0, r0: 0, r1: 0 };
      const H = W / SVG_ASPECT;
      const Z = scale.value;
      const tx = translateX.value;
      const ty = translateY.value;
      const cW = containerWV.value;
      const cH = containerHV.value;
      const tileW = W / N;
      const tileH = H / N;
      // Centre of the visible floor-plan window in floor-plan coordinates.
      const visCX = W / 2 - tx / Z;
      const visCY = H / 2 - ty / Z;
      // Size of the visible window in floor-plan coordinates.
      const visW = cW / Z;
      const visH = cH / Z;
      // Tile grid range with 1-tile buffer to avoid pop-in on slow scrolls.
      const c0 = Math.max(0, Math.floor((visCX - visW / 2) / tileW) - 1);
      const c1 = Math.min(N - 1, Math.ceil((visCX + visW / 2) / tileW));
      const r0 = Math.max(0, Math.floor((visCY - visH / 2) / tileH) - 1);
      const r1 = Math.min(N - 1, Math.ceil((visCY + visH / 2) / tileH));
      return { N, c0, c1, r0, r1 };
    },
    (curr, prev) => {
      "worklet";
      if (
        !prev ||
        curr.N !== prev.N ||
        curr.c0 !== prev.c0 ||
        curr.c1 !== prev.c1 ||
        curr.r0 !== prev.r0 ||
        curr.r1 !== prev.r1
      ) {
        runOnJS(setVisibleRange)(curr);
      }
    },
  );

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
  // svgXml: full SVG text used by the tile renderer (SvgXml + modified viewBox)
  const [svgXml, setSvgXml] = useState(() => getCachedData()?.xml ?? "");
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
        setSvgXml(afterPersist.xml);
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
        setSvgXml(afterLoad.xml);
      }
      setSvgLoading(false);
    })();
  }, []);

  // Parse the content viewBox from the SVG XML as soon as it is available.
  // The parsed rect is the tightly cropped bounding box of the actual warehouse
  // drawing within the full 3592×2457 coordinate space and is used by
  // fitContentViewport() for correct initial positioning and Fit-button behaviour.
  // Also back-fills the in-memory cache (contentViewBox field) so that if the
  // cache was restored from AsyncStorage before this effect ran (e.g. the stored
  // entry predates this field), it is populated for the rest of the session.
  useEffect(() => {
    if (!svgXml) return;
    const cached = getCachedData();
    // Use the cached contentViewBox if it was already stored alongside the XML;
    // fall back to parsing the XML string only when the field is absent.
    const vb = cached?.contentViewBox ?? parseContentViewBox(svgXml);
    if (!vb) return;
    if (cached && !cached.contentViewBox) {
      // Back-fill the in-memory cache so future calls to getCachedData() are synchronous.
      cached.contentViewBox = vb;
    }
    setContentVB(vb);
    contentVBRef.current = vb;
    // If the viewport restore effect already signalled that we need a fit
    // (no saved viewport) but the viewBox wasn't ready at that point, apply it now.
    applyFitIfReady();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svgXml]);

  // ── Tile XML memoisation ──────────────────────────────────────────────────
  // Produces SvgXml strings for each visible tile by replacing the viewBox
  // attribute in the cached SVG text.  Recomputes only when the visible range
  // or numTiles changes — not on every animation frame.
  interface TileSpec { col: number; row: number; xml: string; }
  const tiles = useMemo<TileSpec[]>(() => {
    if (numTiles <= 1 || !svgXml || Platform.OS === "web") return [];
    const N = numTiles;
    const { c0, c1, r0, r1, N: rangeN } = visibleRange;
    // Wait until the reaction has caught up to the current N.
    if (rangeN !== N) return [];
    const vbW = SVG_VIEWBOX_W / N;
    const vbH = SVG_VIEWBOX_H / N;
    const result: TileSpec[] = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        // Replace the viewBox attribute so this tile renders only its slice.
        const tileXml = svgXml.replace(
          /viewBox="[^"]+"/,
          `viewBox="${c * vbW} ${r * vbH} ${vbW} ${vbH}"`,
        );
        result.push({ col: c, row: r, xml: tileXml });
      }
    }
    return result;
  }, [numTiles, svgXml, visibleRange]);

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

      // Focal point in container-center-relative coordinates.
      // e.focalX/Y are in container-local space (0,0 = top-left of the
      // GestureDetector view), so subtract half the container size to get
      // the offset from the view's visual centre (where translateX/Y=0).
      const focalX = e.focalX - containerWV.value / 2;
      const focalY = e.focalY - containerHV.value / 2;

      // Scale ratio relative to the baseline captured at gesture start.
      const ratio = savedScale.value > 0 ? newScale / savedScale.value : 1;

      // Translate so the map point under the pinch focal point stays fixed:
      //   newTX = focalX - (focalX - savedTX) * ratio
      //         = focalX * (1 - ratio) + savedTX * ratio
      const newTX = focalX * (1 - ratio) + savedTX.value * ratio;
      const newTY = focalY * (1 - ratio) + savedTY.value * ratio;

      const scaledW = containerWV.value * newScale;
      const scaledH = (containerWV.value / SVG_ASPECT) * newScale;
      const maxX = Math.max(0, (scaledW - containerWV.value) / 2);
      const maxY = Math.max(0, (scaledH - containerHV.value) / 2);
      translateX.value = clamp(newTX, -maxX, maxX);
      translateY.value = clamp(newTY, -maxY, maxY);
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      savedTX.value = translateX.value;
      savedTY.value = translateY.value;
      runOnJS(persistViewport)(scale.value, translateX.value, translateY.value);
    });

  // ── Pan gesture (minDistance prevents tap interference) ────────────────────
  const panGesture = Gesture.Pan()
    .minPointers(1)
    .minDistance(6)
    .onUpdate((e) => {
      const scaledW = containerWV.value * scale.value;
      const scaledH = (containerWV.value / SVG_ASPECT) * scale.value;
      const maxX = Math.max(0, (scaledW - containerWV.value) / 2);
      const maxY = Math.max(0, (scaledH - containerHV.value) / 2);
      translateX.value = clamp(savedTX.value + e.translationX, -maxX, maxX);
      translateY.value = clamp(savedTY.value + e.translationY, -maxY, maxY);
    })
    .onEnd(() => {
      savedTX.value = translateX.value;
      savedTY.value = translateY.value;
      runOnJS(persistViewport)(scale.value, translateX.value, translateY.value);
    });

  // ── Double-tap to reset zoom ────────────────────────────────────────────────
  const doubleTapGesture = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      runOnJS(applyFit)();
    });

  const mainGesture = Gesture.Exclusive(
    doubleTapGesture,
    Gesture.Simultaneous(pinchGesture, panGesture),
  );

  // ── Programmatic zoom helpers (zoom buttons) ────────────────────────────────
  const applyZoom = useCallback((targetScale: number) => {
    const oldScale = savedScale.value;
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, targetScale));
    const scaledW = svgRenderW * newScale;
    const scaledH = svgRenderH * newScale;
    const maxX = Math.max(0, (scaledW - containerW) / 2);
    const maxY = Math.max(0, (scaledH - containerH) / 2);
    // Scale the existing translation by the zoom ratio so the visible center
    // stays anchored. At zoom=1 the map center is at tx=0; as the user pans,
    // tx/ty drift. Multiplying by newScale/oldScale keeps the same map point
    // at the screen centre both before and after the zoom step.
    const ratio = oldScale > 0 ? newScale / oldScale : 1;
    const newTX = Math.max(-maxX, Math.min(maxX, translateX.value * ratio));
    const newTY = Math.max(-maxY, Math.min(maxY, translateY.value * ratio));
    scale.value = withSpring(newScale, { damping: 18, stiffness: 200 });
    translateX.value = withSpring(newTX, { damping: 18, stiffness: 200 });
    translateY.value = withSpring(newTY, { damping: 18, stiffness: 200 });
    savedScale.value = newScale;
    savedTX.value = newTX;
    savedTY.value = newTY;
    persistViewport(newScale, newTX, newTY);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svgRenderW, svgRenderH, containerW, containerH, persistViewport]);

  const handleZoomIn = useCallback(() => {
    applyZoom(scale.value * 1.5);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyZoom]);

  const handleZoomOut = useCallback(() => {
    applyZoom(scale.value / 1.5);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyZoom]);

  const handleFitScreen = useCallback(() => {
    applyFit();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyFit]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  // ── SVG zone overlays (viewBox coordinate space) ───────────────────────────
  // Each ZoneOverlayItem uses useAnimatedProps to drive strokeWidth and fontSize
  // on the UI thread — visual weight stays constant as zoom changes with zero
  // JS re-renders during pinch or button-driven spring animations.
  // Zone geometry (x/y/w/h) is static and correctly tracks the floor plan.
  const zoneOverlays = useMemo(() => {
    if (!zones.length) return null;
    return zones.map((zone) => (
      <ZoneOverlayItem
        key={zone.id}
        zone={zone}
        scale={scale}
        colors={colors}
        onZoneTap={onZoneTap}
        onZoneLongPress={onZoneLongPress}
        cycleMode={cycleMode}
        cycleLocked={cycleLocked}
        isCounted={countedZoneIds?.has(zone.id) ?? false}
      />
    ));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zones, colors, onZoneTap, onZoneLongPress, cycleMode, cycleLocked, countedZoneIds]);

  // ── Early return before layout ─────────────────────────────────────────────
  if (containerW === 0) {
    return <View style={styles.fill} onLayout={onLayout} />;
  }

  return (
    <View style={styles.fill} onLayout={onLayout}>
      <View style={styles.mapCenter}>
      <GestureDetector gesture={mainGesture}>
        <Animated.View style={[{ width: svgRenderW, height: svgRenderH }, animatedStyle]}>
          {/* ── Native floor plan layer ──────────────────────────────────────
              On web the floor plan is embedded inside the SVG canvas below so
              that both layers share one SVG viewport (no separate CSS-scaled
              div, therefore no rasterisation blur at any zoom level).
              On native, <SvgUri> is rendered directly at svgRenderW × svgRenderH;
              the SVG's own viewBox handles coordinate scaling.  This avoids
              exceeding iOS's maximum GPU texture size which caused patchwork
              tiles and blur when rasterising at the SVG's full viewBox
              resolution (3592 × 2457 pts × 3× DPR ≈ 10 776 × 7 372 px). */}
          {Platform.OS !== "web" ? (
            (svgUri || svgXml) ? (
              // ── Native floor plan — adaptive tiling ──────────────────────
              // Primary path (svgXml available): N×N tiles where N = ceil(zoom).
              // Each tile renders the SVG at svgRenderW×svgRenderH with a
              // viewBox cropped to its 1/N slice, so the SVG rasteriser always
              // produces the resolution the compositor needs (quality ratio 1).
              // Only tiles that overlap the visible viewport are instantiated.
              //
              // Fallback (svgXml not yet loaded): single-texture SvgUri with
              // capped oversample so the first cold-start render is still sharp
              // up to ~7× while the XML fetch completes in the background.
              <View
                style={[
                  { width: svgRenderW, height: svgRenderH, overflow: "hidden" },
                  isDark && styles.svgDarkFilter,
                ]}
              >
                {numTiles > 1 && tiles.length > 0 ? (
                  // Tiled path — render only visible tiles
                  tiles.map(({ col, row, xml: tileXml }) => (
                    <View
                      key={`${col}-${row}`}
                      style={{
                        width: svgRenderW,
                        height: svgRenderH,
                        position: "absolute",
                        // Centre the tile's layout box so that scale(1/N)
                        // pivots exactly around the tile's visual centre.
                        left: (col + 0.5) * (svgRenderW / numTiles) - svgRenderW / 2,
                        top: (row + 0.5) * (svgRenderH / numTiles) - svgRenderH / 2,
                        transform: [{ scale: 1 / numTiles }],
                      }}
                    >
                      <SvgXml xml={tileXml} width={svgRenderW} height={svgRenderH} />
                    </View>
                  ))
                ) : svgXml ? (
                  // Single-tile path — SVG text already loaded; render directly
                  // with SvgXml so no second network round-trip is needed.
                  <SvgXml xml={svgXml} width={svgRenderW} height={svgRenderH} />
                ) : (
                  // Cold-start fallback — svgXml not yet available; use SvgUri
                  // which can render from the URI while the XML fetch completes.
                  <View
                    style={{
                      width: hiResW,
                      height: hiResH,
                      position: "absolute",
                      left: (svgRenderW - hiResW) / 2,
                      top: (svgRenderH - hiResH) / 2,
                      transform: [{ scale: 1 / oversample }],
                    }}
                  >
                    <SvgUri uri={svgUri} width={hiResW} height={hiResH} />
                  </View>
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
              rendered above via absoluteFill.
              Each ZoneOverlayItem drives its own strokeWidth and fontSize via
              useAnimatedProps on the UI thread — visual weight stays constant
              as zoom changes, with zero JS re-renders during pinch or spring
              animations. Zone geometry (x/y/w/h) fills the full SVG viewBox,
              so alignment with the floor plan is always exact. */}
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
