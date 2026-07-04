/**
 * WarehouseMapView — native pan/zoom warehouse floor plan with SVG zone overlays.
 *
 * SVG viewBox: 0 0 7329.6001 4997.2798
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
import { Feather } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import DOMPurify from "dompurify";
import { Asset } from "expo-asset";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  type AppStateStatus,
  Image,
  LayoutChangeEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  runOnJS,
  type SharedValue,
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { Ellipse,G, Path, Rect, Svg, SvgUri, SvgXml, Text as SvgText } from "react-native-svg";
import { z } from "zod";

import { useColors } from "@/hooks/useColors";
import type { ApiWarehouseZone } from "@/hooks/useWarehouseZones";
import { API_BASE } from "@/utils/apiBase";
import { fetchWithAuth } from "@/utils/appAuth";
import { warmupTiles } from "@/utils/floorPlan";
import {
  getCachedData,
  getCachedHash,
  getIfValid,
  hasCachedData,
  initPersistRead,
  resetForServerUpdate,
  setCached,
  setFallbackEmpty,
  type SvgData,
} from "@/utils/floorPlanCache";
// Pure viewport math is in utils/mapViewport — exported for testing.
import {
  clampScale,
  computeFitTarget,
  type ContentViewBox,
  MAX_SCALE,
  MIN_SCALE,
  panBounds,
  parseContentViewBox,
  SVG_ASPECT,
  SVG_VIEWBOX_H,
  SVG_VIEWBOX_W,
  tileGridSize,
  ZOOM_STOPS,
  zoomStopForScale,
} from "@/utils/mapViewport";
import {
  cleanStaleCacheDirs,
  fetchTile,
  prefetchZoomLevel,
} from "@/utils/tilePyramidCache";

const VIEWPORT_KEY = "@rdc34/warehouse_map_viewport_v2";
const FloorPlanMetaSchema = z.object({ hash: z.string() });

// Standalone worklet — no closure over JS values
function clamp(val: number, min: number, max: number) {
  "worklet";
  return val < min ? min : val > max ? max : val;
}

// Animated wrappers for SVG primitives — lets useAnimatedProps drive
// strokeWidth and fontSize on the UI thread with zero JS re-renders.
const AnimatedRect = Animated.createAnimatedComponent(Rect);
const AnimatedSvgText = Animated.createAnimatedComponent(SvgText);
const AnimatedG = Animated.createAnimatedComponent(G);

// ── Module-level SVG cache ────────────────────────────────────────────────────
// Managed by utils/floorPlanCache (two-tier: in-memory + AsyncStorage).
// Kick off the AsyncStorage read immediately at module load so the data is
// typically ready before the first component mount.
const _persistReadPromise = initPersistRead();

// Single in-flight asset-load promise so concurrent mounts don't issue
// duplicate network requests.
let _svgLoadPromise: Promise<void> | null = null;

// AbortController for the active SVG fetch.  Aborted before each new fetch
// so stale in-flight requests don't overwrite state after a floor-plan upload.
let _svgLoadAbortController: AbortController | null = null;

export function prefetchSvgAsset(): Promise<void> {
  if (hasCachedData()) return Promise.resolve();
  return loadSvgAsset();
}

/**
 * Load the floor plan SVG: try the server first (admin-uploadable), fall back
 * to the bundled asset, and finally set an empty fallback if both fail.
 * Uses hash-based cache invalidation so cold-start renders skip network.
 *
 * Aborts any previously in-flight fetch before starting a new one so that
 * a stale server response cannot overwrite state after a floor-plan upload.
 */
function loadSvgAsset(): Promise<void> {
  if (_svgLoadPromise) return _svgLoadPromise;

  // Abort any previous in-flight fetch before starting a new one.
  _svgLoadAbortController?.abort();
  const controller = new AbortController();
  _svgLoadAbortController = controller;

  _svgLoadPromise = _loadFloorPlanFromServer(controller.signal)
    .catch(() => _loadFloorPlanFromBundle(controller.signal))
    .catch(() => { if (!controller.signal.aborted) setFallbackEmpty(); });
  return _svgLoadPromise;
}

async function _loadFloorPlanFromServer(signal: AbortSignal): Promise<void> {
  const metaRes = await fetchWithAuth(`${API_BASE}/floor-plan/meta`, { signal });
  if (!metaRes.ok) throw new Error("no server floor plan");

  const { hash } = FloorPlanMetaSchema.parse(await metaRes.json());
  if (signal.aborted) throw new Error("aborted");
  // Cache hit — skip re-fetching the SVG bytes entirely.
  if (getIfValid(hash) !== null) return;
  // Bail out early if the fetch was cancelled between the meta check and the SVG fetch.
  if (signal?.aborted) throw new Error("aborted");

  const svgRes = await fetchWithAuth(`${API_BASE}/floor-plan/svg`, { signal });
  if (!svgRes.ok) throw new Error("floor-plan svg fetch failed");
  const xml = await svgRes.text();
  if (signal.aborted) throw new Error("aborted");

  // Guard against abort firing between the response body read and the state write.
  if (signal?.aborted) throw new Error("aborted");

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
    newData = { xml, innerXml: "", uri: `${API_BASE}/floor-plan/svg`, contentViewBox };
  }
  setCached(hash, newData);
}

async function _loadFloorPlanFromBundle(signal: AbortSignal): Promise<void> {
  const [asset] = await Asset.loadAsync(
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("../assets/warehouse-map.svg"),
  );
  if (signal.aborted) throw new Error("aborted");
  const currentHash = asset.hash ?? "";
  // Cache hit — persisted hash matches; skip the URI fetch entirely.
  if (getIfValid(currentHash) !== null) return;

  const uri = asset.localUri ?? asset.uri ?? "";
  let newData: SvgData;
  if (Platform.OS === "web") {
    const res = await fetch(uri, { signal });
    const xml = await res.text();
    if (signal.aborted) throw new Error("aborted");
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
    const res = await fetch(uri, { signal });
    if (signal.aborted) throw new Error("aborted");
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
  isCounted: boolean;
  isPinned?: boolean;
  isVariantPinned?: boolean;
  /** When true, renders a highlighted ring/fill to indicate this zone is currently selected. */
  isSelected?: boolean;
  /** Bin code label to render inside the zone when it is pinned (e.g. "17-06-204"). */
  binLabel?: string;
  /** Section numbers (0-99) for primary result pins — shown as proportionally-positioned markers within the zone. */
  pinnedSections?: Array<number>;
  /** Section numbers (0-99) for variant result pins — shown as proportionally-positioned purple markers. */
  variantSections?: Array<number>;
}

export function ZoneOverlayItem({
  zone,
  scale,
  colors,
  onZoneTap,
  onZoneLongPress,
  cycleMode,
  isCounted,
  isPinned,
  isVariantPinned,
  isSelected,
  binLabel,
  pinnedSections,
  variantSections,
}: ZoneOverlayItemProps) {
  "use no memo";
  const isActive = zone.isInventory;
  const baseFontSize = Math.max(24, Math.min(48, zone.svgHeight / 3));

  // Baseline stroke widths at scale=1; divide by scale.value to keep visual weight constant.
  // Selected zones get a thicker stroke so the user can see which zone is active.
  const baseStroke = cycleMode ? (isCounted ? 10 : 4) : (isSelected ? 14 : isActive ? 8 : 4);

  const rectAnimatedProps = useAnimatedProps(() => ({
    strokeWidth: baseStroke / scale.value,
  }));

  const textAnimatedProps = useAnimatedProps(() => ({
    fontSize: baseFontSize / scale.value,
  }));

  // Track whether this zone was already pinned when it first rendered so we
  // can distinguish "newly placed" (animate) from "restored on load" (no animation).
  const isPinnedNow = !!(isPinned || isVariantPinned);
  const prevPinnedRef = useRef<boolean>(isPinnedNow);
  const isNewPin = isPinnedNow && !prevPinnedRef.current;
  prevPinnedRef.current = isPinnedNow;

  // Animate the rect fill opacity 0→1 when a zone first gets pinned.
  // fillOpacitySV stays at 1 for all other cases (normal zone fill, cycle mode)
  // so existing colours render at their intended opacity with no regressions.
  const fillOpacitySV = useSharedValue(1);
  // Separate ref updated inside the effect so it correctly captures the
  // previous value at the time the effect fires (not during render).
  const prevPinnedForFillRef = useRef<boolean>(isPinnedNow);
  useEffect(() => {
    const wasAlreadyPinned = prevPinnedForFillRef.current;
    prevPinnedForFillRef.current = isPinnedNow;
    if (isPinnedNow && !wasAlreadyPinned) {
      // New placement — snap to 0 then animate in over 250 ms.
      fillOpacitySV.value = 0;
      fillOpacitySV.value = withTiming(1, { duration: 250 });
    }
    return () => { cancelAnimation(fillOpacitySV); };
  }, [isPinnedNow, fillOpacitySV]);

  const rectPinAnimatedProps = useAnimatedProps(() => ({
    strokeWidth: baseStroke / scale.value,
    fillOpacity: fillOpacitySV.value,
  }));

  // ── Bin-code badge callout (pill above the 3D pin head) ──────────────────────
  // Computed once; all values are in SVG viewBox coordinates so they scale
  // naturally with pinch/zoom.  The worklet divides by scale.value to keep the
  // badge at a constant visual size (same strategy as strokeWidth / fontSize).
  const badgeBaseFontSize = Math.max(18, Math.min(30, zone.svgHeight / 4.5));
  const badgeLabelLen = (binLabel ?? "").length || 8;
  const badgeCx = zone.svgX + zone.svgWidth / 2;
  const badgeMarkerR = Math.max(10, Math.min(30, zone.svgWidth / 6));
  // Pin tip sits at zone vertical center; ball center is markerR*1.85 above it,
  // so ball top = tipCy − markerR*(1.85+1) = tipCy − markerR*2.85.
  const badgePinTipCy = zone.svgY + zone.svgHeight / 2;
  const badgeBallTopY = badgePinTipCy - badgeMarkerR * 2.85;

  const badgeRectAnimatedProps = useAnimatedProps(() => {
    "worklet";
    const fs = badgeBaseFontSize / scale.value;
    const bw = badgeLabelLen * fs * 0.64 + fs * 1.1;
    const bh = fs * 1.6;
    const gap = fs * 0.4;
    return {
      width: bw,
      height: bh,
      x: badgeCx - bw / 2,
      y: badgeBallTopY - bh - gap,
      rx: bh / 2,
      ry: bh / 2,
    };
  });

  const badgeTextAnimatedProps = useAnimatedProps(() => {
    "worklet";
    const fs = badgeBaseFontSize / scale.value;
    const bh = fs * 1.6;
    const gap = fs * 0.4;
    return {
      fontSize: fs,
      y: badgeBallTopY - bh / 2 - gap,
    };
  });

  if (cycleMode) {
    const fillColor = isCounted ? "#22c55ecc" : colors.primary + "18";
    const strokeColor = isCounted ? "#16a34a" : colors.primary + "50";
    const labelColor = isCounted ? "#fff" : colors.primary + "80";
    return (
      <G
        {...(Platform.OS !== "web" && isActive && {
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
          {zone.aisleId}
        </AnimatedSvgText>
      </G>
    );
  }

  const pinFillColor = isPinned
    ? "rgba(245, 158, 11, 0.28)"
    : isVariantPinned
    ? "rgba(139, 92, 246, 0.28)"
    : isSelected
    ? "rgba(0, 112, 255, 0.22)"
    : isActive
    ? "rgba(0, 112, 255, 0.14)"
    : "rgba(0, 112, 255, 0.06)";
  const strokeColor = isPinned
    ? "#f59e0b"
    : isVariantPinned
    ? "#8b5cf6"
    : "#0070ff";
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
        x={zone.svgX}
        y={zone.svgY}
        width={zone.svgWidth}
        height={zone.svgHeight}
        fill={pinFillColor}
        stroke={strokeColor}
        strokeDasharray={(!isPinned && !isVariantPinned && !isActive) ? "20 10" : undefined}
        animatedProps={rectPinAnimatedProps}
      />
      {(isPinned || isVariantPinned) ? (() => {
        // Section numbers for this zone's pins (0–99, proportional within aisle height).
        const sectionNums = isPinned ? pinnedSections : variantSections;
        const pinFill = isPinned ? "#f59e0b" : "#8b5cf6";
        const markerR = Math.max(10, Math.min(30, zone.svgWidth / 6));
        const cx = zone.svgX + zone.svgWidth / 2;

        if (sectionNums && sectionNums.length > 0) {
          // The zone is already the single correct zone for the pinned section,
          // so one centered pin is the right indicator — no need to place one
          // per section number.
          const cy = zone.svgY + zone.svgHeight / 2;
          return (
            <MapPinEmoji
              cx={cx}
              cy={cy}
              size={markerR}
              fill={pinFill}
              isNew={isNewPin}
            />
          );
        }
        // Fallback: no section data — show emoji pin at zone top
        return (
          <MapPinEmoji
            cx={cx}
            cy={zone.svgY + 40}
            size={markerR}
            fill={pinFill}
            isNew={isNewPin}
          />
        );
      })() : null}
      {binLabel && (isPinned || isVariantPinned) ? (
        <G>
          <AnimatedRect
            fill={isPinned ? "#f59e0b" : "#8b5cf6"}
            animatedProps={badgeRectAnimatedProps}
          />
          <AnimatedSvgText
            x={badgeCx}
            textAnchor="middle"
            alignmentBaseline="middle"
            fill="#fff"
            fontFamily="monospace"
            fontWeight="bold"
            animatedProps={badgeTextAnimatedProps}
          >
            {binLabel}
          </AnimatedSvgText>
        </G>
      ) : null}
      <AnimatedSvgText
        x={zone.svgX + zone.svgWidth / 2}
        y={(isPinned || isVariantPinned) ? zone.svgY + zone.svgHeight / 2 + 20 : zone.svgY + zone.svgHeight / 2}
        fontWeight="bold"
        fill={isPinned ? "#b45309" : isVariantPinned ? "#6d28d9" : labelColor}
        textAnchor="middle"
        alignmentBaseline="middle"
        animatedProps={textAnimatedProps}
      >
        {zone.aisleId}
      </AnimatedSvgText>
    </G>
  );
}

// ── PNG tile component ────────────────────────────────────────────────────────
// Downloads the pre-rasterised PNG tile from the API (cached on-device via
// tilePyramidCache) and renders it as a React Native Image.  The base
// SvgXml/SvgUri layer underneath acts as a placeholder while the tile loads —
// when the Image resolves it paints on top.  Unmounting cancels the in-flight
// download via the `cancelled` flag.
function PngTile({
  z,
  col,
  row,
  svgHash,
  tileW,
  tileH,
}: {
  z: number;
  col: number;
  row: number;
  svgHash: string;
  tileW: number;
  tileH: number;
}) {
  "use no memo";
  const [uri, setUri] = useState<string | null>(null);

  useEffect(() => {
    if (!svgHash) return;
    let cancelled = false;
    fetchTile(z, col, row, svgHash)
      .then((u) => { if (!cancelled) setUri(u); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [z, col, row, svgHash]);

  if (!uri) return null;
  return (
    <Image
      source={{ uri }}
      style={{
        width: tileW,
        height: tileH,
        position: "absolute",
        left: col * tileW,
        top: row * tileH,
      }}
      fadeDuration={0}
    />
  );
}

export interface WarehouseMapViewProps {
  zones: Array<ApiWarehouseZone>;
  zonesLoading: boolean;
  zonesError: boolean;
  onZonesRetry: () => void;
  onZoneTap: (zone: ApiWarehouseZone) => void;
  onZoneLongPress?: (zone: ApiWarehouseZone) => void;
  isAdmin?: boolean;
  cycleMode?: boolean;
  countedZoneIds?: ReadonlySet<number>;
  /** Zone IDs of primary search result pins — highlighted amber on the map. */
  pinnedZoneIds?: ReadonlySet<number>;
  /** Zone IDs of variant/related-size pins — highlighted purple on the map. */
  variantZoneIds?: ReadonlySet<number>;
  /** Maps aisleNum → first bin code (e.g. "17-06-204") to render as a label inside the pinned zone. */
  pinnedBinLabels?: ReadonlyMap<number, string>;
  /** Maps aisleNum → list of section numbers for primary pins — drives section-level 3D pin markers. */
  pinnedSectionsMap?: ReadonlyMap<number, Array<number>>;
  /** Maps aisleNum → list of section numbers for variant pins — drives section-level 3D pin markers. */
  variantSectionsMap?: ReadonlyMap<number, Array<number>>;
  /**
   * When set, the map animates its viewport to center on this aisle's zone.
   * Consumed once; set to null after navigating away.
   */
  focusAisleNum?: number | null;
  /**
   * When set alongside focusAisleNum, centres on the specific section zone
   * rather than the first zone found in the aisle. Falls back to the aisle's
   * first zone if no matching section zone exists.
   */
  focusSectionNum?: number | null;
  /** Called after the auto-focus animation fires so the parent can clear focusAisleNum. */
  onFocusConsumed?: () => void;
  /** Called when focusAisleNum is set but no matching zone exists on the map. */
  onFocusFailed?: () => void;
  /**
   * When true, tapping a zone fires onZoneTap (select mode).
   * When false (default), zone taps are suppressed and the map is pan-only.
   */
  selectMode?: boolean;
  /** Called when the user toggles select mode via the in-map button. */
  onSelectModeChange?: (enabled: boolean) => void;
  /**
   * ID of the zone currently selected (action menu open). The matching zone
   * is rendered with a highlighted stroke and fill tint.
   */
  selectedZoneId?: number;
  /**
   * Called when the user starts a pan gesture on the map. Use this to dismiss
   * any selection state (e.g. the zone action menu).
   */
  onPanStart?: () => void;
}

/** 3D-style teardrop pin rendered entirely in SVG viewBox coordinates.
 *  `cx`, `cy` — tip (bottom point) of the pin.
 *  `size`     — ball radius; controls overall scale.
 *  `isNew`    — when true, plays a spring pop entrance animation on mount.
 *               Leave false (default) for pins restored from a previous session.
 */
export function MapPin3D({
  cx,
  cy,
  size,
  fill,
  stroke,
  isNew = false,
}: {
  cx: number;
  cy: number;
  size: number;
  fill: string;
  stroke: string;
  isNew?: boolean;
}) {
  "use no memo";
  const r = size;
  const bcy = cy - r * 1.85;
  const path =
    `M ${cx},${cy} ` +
    `C ${cx - r * 0.38},${cy - r * 0.55} ${cx - r},${cy - r * 1.1} ${cx - r},${bcy} ` +
    `A ${r},${r} 0 1,1 ${cx + r},${bcy} ` +
    `C ${cx + r},${cy - r * 1.1} ${cx + r * 0.38},${cy - r * 0.55} ${cx},${cy} Z`;
  const gx = cx - r * 0.28;
  const gy = bcy - r * 0.32;

  const pinScale = useSharedValue(isNew ? 0 : 1);

  useEffect(() => {
    if (isNew) {
      pinScale.value = 0;
      pinScale.value = withSpring(1, { damping: 8, stiffness: 180, mass: 0.7 });
    }
    return () => { cancelAnimation(pinScale); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew]);

  const pinAnimatedProps = useAnimatedProps(() => {
    "worklet";
    const s = pinScale.value;
    return {
      transform: `translate(${cx} ${cy}) scale(${s}) translate(${-cx} ${-cy})`,
    };
  });

  return (
    <AnimatedG animatedProps={pinAnimatedProps}>
      <Ellipse
        cx={cx}
        cy={cy + r * 0.18}
        rx={r * 0.42}
        ry={r * 0.16}
        fill="rgba(0,0,0,0.18)"
      />
      <Path d={path} fill={fill} stroke={stroke} strokeWidth={2} strokeLinejoin="round" />
      <Ellipse
        cx={gx}
        cy={gy}
        rx={r * 0.21}
        ry={r * 0.13}
        fill="rgba(255,255,255,0.55)"
      />
    </AnimatedG>
  );
}

/**
 * MapPinEmoji — renders the 📍 emoji as the zone marker so it matches the
 * pinned-part banner in the header bar.  A tinted ellipse behind the emoji
 * carries the amber (primary) vs purple (variant) colour distinction.
 * Entrance animation mirrors MapPin3D's spring-scale effect.
 */
export function MapPinEmoji({
  cx,
  cy,
  size,
  fill,
  isNew = false,
}: {
  cx: number;
  cy: number;
  size: number;
  fill: string;
  isNew?: boolean;
}) {
  "use no memo";
  const fontSize = size * 2.4;
  // Vertical centre of the emoji's round head, above the baseline (tip) at cy.
  const headCy = cy - fontSize * 0.62;

  const pinScale = useSharedValue(isNew ? 0 : 1);

  useEffect(() => {
    if (isNew) {
      pinScale.value = 0;
      pinScale.value = withSpring(1, { damping: 8, stiffness: 180, mass: 0.7 });
    }
    return () => { cancelAnimation(pinScale); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew]);

  const pinAnimatedProps = useAnimatedProps(() => {
    "worklet";
    const s = pinScale.value;
    return {
      transform: `translate(${cx} ${cy}) scale(${s}) translate(${-cx} ${-cy})`,
    };
  });

  return (
    <AnimatedG animatedProps={pinAnimatedProps}>
      {/* Drop-shadow ellipse at the pin tip */}
      <Ellipse
        cx={cx}
        cy={cy + size * 0.18}
        rx={size * 0.42}
        ry={size * 0.16}
        fill="rgba(0,0,0,0.18)"
      />
      {/* Colour badge behind the emoji — carries amber vs purple distinction */}
      <Ellipse
        cx={cx}
        cy={headCy}
        rx={fontSize * 0.38}
        ry={fontSize * 0.38}
        fill={fill}
        opacity={0.28}
      />
      {/* 📍 emoji centred on the badge */}
      <SvgText
        x={cx}
        y={cy}
        fontSize={fontSize}
        textAnchor="middle"
        alignmentBaseline="middle"
      >
        {"📍"}
      </SvgText>
    </AnimatedG>
  );
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
  countedZoneIds,
  pinnedZoneIds,
  variantZoneIds,
  pinnedBinLabels,
  pinnedSectionsMap,
  variantSectionsMap,
  focusAisleNum,
  focusSectionNum,
  onFocusConsumed,
  onFocusFailed,
  selectMode = false,
  onSelectModeChange,
  selectedZoneId,
  onPanStart,
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

  // Mirror zones in a ref so the focusAisleNum effect can read the latest
  // zones without listing `zones` as a dependency (which would re-trigger
  // the auto-zoom every time zone data refreshes from the server).
  const zonesRef = useRef<Array<ApiWarehouseZone>>([]);
  // Set to true by the focus effect when zones have not loaded yet so the
  // zones-change effect below can retry once they arrive.
  const pendingFocusRef = useRef(false);


  // Snapshot of the viewport state captured at the moment the app moves to
  // background.  When the OS delivers a layout event after resume (e.g. because
  // the device was rotated while the app was suspended), the snapshot gives us
  // the reliable pre-suspension width and translations to compute the correct
  // centre-preserving ratio.  Using containerWRef.current / savedTX.value
  // directly is unsafe because a spurious OS layout event may have already
  // updated those values to a partially-transitioned state.
  const bgSnapshotRef = useRef<{ w: number; tx: number; ty: number } | null>(null);
  // Timer that expires the snapshot after a short window on foreground.
  // Both ordering cases are supported:
  //   • layout fires BEFORE active  → snapshot consumed by layout; timer never starts
  //   • active fires BEFORE layout  → timer starts; layout arrives within the window,
  //     cancels the timer and consumes the snapshot
  //   • active fires, no layout     → timer fires, snapshot cleared; subsequent
  //     foreground rotations use live refs and are not contaminated by stale values
  const bgSnapshotExpireTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Parsed content viewBox from the SVG XML — the tightly cropped bounding
  // box of the actual warehouse drawing within the full 3592×2457 coordinate
  // space.  Initialised synchronously from the cache when data is available;
  // the cache stores the parsed value alongside the XML so no re-parse is
  // needed on repeat cold-starts.
  const [contentVB, setContentVB] = useState<ContentViewBox | null>(
    () => getCachedData()?.contentViewBox ?? null,
  );
  const contentVBRef = useRef<ContentViewBox | null>(contentVB);
  // Ref mirror of svgAspect so async callbacks (e.g. snapToNearestZoomStop,
  // onLayout) always read the latest value without closing over stale state.
  const svgAspectRef = useRef(SVG_ASPECT);

  // Derive the effective floor-plan aspect ratio from the parsed viewBox.
  // Falls back to the compile-time constant so cold-start (before the SVG is
  // fetched and parsed) behaves identically to the pre-fix behaviour.
  const svgRenderW = containerW;
  const svgAspect = contentVB ? contentVB.w / contentVB.h : SVG_ASPECT;
  const svgRenderH = containerW > 0 ? containerW / svgAspect : 0;

  // True when we need to apply a fit-to-content viewport as soon as both the
  // container dimensions and the content viewBox are known.  Starts true so
  // the map always opens fitted to screen on mount (no viewport restore path).
  const pendingFit = useRef(true);

  // Indirection ref so onLayout (declared before the shared values) can call
  // applyFitIfReady (which needs the shared values) without a forward-reference
  // TypeScript error.  Assigned during each render before the first layout fires.
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  const applyFitIfReadyRef = useRef<() => void>(() => {});

  // Indirection ref so the focusAisleNum effect (declared before applyFit) can
  // call applyFit without a TypeScript use-before-declare error.
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  const applyFitRef = useRef<() => void>(() => {});

  const onLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const { width, height } = e.nativeEvent.layout;

      // When the app resumes from the background, a spurious OS layout event
      // may fire during the background-to-foreground transition — possibly with
      // partially-transitioned dimensions.  If we have a pre-suspension snapshot
      // we use IT as the source of truth for both prevW and the reference
      // translations; otherwise we fall back to the live refs as before.
      const bgSnap = bgSnapshotRef.current;

      // Capture prevW from the snapshot (reliable) or the live ref (normal path).
      const prevW = bgSnap !== null ? bgSnap.w : containerWRef.current;

      setContainerW(width);
      setContainerH(height);
      containerWV.value = width;
      containerHV.value = height;
      containerWRef.current = width;
      containerHRef.current = height;

      if (!hasLaidOut.current) {
        hasLaidOut.current = true;
        // Consume snapshot (and cancel any pending expiry timer) — this is the
        // first layout ever, so no rotation correction runs; clear regardless.
        if (bgSnapshotExpireTimerRef.current !== null) {
          clearTimeout(bgSnapshotExpireTimerRef.current);
          bgSnapshotExpireTimerRef.current = null;
        }
        bgSnapshotRef.current = null;

        // Apply fit-to-content now that we have real container dimensions.
        // Fresh app opens always center the floor plan — no viewport restore.
        applyFitIfReadyRef.current();
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
      //
      // When recovering from background we use the snapshot's tx/ty rather than
      // savedTX/savedTY because those shared values may have already been
      // mutated by an earlier spurious layout event that fired mid-transition.
      const currentScale = savedScale.value;
      const sizeRatio = prevW > 0 ? width / prevW : 1;
      const refTX = bgSnap !== null ? bgSnap.tx : savedTX.value;
      const refTY = bgSnap !== null ? bgSnap.ty : savedTY.value;
      // Snapshot consumed — cancel any pending expiry timer and clear the ref
      // so subsequent layout events use the normal (live-ref) path.
      if (bgSnapshotExpireTimerRef.current !== null) {
        clearTimeout(bgSnapshotExpireTimerRef.current);
        bgSnapshotExpireTimerRef.current = null;
      }
      bgSnapshotRef.current = null;

      const centredTX = refTX * sizeRatio;
      const centredTY = refTY * sizeRatio;

      const { maxX, maxY } = panBounds(width, height, currentScale, width / svgAspectRef.current);
      const newTX = clamp(centredTX, -maxX, maxX);
      const newTY = clamp(centredTY, -maxY, maxY);
      translateX.value = withSpring(newTX, { damping: 26, stiffness: 220 });
      translateY.value = withSpring(newTY, { damping: 26, stiffness: 220 });
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

  // ── Pin-focus mode ─────────────────────────────────────────────────────────
  // Set to 1 when "Map it!" resets the map to fit view.  While active, pinch
  // zoom pivots around the pin marker centre (keeping it on screen) instead of
  // the finger focal point.  Cleared on pan, double-tap, or zoom-button press.
  const pinFocusModeV = useSharedValue(0);
  const pinFocusCxV   = useSharedValue(0); // pin centre X in SVG coordinates
  const pinFocusCyV   = useSharedValue(0); // pin centre Y in SVG coordinates
  // True while a button-triggered withSpring is in flight; gates tile rebuilds.
  const springActive = useSharedValue(false);
  // Monotonically-increasing counter. Incremented on every applyZoom call so
  // the onEnd callback of a superseded (cancelled) spring can detect it is
  // stale and must not clear the gate or commit a render tier.
  const springGeneration = useSharedValue(0);

  // Keep zonesRef in sync so the focus effects below can always read the
  // latest zones without listing `zones` as a dependency.
  useEffect(() => { zonesRef.current = zones; }, [zones]);

  // ── Auto-focus on pinned zone ───────────────────────────────────────────────
  // When a `focusAisleNum` is provided (set by the Map tab when the worker
  // taps "Show on Map" from Search / Photo), animate the viewport so the
  // target aisle is centred at the current zoom level (no zoom change).
  // The pan logic is delegated to the exported `runFocusAisleEffect` function
  // so it can be unit-tested in isolation without mounting the full component.
  //
  // `zones` and `containerW` are intentionally omitted from the dependency
  // array.  The effect reads both through refs (zonesRef / containerWRef) so
  // that zone refreshes from the server and container layout changes (keyboard,
  // SafeAreaView insets, orientation) do not re-trigger the zoom animation
  // while focusAisleNum is still set.
  useEffect(() => {
    if (focusAisleNum == null) {
      pendingFocusRef.current = false;
      return;
    }
    const w = containerWRef.current;
    const h = containerHRef.current;
    if (w === 0 || h === 0 || !zonesRef.current.length) {
      // Zones not yet loaded (or container not yet laid out); defer until
      // they arrive so we don't silently drop the focus request.
      pendingFocusRef.current = true;
      return;
    }
    pendingFocusRef.current = false;

    // Check if the zone exists; fire the failure/consumed callbacks if not.
    const zoneExists = zonesRef.current.some(z => parseInt(z.aisleId, 10) === focusAisleNum);
    if (!zoneExists) {
      onFocusFailed?.();
      onFocusConsumed?.();
      return;
    }

    // Find the target zone so we can store its SVG centre for pin-focused zoom.
    const aisleZones = zonesRef.current.filter(z => parseInt(z.aisleId, 10) === focusAisleNum);
    const zone =
      focusSectionNum != null
        ? (aisleZones.find(z => z.sectionNum === focusSectionNum) ?? aisleZones[0])
        : aisleZones[0];

    if (zone) {
      // Store pin centre in SVG coordinates so the pinch gesture can pivot
      // around it while pin-focus mode is active.
      pinFocusCxV.value = zone.svgX + zone.svgWidth  / 2;
      pinFocusCyV.value = zone.svgY + zone.svgHeight / 2;
      pinFocusModeV.value = 1;
    }

    // Reset to the full fit view so the worker sees the whole warehouse with
    // the highlighted pin before choosing whether and how far to zoom in.
    applyFitRef.current();

    // Notify parent that this focus has been consumed so it can clear
    // focusAisleNum and prevent repeated re-centering on future tab visits.
    onFocusConsumed?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusAisleNum]);

  // Shared helper: run the focus logic using current ref values.
  // Called by the two deferred-retry effects below so the logic stays in one place.
  // All reads go through refs/closure values that are stable by the time either
  // retry fires.  Returns true if focus was consumed (either successfully or via
  // failure callbacks), false if preconditions were not met.
  const _runPendingFocus = useCallback((): boolean => {
    if (!pendingFocusRef.current) return false;
    if (!zonesRef.current.length) return false;
    const w = containerWRef.current;
    const h = containerHRef.current;
    if (w === 0 || h === 0 || focusAisleNum == null) return false;
    pendingFocusRef.current = false;

    const zoneExists = zonesRef.current.some(z => parseInt(z.aisleId, 10) === focusAisleNum);
    if (!zoneExists) {
      onFocusFailed?.();
      onFocusConsumed?.();
      return true;
    }

    const aisleZones = zonesRef.current.filter(z => parseInt(z.aisleId, 10) === focusAisleNum);
    const zone =
      focusSectionNum != null
        ? (aisleZones.find(z => z.sectionNum === focusSectionNum) ?? aisleZones[0])
        : aisleZones[0];

    if (zone) {
      pinFocusCxV.value = zone.svgX + zone.svgWidth  / 2;
      pinFocusCyV.value = zone.svgY + zone.svgHeight / 2;
      pinFocusModeV.value = 1;
    }

    applyFitRef.current();
    onFocusConsumed?.();
    return true;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusAisleNum, focusSectionNum, onFocusFailed, onFocusConsumed]);

  // Retry focus once zones arrive (covers: focus requested before first zone load).
  // Only `zones` is a dependency so zone refreshes that arrive after focus is
  // already consumed do not re-trigger.
  useEffect(() => {
    _runPendingFocus();
  }, [zones, _runPendingFocus]);

  // Retry focus when the container lays out (covers: focus requested before
  // first layout while zones were already loaded).
  // pendingFocusRef.current is the gate that prevents orientation changes
  // after focus is consumed from re-triggering the zoom.
  useEffect(() => {
    _runPendingFocus();
  }, [containerW, containerH, _runPendingFocus]);

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
    const { scale: s, tx, ty } = computeFitTarget(vb, w, h);
    scale.value = s;
    savedScale.value = s;
    translateX.value = tx;
    translateY.value = ty;
    savedTX.value = tx;
    savedTY.value = ty;
    setRenderZoom(zoomStopForScale(s));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the indirection refs current so effects declared before the callbacks
  // always call the latest version without stale-closure issues.
  applyFitIfReadyRef.current = applyFitIfReady;

  /**
   * Animate to the fit-to-content viewport.  Falls back to scale=1/tx=0/ty=0
   * if the SVG viewBox has not been parsed yet.  Used by the Fit button, the
   * double-tap-to-reset gesture, and the pin auto-focus path.
   *
   * Sets springActive for the duration of the spring so the tile-tier reaction
   * does not fire on every integer boundary the scale crosses during zoom-out.
   * The tier commits exactly once in the scale spring's onEnd callback, matching
   * the same pattern used by applyZoom for button-driven zooms.
   */
  const applyFit = useCallback(() => {
    const vb = contentVBRef.current;
    const w = containerWRef.current;
    const h = containerHRef.current;

    let targetS: number;
    let targetTX: number;
    let targetTY: number;

    if (!vb || w === 0) {
      targetS = 1; targetTX = 0; targetTY = 0;
    } else {
      ({ scale: targetS, tx: targetTX, ty: targetTY } = computeFitTarget(vb, w, h));
    }

    springActive.value = true;
    springGeneration.value += 1;
    const myGen = springGeneration.value;

    scale.value = withSpring(targetS, { damping: 26, stiffness: 220 }, () => {
      'worklet';
      if (springGeneration.value !== myGen) return;
      springActive.value = false;
      runOnJS(setRenderZoom)(zoomStopForScale(targetS));
    });
    translateX.value = withSpring(targetTX, { damping: 26, stiffness: 220 });
    translateY.value = withSpring(targetTY, { damping: 26, stiffness: 220 });
    savedScale.value = targetS;
    savedTX.value = targetTX;
    savedTY.value = targetTY;
    persistViewport(targetS, targetTX, targetTY);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistViewport]);

  // Keep applyFitRef current so the focusAisleNum effect always calls the
  // latest applyFit closure (which captures persistViewport).
  applyFitRef.current = applyFit;

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
      // Cancel any pending snapshot expiry timer to avoid a dangling
      // setTimeout touching an unmounted component's refs.
      if (bgSnapshotExpireTimerRef.current !== null) {
        clearTimeout(bgSnapshotExpireTimerRef.current);
        bgSnapshotExpireTimerRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── AppState listener — snapshot viewport on background ───────────────────
  // When the app moves to background the OS may subsequently deliver a layout
  // event (e.g. because the device is rotated while suspended) before or just
  // after the app resumes.  If that happens, containerWRef.current and
  // savedTX/TY may have already been updated by the time onLayout runs for the
  // "real" resume event, making the ratio calculation produce the wrong result.
  //
  // The fix: snapshot {w, tx, ty} at the moment of backgrounding.  The next
  // onLayout call reads from the snapshot (not the live refs) so the ratio is
  // always W_resume / W_pre-suspension, not W_resume / W_mid-transition.
  //
  // We also flush the debounced persist timer immediately so AsyncStorage is
  // always up-to-date before the OS suspends the process.
  useEffect(() => {
    const handleAppStateChange = (nextState: AppStateStatus) => {
      if (nextState === "background" || nextState === "inactive") {
        bgSnapshotRef.current = {
          w: containerWRef.current,
          tx: savedTX.value,
          ty: savedTY.value,
        };
        // Flush any pending debounced viewport write so the OS doesn't suspend
        // the process before the AsyncStorage write completes.
        if (_persistTimer.current !== null) {
          clearTimeout(_persistTimer.current);
          _persistTimer.current = null;
          AsyncStorage.setItem(
            VIEWPORT_KEY,
            JSON.stringify({ s: savedScale.value, tx: savedTX.value, ty: savedTY.value }),
          ).catch(() => {});
        }
      } else if (nextState === "active") {
        // Schedule snapshot expiry.  The OS can deliver the post-resume layout
        // event either BEFORE or AFTER the `active` AppState event:
        //   • layout before active  — onLayout already consumed & cleared the
        //     snapshot; the timer starts on a null ref and is a no-op.
        //   • active before layout  — timer starts; onLayout will arrive within
        //     a frame or two (~16-32 ms), cancel the timer and consume the
        //     snapshot before it expires.
        //   • active, no layout at all (same orientation on resume) — timer
        //     fires after 500 ms, clearing the stale snapshot so that the next
        //     normal foreground rotation uses live refs instead of pre-
        //     suspension values.
        bgSnapshotExpireTimerRef.current = setTimeout(() => {
          bgSnapshotRef.current = null;
          bgSnapshotExpireTimerRef.current = null;
        }, 500);
      }
    };

    const sub = AppState.addEventListener("change", handleAppStateChange);
    return () => sub.remove();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Viewport startup fit ─────────────────────────────────────────────────────
  // Fresh app opens always fit the floor plan to screen — saved viewports are
  // NOT restored on mount so the map is always centred when the user opens it.
  // Within a single JS session, pan/zoom position is preserved through shared
  // values (the component stays mounted while tabs are switching), so tab-switch
  // continuity works without any storage read.  The position is still written
  // by persistViewport so it is available for a future "Resume last session"
  // feature, but it is never read back here.
  //
  // This keeps pendingFit.current = true so applyFitIfReady fires once both
  // contentVBRef and containerW are populated.  If onLayout has already fired
  // before this effect runs (uncommon), we call applyFitIfReady directly.
  useEffect(() => {
    if (hasLaidOut.current) applyFitIfReadyRef.current();
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

  // renderZoom is the committed zoom-stop index (0–4).  It only changes when
  // a spring animation settles on a discrete ZOOM_STOPS entry, preventing
  // tile-grid churn during continuous pinch gestures.
  // Initial value 0 = z0 (overview stop, scale≈1.5×).
  const [renderZoom, setRenderZoom] = useState(0);

  // numTiles is the tile-grid dimension for the current zoom stop: 2^renderZoom.
  // z0 → 1×1, z1 → 2×2, z2 → 4×4, z3 → 8×8, z4 → 16×16.
  const numTiles = tileGridSize(renderZoom);

  // ── Visible-tile culling ──────────────────────────────────────────────────
  // Shared values that mirror JS state so the UI-thread reaction can read them
  // without requiring runOnJS on every gesture frame.
  const numTilesV = useSharedValue(1);
  const svgRenderWV = useSharedValue(svgRenderW);
  const svgAspectV = useSharedValue(svgAspect);
  const svgVBWV = useSharedValue(contentVB ? contentVB.w : SVG_VIEWBOX_W);
  const svgVBHV = useSharedValue(contentVB ? contentVB.h : SVG_VIEWBOX_H);
  useEffect(() => { numTilesV.value = numTiles; }, [numTiles, numTilesV]);
  useEffect(() => { svgRenderWV.value = svgRenderW; }, [svgRenderW, svgRenderWV]);
  useEffect(() => {
    svgAspectRef.current = svgAspect;
    svgAspectV.value = svgAspect;
    svgVBWV.value = contentVB ? contentVB.w : SVG_VIEWBOX_W;
    svgVBHV.value = contentVB ? contentVB.h : SVG_VIEWBOX_H;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentVB, svgAspect, svgAspectV, svgVBWV, svgVBHV]);

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
      const H = W / svgAspectV.value;
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

  // svgHash is the content-hash of the currently loaded floor plan SVG.
  // It is used as a cache-directory key for PNG tiles so stale tiles are never
  // served after an admin uploads a new floor plan.
  const [svgHash, setSvgHash] = useState(() => getCachedHash() ?? "");
  const svgHashRef = useRef(svgHash);
  useEffect(() => { svgHashRef.current = svgHash; }, [svgHash]);

  // Normalized SVG string for native SvgXml rendering.
  // If the uploaded SVG has a non-zero viewBox origin (viewBox="X Y W H" where
  // X or Y ≠ 0), the SvgXml renderer would show a different coordinate origin
  // than the zone overlay, causing zone rectangles to appear offset from the
  // floor-plan drawing.  We rewrite the outer <svg> viewBox to "0 0 W H" so
  // both layers share the same (0, 0) origin — matching how the ZoneEditor
  // normalises coordinates when it strips the outer <svg> wrapper.
  const normalizedSvgXml = useMemo(() => {
    if (!svgXml || !contentVB) return svgXml;
    if (contentVB.x === 0 && contentVB.y === 0) return svgXml;
    return svgXml.replace(
      /viewBox="[^"]*"/,
      `viewBox="0 0 ${contentVB.w} ${contentVB.h}"`,
    );
  }, [svgXml, contentVB]);

  // ── Server floor-plan ETag wiring ────────────────────────────────────────
  // Poll /floor-plan/meta every 60 s while mounted.  When the server returns a
  // different hash than the one first seen after mount (i.e. an admin uploaded a
  // new floor plan), increment serverHashChanged to re-run the SVG load effect
  // and pull the updated SVG without requiring an app restart.
  const [serverHashChanged, setServerHashChanged] = useState(0);
  const knownServerHashRef = useRef<string | null>(null);

  useEffect(() => {
    if (!API_BASE) return;
    let cancelled = false;
    async function checkServerHash() {
      try {
        const res = await fetchWithAuth(`${API_BASE}/floor-plan/meta`);
        if (!res.ok || cancelled) return;
        const { hash } = FloorPlanMetaSchema.parse(await res.json());
        if (cancelled) return;
        if (knownServerHashRef.current === null) {
          // Record baseline hash on first successful fetch.
          knownServerHashRef.current = hash;
        } else if (hash !== knownServerHashRef.current) {
          // Hash changed while mounted — trigger a cache-busting SVG reload.
          knownServerHashRef.current = hash;
          setServerHashChanged(n => n + 1);
        }
      } catch {
        // Non-fatal — server may be temporarily unavailable.
      }
    }
    checkServerHash(); // immediate first check to establish baseline
    const id = setInterval(checkServerHash, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Load the SVG floor plan.  Runs once on mount (serverHashChanged === 0) and
  // again whenever the server reports a new floor-plan hash (serverHashChanged > 0).
  useEffect(() => {
    let cancelled = false;
    const isServerUpdate = serverHashChanged > 0;

    if (!isServerUpdate && hasCachedData()) return; // already cached, no server update

    if (isServerUpdate) {
      // Admin uploaded a new floor plan while the app was open.  Bust the
      // in-memory cache and reset the load promise so loadSvgAsset() issues
      // a fresh fetch instead of returning the stale cached entry.
      resetForServerUpdate();
      _svgLoadPromise = null;
      setSvgUri(""); setInnerXml(""); setSvgXml("");
      setSvgLoading(true);
    }

    (async () => {
      // Wait for the AsyncStorage read that was kicked off at module load.
      // For returning users this is typically already resolved by the time
      // the component mounts, so it costs at most one microtick.
      await _persistReadPromise;

      // getCachedData() returns SvgData | null — no cast needed here since it
      // is a function call (TypeScript narrows const locals correctly).
      const afterPersist = getCachedData();
      if (afterPersist !== null && !isServerUpdate && !cancelled) {
        // Persisted data available — update state right away so the skeleton
        // never appears for returning users.
        setSvgUri(afterPersist.uri);
        setInnerXml(afterPersist.innerXml);
        setSvgXml(afterPersist.xml);
        setSvgHash(getCachedHash() ?? "");
        setSvgLoading(false);
      }

      // Resolve the asset and validate the hash.  If the hash matches the
      // persisted entry, loadSvgAsset() returns after Asset.loadAsync with
      // no network fetch.  If the hash has changed (new build or server update),
      // it re-fetches and writes the updated entry back to AsyncStorage.
      await loadSvgAsset();
      if (cancelled) return;
      const afterLoad = getCachedData();
      if (afterLoad) {
        setSvgUri(afterLoad.uri);
        setInnerXml(afterLoad.innerXml);
        setSvgXml(afterLoad.xml);
        setSvgHash(getCachedHash() ?? "");
      }
      setSvgLoading(false);
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverHashChanged]);

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

  // ── Tile pyramid warmup + stale-cache cleanup ────────────────────────────
  // When the SVG hash is known, pre-warm z0–z2 in the background so the first
  // zoom-in lands on cached tiles with no visible fetch latency.  On unmount
  // (or when the hash changes), remove any tile-cache directories whose hash
  // no longer matches the current floor plan to prevent unbounded disk usage.
  useEffect(() => {
    if (!svgHash || Platform.OS === "web") return;
    // Kick off warmup via the API so z0–z2 tiles are cached before the user
    // zooms in.  warmupTiles() is fire-and-forget and non-fatal.
    warmupTiles(svgHash).catch(() => {});
    // Also clean stale on-device cache dirs from previous floor-plan versions.
    cleanStaleCacheDirs(svgHash).catch(() => {});
  }, [svgHash]);

  // ── Crossfade between tile tiers ─────────────────────────────────────────
  // When the zoom stop commits (numTiles changes), the old tile grid is kept
  // mounted in a fade-out layer while the new PNG tiles fade in over 150 ms
  // so there is never a blank frame at the boundary.
  //
  // The snapshot of the previous tier's tiles is captured during render via
  // two refs that are updated at the end of every render cycle:
  //   prevRenderZoomRef  — renderZoom from the last render (zoom stop index)
  //   prevTilesRef       — tiles[] from the last render
  // On the render where renderZoom changes, these still hold the OLD values
  // (they were written at the end of the previous render), giving us the
  // exact tile set to fade out.
  interface TileSpec { col: number; row: number; }
  interface FadeLayer { tiles: Array<TileSpec>; z: number; numTiles: number; }

  const prevRenderZoomRef = useRef(renderZoom);
  const prevTilesRef = useRef<Array<TileSpec>>([]);
  const pendingFadeRef = useRef<FadeLayer | null>(null);
  const [fadeOutLayer, setFadeOutLayer] = useState<FadeLayer | null>(null);
  const fadeOutOpacity = useSharedValue(0);
  const tileLayerOpacity = useSharedValue(1);

  // Detect a tier change BEFORE the tiles useMemo recomputes so we can
  // snapshot the old tiles still stored in prevTilesRef.
  const isTierChange = Platform.OS !== "web" && renderZoom !== prevRenderZoomRef.current;
  if (isTierChange && prevTilesRef.current.length > 0) {
    // Filter to the currently visible range so the fade-out layer never
    // contains the entire grid on large zoom levels (e.g. z4 = 16×16).
    // visibleRange is current JS state, which reflects the old tier's
    // visible tile set at the moment the tier change is first detected.
    // Fallback to the full set only if the filter yields nothing (edge case).
    const vr = visibleRange;
    const visibleOldTiles = prevTilesRef.current.filter(
      ({ col, row }) => col >= vr.c0 && col <= vr.c1 && row >= vr.r0 && row <= vr.r1,
    );
    pendingFadeRef.current = {
      tiles: visibleOldTiles.length > 0 ? visibleOldTiles : prevTilesRef.current,
      z: prevRenderZoomRef.current,
      numTiles: tileGridSize(prevRenderZoomRef.current),
    };
  }

  // ── Tile position memoisation ─────────────────────────────────────────────
  // Produces (col, row) pairs for each visible tile.  Recomputes only when
  // the visible range or numTiles changes — not on every animation frame.
  // PNG tile URIs are fetched asynchronously inside PngTile components so
  // this memo stays pure and fast.
  const tiles = useMemo<Array<TileSpec>>(() => {
    // Web: floor plan is embedded inside the shared SVG viewport — no tiling.
    // Native only: PNG tile grid.
    if (numTiles <= 1 || !svgHash || Platform.OS === "web") return [];
    const N = numTiles;
    const { c0, c1, r0, r1, N: rangeN } = visibleRange;
    if (rangeN !== N) return [];
    const result: Array<TileSpec> = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        result.push({ col: c, row: r });
      }
    }
    return result;
  }, [numTiles, svgHash, visibleRange]);

  // Update the snapshot refs at the END of every render so next render sees
  // the values from this render (ref mutations during render are safe in React).
  prevRenderZoomRef.current = renderZoom;
  prevTilesRef.current = tiles;

  // Trigger the crossfade animation whenever the tile tier commits.
  // pendingFadeRef holds the old tiles captured during this render (above).
  useEffect(() => {
    if (Platform.OS === "web") return;
    const snap = pendingFadeRef.current;
    pendingFadeRef.current = null;
    if (!snap || snap.tiles.length === 0) {
      // No old tiles to cross-dissolve (e.g. first zoom past 1 → 2), but
      // still fade the new tile layer in so it appears without a hard pop.
      tileLayerOpacity.value = 0;
      tileLayerOpacity.value = withTiming(1, { duration: 150 });
      return;
    }
    setFadeOutLayer(snap);
    // New layer: snap opacity from 0 → 1 so tiles appear as they paint.
    tileLayerOpacity.value = 0;
    tileLayerOpacity.value = withTiming(1, { duration: 150 });
    // Old layer: fade out in sync, then unmount.
    fadeOutOpacity.value = 1;
    fadeOutOpacity.value = withTiming(0, { duration: 150 }, (finished) => {
      if (finished) runOnJS(setFadeOutLayer)(null);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderZoom]);

  const tileLayerAnimatedStyle = useAnimatedStyle(() => ({
    opacity: tileLayerOpacity.value,
  }));
  const fadeOutAnimatedStyle = useAnimatedStyle(() => ({
    opacity: fadeOutOpacity.value,
  }));

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

  // ── Prefetch helpers ──────────────────────────────────────────────────────
  // Declared before pinchGesture to avoid a TDZ forward-reference: the React
  // Compiler reads callback bindings during render to memoize them, so any
  // local const passed to runOnJS() must be initialised first.
  // Debounce tile prefetch so rapid zoom taps don't fan out dozens of fetches.
  // An AbortController cancels tiles still being downloaded when the user
  // starts a new gesture before the previous prefetch finishes.
  const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prefetchAbortRef = useRef<AbortController | null>(null);
  const visibleRangeRef = useRef(visibleRange);
  useEffect(() => { visibleRangeRef.current = visibleRange; }, [visibleRange]);

  const _cancelPrefetch = useCallback(() => {
    if (prefetchTimerRef.current !== null) {
      clearTimeout(prefetchTimerRef.current);
      prefetchTimerRef.current = null;
    }
    if (prefetchAbortRef.current !== null) {
      prefetchAbortRef.current.abort();
      prefetchAbortRef.current = null;
    }
  }, []);

  const _triggerPrefetch = useCallback((stopIdx: number) => {
    _cancelPrefetch();
    const nextStop = Math.min(ZOOM_STOPS.length - 1, stopIdx + 1);
    if (nextStop === stopIdx || Platform.OS === "web") return;
    prefetchTimerRef.current = setTimeout(() => {
      const hash = svgHashRef.current;
      if (!hash) return;

      // Compute the visible range in NEXT-level grid coordinates.
      // visibleRangeRef holds indices for the current (stopIdx) grid;
      // the next level doubles the grid in each dimension.  Re-derive from
      // the raw viewport transform so the result is always in nextStop-space.
      const nextN = tileGridSize(nextStop);
      const W = svgRenderWV.value;
      if (W <= 0) return;
      const H = W / svgAspectV.value;
      const Z = scale.value;
      const tx = translateX.value;
      const ty = translateY.value;
      const cW = containerWRef.current;
      const cH = containerHRef.current;
      if (cW <= 0 || cH <= 0) return;
      const tileW = W / nextN;
      const tileH = H / nextN;
      const visCX = W / 2 - tx / Z;
      const visCY = H / 2 - ty / Z;
      const visW = cW / Z;
      const visH = cH / Z;
      const nextRange = {
        c0: Math.max(0, Math.floor((visCX - visW / 2) / tileW) - 1),
        c1: Math.min(nextN - 1, Math.ceil((visCX + visW / 2) / tileW)),
        r0: Math.max(0, Math.floor((visCY - visH / 2) / tileH) - 1),
        r1: Math.min(nextN - 1, Math.ceil((visCY + visH / 2) / tileH)),
      };

      const ctrl = new AbortController();
      prefetchAbortRef.current = ctrl;
      prefetchZoomLevel(nextStop, nextRange, hash, ctrl.signal).catch(() => {});
    }, 300);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [_cancelPrefetch]);

  // ── Snap to nearest ZOOM_STOP after pinch ends ────────────────────────────
  // Called via runOnJS from the pinch gesture onEnd worklet.  Springs the
  // scale to the nearest discrete stop, then commits the stop index to
  // renderZoom and kicks off a debounced prefetch of the next stop's tiles.
  //
  // Direction clamping: the nearest stop by log-distance can sometimes be on
  // the opposite side of the gesture (e.g. a slight zoom-in from 4× to 2.8×
  // finds 4× as nearest but the user was zooming out).  To prevent the map
  // from appearing to jump against the gesture direction, we clamp the chosen
  // stop so it never crosses the current scale in the opposite direction.
  const snapToNearestZoomStop = useCallback(() => {
    const currentScale = scale.value;
    const gestureStartScale = savedScale.value;
    const zoomingIn = currentScale >= gestureStartScale;

    let stopIdx = zoomStopForScale(currentScale);

    // If the nearest stop is in the wrong direction, walk to the closest
    // stop that respects the gesture direction.
    if (zoomingIn && ZOOM_STOPS[stopIdx].scale < currentScale) {
      // Zooming in: find the lowest stop at or above current scale.
      const idx = ZOOM_STOPS.findIndex(s => s.scale >= currentScale);
      stopIdx = idx === -1 ? ZOOM_STOPS.length - 1 : idx;
    } else if (!zoomingIn && ZOOM_STOPS[stopIdx].scale > currentScale) {
      // Zooming out: find the highest stop at or below current scale.
      let idx = -1;
      for (let i = ZOOM_STOPS.length - 1; i >= 0; i--) {
        if (ZOOM_STOPS[i].scale <= currentScale) { idx = i; break; }
      }
      stopIdx = idx === -1 ? 0 : idx;
    }

    const targetScale = ZOOM_STOPS[stopIdx].scale;
    pinFocusModeV.value = 0;
    const { maxX, maxY } = panBounds(containerWRef.current, containerHRef.current, targetScale, containerWRef.current / svgAspectRef.current);
    const newTX = Math.max(-maxX, Math.min(maxX, translateX.value));
    const newTY = Math.max(-maxY, Math.min(maxY, translateY.value));
    springActive.value = true;
    springGeneration.value += 1;
    const myGen = springGeneration.value;
    scale.value = withSpring(targetScale, { damping: 26, stiffness: 220 }, () => {
      'worklet';
      if (springGeneration.value !== myGen) return;
      springActive.value = false;
      runOnJS(setRenderZoom)(stopIdx);
      runOnJS(_triggerPrefetch)(stopIdx);
    });
    translateX.value = withSpring(newTX, { damping: 26, stiffness: 220 });
    translateY.value = withSpring(newTY, { damping: 26, stiffness: 220 });
    savedScale.value = targetScale;
    savedTX.value = newTX;
    savedTY.value = newTY;
    persistViewport(targetScale, newTX, newTY);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistViewport, _triggerPrefetch]);

  // ── Pinch gesture ──────────────────────────────────────────────────────────
  const pinchGesture = Gesture.Pinch()
    .onBegin(() => {
      'worklet';
      runOnJS(_cancelPrefetch)();
    })
    .onUpdate((e) => {
      const newScale = clamp(savedScale.value * e.scale, MIN_SCALE, MAX_SCALE);
      scale.value = newScale;

      // Scale ratio relative to the baseline captured at gesture start.
      const ratio = savedScale.value > 0 ? newScale / savedScale.value : 1;

      // In pin-focus mode the zoom pivots around the pin marker so it stays
      // centred on screen as the user zooms in.  The pin's screen position is
      // computed from savedScale/savedTX (gesture baseline) using the same
      // coordinate transform as the SVG canvas:
      //   screenX = (cx/VBW)*svgRW - svgRW/2) * savedScale + savedTX
      // Otherwise use the normal pinch focal point.
      //
      // Focal point in container-centre-relative coordinates:
      // e.focalX/Y are in container-local space (0,0 = top-left), so subtract
      // half the container size to get the offset from the visual centre.
      let focalX: number;
      let focalY: number;
      if (pinFocusModeV.value) {
        const svgRW = containerWV.value;
        const svgRH = containerWV.value / svgAspectV.value;
        const px = (pinFocusCxV.value / svgVBWV.value) * svgRW - svgRW / 2;
        const py = (pinFocusCyV.value / svgVBHV.value) * svgRH - svgRH / 2;
        focalX = px * savedScale.value + savedTX.value;
        focalY = py * savedScale.value + savedTY.value;
      } else {
        focalX = e.focalX - containerWV.value / 2;
        focalY = e.focalY - containerHV.value / 2;
      }

      // Translate so the map point under the focal point stays fixed:
      //   newTX = focalX - (focalX - savedTX) * ratio
      //         = focalX * (1 - ratio) + savedTX * ratio
      const newTX = focalX * (1 - ratio) + savedTX.value * ratio;
      const newTY = focalY * (1 - ratio) + savedTY.value * ratio;

      const scaledW = containerWV.value * newScale;
      const scaledH = (containerWV.value / svgAspectV.value) * newScale;
      const maxX = Math.max(0, (scaledW - containerWV.value) / 2);
      const maxY = Math.max(0, (scaledH - containerHV.value) / 2);
      translateX.value = clamp(newTX, -maxX, maxX);
      translateY.value = clamp(newTY, -maxY, maxY);
    })
    .onEnd(() => {
      'worklet';
      // Snap the scale to the nearest discrete zoom stop and commit the stop
      // index to renderZoom via a short spring.  savedScale/TX/TY are written
      // inside snapToNearestZoomStop with the snapped values, not the raw
      // finger-release position.
      runOnJS(snapToNearestZoomStop)();
    });

  // Stable ref for onPanStart so the worklet always calls the latest version
  // without needing to re-create the gesture on every render.
  const onPanStartRef = useRef<(() => void) | undefined>(onPanStart);
  useEffect(() => { onPanStartRef.current = onPanStart; }, [onPanStart]);
  const _firePanStart = useCallback(() => { onPanStartRef.current?.(); }, []);

  // ── Pan gesture (minDistance prevents tap interference) ────────────────────
  const panGesture = Gesture.Pan()
    .minPointers(1)
    .minDistance(6)
    .onBegin(() => {
      'worklet';
      // A pan gesture ends the pin-focus-zoom phase so subsequent pinches
      // revert to the normal finger-focal-point behaviour.
      pinFocusModeV.value = 0;
      runOnJS(_cancelPrefetch)();
      runOnJS(_firePanStart)();
    })
    .onUpdate((e) => {
      const scaledW = containerWV.value * scale.value;
      const scaledH = (containerWV.value / svgAspectV.value) * scale.value;
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
      // Double-tap is a manual map reset — end pin-focus mode so the next
      // pinch after the reset uses the normal finger-focal-point behaviour.
      pinFocusModeV.value = 0;
      runOnJS(applyFit)();
    });

  const mainGesture = Gesture.Exclusive(
    doubleTapGesture,
    Gesture.Simultaneous(pinchGesture, panGesture),
  );

  // ── Programmatic zoom helpers (zoom buttons) ────────────────────────────────
  const applyZoom = useCallback((targetScale: number) => {
    // Zoom buttons end pin-focus mode; subsequent pinches revert to normal.
    pinFocusModeV.value = 0;
    const oldScale = savedScale.value;
    const newScale = clampScale(targetScale);
    const { maxX, maxY } = panBounds(containerW, containerH, newScale, svgRenderH);
    // Scale the existing translation by the zoom ratio so the visible center
    // stays anchored. At zoom=1 the map center is at tx=0; as the user pans,
    // tx/ty drift. Multiplying by newScale/oldScale keeps the same map point
    // at the screen centre both before and after the zoom step.
    const ratio = oldScale > 0 ? newScale / oldScale : 1;
    const newTX = Math.max(-maxX, Math.min(maxX, translateX.value * ratio));
    const newTY = Math.max(-maxY, Math.min(maxY, translateY.value * ratio));
    springActive.value = true;
    springGeneration.value += 1;
    const myGen = springGeneration.value;
    scale.value = withSpring(newScale, { damping: 26, stiffness: 220 }, () => {
      'worklet';
      // Guard: only the most-recent spring clears the gate and commits a tier.
      // If the user tapped zoom again, springGeneration was already incremented
      // and this callback belongs to a superseded spring — skip it entirely.
      if (springGeneration.value !== myGen) return;
      springActive.value = false;
      const stopIdx = zoomStopForScale(newScale);
      runOnJS(setRenderZoom)(stopIdx);
      runOnJS(_triggerPrefetch)(stopIdx);
    });
    translateX.value = withSpring(newTX, { damping: 26, stiffness: 220 });
    translateY.value = withSpring(newTY, { damping: 26, stiffness: 220 });
    savedScale.value = newScale;
    savedTX.value = newTX;
    savedTY.value = newTY;
    persistViewport(newScale, newTX, newTY);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svgRenderW, svgRenderH, containerW, containerH, persistViewport, _triggerPrefetch]);

  // Zoom buttons step through discrete ZOOM_STOPS rather than multiplying by
  // a fixed ratio, so each tap lands exactly on a preset stop.
  const handleZoomIn = useCallback(() => {
    const currentStop = zoomStopForScale(scale.value);
    const nextStop = Math.min(ZOOM_STOPS.length - 1, currentStop + 1);
    applyZoom(ZOOM_STOPS[nextStop].scale);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyZoom]);

  const handleZoomOut = useCallback(() => {
    const currentStop = zoomStopForScale(scale.value);
    const prevStop = Math.max(0, currentStop - 1);
    applyZoom(ZOOM_STOPS[prevStop].scale);
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
    ...(Platform.OS === "web" ? { cursor: "grab" as unknown as "auto" } : {}),
  }));

  // ── SVG zone overlays (viewBox coordinate space) ───────────────────────────
  // Each ZoneOverlayItem uses useAnimatedProps to drive strokeWidth and fontSize
  // on the UI thread — visual weight stays constant as zoom changes with zero
  // JS re-renders during pinch or button-driven spring animations.
  // Zone geometry (x/y/w/h) is static and correctly tracks the floor plan.
  const zoneOverlays = useMemo(() => {
    if (!zones.length) return null;
    return zones.map((zone) => {
      const aisleNum = parseInt(zone.aisleId, 10);
      const isPinned = !cycleMode && (pinnedZoneIds?.has(zone.id) ?? false);
      // Allow a zone to be BOTH primary-pinned and variant-pinned simultaneously
      // so variant locations sharing a zone are shown with their distinct purple
      // treatment alongside the amber primary marker.
      const isVariantPinned = !cycleMode && (variantZoneIds?.has(zone.id) ?? false);
      return (
        <ZoneOverlayItem
          key={zone.id}
          zone={zone}
          scale={scale}
          colors={colors}
          onZoneTap={selectMode ? onZoneTap : () => undefined}
          onZoneLongPress={onZoneLongPress}
          cycleMode={cycleMode}
          isCounted={countedZoneIds?.has(zone.id) ?? false}
          isPinned={isPinned}
          isVariantPinned={isVariantPinned}
          isSelected={!cycleMode && zone.id === selectedZoneId}
          binLabel={(isPinned || isVariantPinned) ? pinnedBinLabels?.get(aisleNum) : undefined}
          pinnedSections={isPinned ? pinnedSectionsMap?.get(aisleNum) : undefined}
          variantSections={isVariantPinned ? variantSectionsMap?.get(aisleNum) : undefined}
        />
      );
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zones, colors, onZoneTap, onZoneLongPress, cycleMode, selectMode, countedZoneIds, pinnedZoneIds, variantZoneIds, pinnedBinLabels, pinnedSectionsMap, variantSectionsMap, selectedZoneId]);

  // ── Early return before layout ─────────────────────────────────────────────
  if (containerW === 0) {
    return <View style={[styles.fill, { backgroundColor: colors.background }]} onLayout={onLayout} />;
  }

  return (
    <View style={[styles.fill, { backgroundColor: colors.background }]} onLayout={onLayout}>
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
                ]}
              >
                {/* ── Base single-tile layer ────────────────────────────────
                    Always mounted when SVG data is available so the SVG
                    rasteriser keeps this tile painted at all times.
                    When the tile grid is active (numTiles > 1) this layer
                    sits silently underneath it; when the tier drops back to
                    1 the grid fades away and this layer is immediately
                    visible at full quality — no re-mount, no repaint delay.
                    SvgXml multiplies dimensions by PixelRatio internally so
                    logical dimensions already produce full DPR quality. */}
                {svgXml ? (
                  <SvgXml xml={normalizedSvgXml} width={svgRenderW} height={svgRenderH} />
                ) : svgUri ? (
                  // Cold-start fallback — svgXml not yet available; use SvgUri
                  // which can render from the URI while the XML fetch completes.
                  // SvgUri also handles DPR internally — no oversample needed.
                  <SvgUri uri={svgUri} width={svgRenderW} height={svgRenderH} />
                ) : null}
                {/* ── Crossfade fade-out layer ──────────────────────────────
                    Holds the previous tier's tiles while new tiles render.
                    Fades from 1→0 over 150 ms in sync with the new layer
                    fading in, so there is never a blank frame at the boundary.
                    Rendered above the base layer, below the main tile layer,
                    so the new tiles always appear on top as they paint. */}
                {fadeOutLayer && fadeOutLayer.numTiles > 1 && (
                  <Animated.View
                    style={[StyleSheet.absoluteFill, fadeOutAnimatedStyle]}
                    pointerEvents="none"
                  >
                    {fadeOutLayer.tiles.map(({ col, row }) => (
                      <PngTile
                        key={`fade-${col}-${row}`}
                        z={fadeOutLayer.z}
                        col={col}
                        row={row}
                        svgHash={svgHash}
                        tileW={svgRenderW / fadeOutLayer.numTiles}
                        tileH={svgRenderH / fadeOutLayer.numTiles}
                      />
                    ))}
                  </Animated.View>
                )}
                {/* ── Main tile layer — fades in on zoom-stop commit ─────── */}
                <Animated.View style={[StyleSheet.absoluteFill, tileLayerAnimatedStyle]}>
                  {numTiles > 1 && tiles.length > 0
                    ? tiles.map(({ col, row }) => (
                        <PngTile
                          key={`${col}-${row}`}
                          z={renderZoom}
                          col={col}
                          row={row}
                          svgHash={svgHash}
                          tileW={svgRenderW / numTiles}
                          tileH={svgRenderH / numTiles}
                        />
                      ))
                    : null}
                </Animated.View>
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
            viewBox={contentVB
              ? `0 0 ${contentVB.w} ${contentVB.h}`
              : `0 0 ${SVG_VIEWBOX_W} ${SVG_VIEWBOX_H}`}
            width={svgRenderW}
            height={svgRenderH}
          >
            {Platform.OS === "web" && innerXml
              ? React.createElement(
                  "g" as unknown as React.ElementType,
                  {
                    dangerouslySetInnerHTML: {
                      __html: DOMPurify.sanitize(innerXml, {
                        USE_PROFILES: { svg: true, svgFilters: true },
                        FORCE_BODY: false,
                      }),
                    },
                    style: { filter: "invert(1) brightness(0.88)" },
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

      {/* Zoom controls — bottom-right cluster: Select on top, + below, − below, fit at bottom */}
      <View style={styles.zoomControls}>
        <Pressable
          onPress={() => onSelectModeChange?.(!selectMode)}
          style={({ pressed }) => [
            styles.zoomBtn,
            styles.zoomBtnTop,
            {
              backgroundColor: selectMode ? colors.primary : colors.card,
              borderColor: selectMode ? colors.primary : colors.border,
              opacity: pressed ? 0.7 : 1,
            },
          ]}
          accessibilityLabel={selectMode ? "Disable select mode" : "Enable select mode"}
        >
          <Feather name="mouse-pointer" size={15} color={selectMode ? "#fff" : colors.foreground} />
        </Pressable>
        <Pressable
          onPress={handleZoomIn}
          style={({ pressed }) => [
            styles.zoomBtn,
            styles.zoomBtnMid,
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
            ? "Long-press a zone to mark counted"
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
    boxShadow: "0 2px 4px rgba(0,0,0,0.12)",
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
    boxShadow: "0 2px 4px rgba(0,0,0,0.12)",
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
