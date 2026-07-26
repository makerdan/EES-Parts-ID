/**
 * Admin Map Calibration Screen
 *
 * Allows an admin to place up to 3 named anchor points on the warehouse
 * floor-plan SVG.  Each anchor maps an SVG tap coordinate to a zone-data
 * (world) coordinate.  When all 3 are saved the app computes a full 6-DOF
 * affine transform that aligns the zone overlay with the floor plan.
 *
 * Route: /admin-map-calibration
 */
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated from "react-native-reanimated";
import { Circle, G, Rect, Svg, SvgXml, Text as SvgText } from "react-native-svg";

import { prefetchSvgAsset } from "@/components/WarehouseMapView";
import { useApp } from "@/contexts/AppContext";
import { useColors } from "@/hooks/useColors";
import { type MapAnchor, type UpsertAnchorPayload, useMapAnchors } from "@/hooks/useMapAnchors";
import { useWarehouseZones } from "@/hooks/useWarehouseZones";
import {
  getCachedData,
  hasCachedData,
} from "@/utils/floorPlanCache";
import {
  type AnchorPoint,
  computeAnchorTransform,
  matrixToSvgString,
} from "@/utils/mapAnchorTransform";
import {
  SVG_VIEWBOX_H,
  SVG_VIEWBOX_W,
} from "@/utils/mapViewport";
import { findNearestZoneCorner } from "@/utils/nearestZoneCorner";

const ANCHOR_COLORS = ["#f59e0b", "#0ea5e9", "#10b981"] as const;
const ANCHOR_LABELS = ["1", "2", "3"] as const;

// ── Slot form state ──────────────────────────────────────────────────────────
interface SlotForm {
  name: string;
  worldXStr: string;
  worldYStr: string;
}

function emptySlot(): SlotForm {
  return { name: "", worldXStr: "", worldYStr: "" };
}

function anchorToForm(a: MapAnchor): SlotForm {
  return {
    name: a.name,
    worldXStr: String(a.worldX),
    worldYStr: String(a.worldY),
  };
}

// ── Pick-mode overlay ────────────────────────────────────────────────────────
// Renders a transparent overlay that captures a tap and converts it to SVG
// viewBox coordinates.

function safeParseFloat(s: string): number | null {
  const n = parseFloat(s.trim());
  return isFinite(n) ? n : null;
}

// ── Main screen ──────────────────────────────────────────────────────────────
export default function AdminMapCalibrationScreen() {
  "use no memo";
  const colors = useColors();
  const { isLoading, adminToken, isAdmin } = useApp();
  const router = useRouter();

  const { anchors, upsertAnchor, deleteAnchor } = useMapAnchors(adminToken);
  const { zones, alignment: zoneAlignment } = useWarehouseZones();

  // Slot form state (indexed 0–2 for slots 1–3)
  const [forms, setForms] = useState<[SlotForm, SlotForm, SlotForm]>([emptySlot(), emptySlot(), emptySlot()]);
  // SVG coordinates recorded for each slot (or null if not placed yet)
  const [svgCoords, setSvgCoords] = useState<[{ x: number; y: number } | null, { x: number; y: number } | null, { x: number; y: number } | null]>([null, null, null]);
  // Which slot is in pick mode (null = none)
  const [pickingSlot, setPickingSlot] = useState<0 | 1 | 2 | null>(null);
  // Preview: show zone overlay on top of floor plan
  const [previewOverlay, setPreviewOverlay] = useState(false);
  // Per-slot saving/deleting state
  const [saving, setSaving] = useState<Array<boolean>>([false, false, false]);
  const [deleting, setDeleting] = useState<Array<boolean>>([false, false, false]);

  // Floor-plan SVG layout
  const [mapW, setMapW] = useState(0);
  const [mapH, setMapH] = useState(0);

  // Floor-plan SVG fetch — the cache may be empty if the user navigated here
  // without visiting the Map tab first; prefetch it so the map still renders.
  const [svgLoading, setSvgLoading] = useState(() => !hasCachedData());
  useEffect(() => {
    let cancelled = false;
    prefetchSvgAsset().finally(() => {
      if (!cancelled) setSvgLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  // Track which anchor slots were previously saved so we can detect deletions.
  const prevAnchorIdsRef = useRef<Set<number>>(new Set());

  // Sync forms from loaded anchors.
  // Only touch slots that are present in the server response OR were previously
  // saved (to detect deletions). Unsaved local edits are left intact so a
  // refetch triggered by saving another slot doesn't wipe a pending placement.
  useEffect(() => {
    const anchorMap = new Map(anchors.map((a) => [a.id, a]));
    const prevIds = prevAnchorIdsRef.current;

    setForms((prev) => {
      const next = [...prev] as typeof prev;
      for (let i = 0; i < 3; i++) {
        const slot = i + 1;
        const serverAnchor = anchorMap.get(slot);
        if (serverAnchor) {
          next[i] = anchorToForm(serverAnchor);  // saved → sync from server
        } else if (prevIds.has(slot)) {
          next[i] = emptySlot();                  // was saved, now gone → deleted
        }
        // not saved + not previously saved → leave local state intact
      }
      return next;
    });
    setSvgCoords((prev) => {
      const next = [...prev] as typeof prev;
      for (let i = 0; i < 3; i++) {
        const slot = i + 1;
        const serverAnchor = anchorMap.get(slot);
        if (serverAnchor) {
          next[i] = { x: serverAnchor.svgX, y: serverAnchor.svgY };
        } else if (prevIds.has(slot)) {
          next[i] = null;                         // deleted → clear
        }
      }
      return next;
    });

    prevAnchorIdsRef.current = new Set(anchors.map((a) => a.id));
  }, [anchors]);

  // Compute anchor transform from current state (mix of saved anchors + pending form values)
  const anchorTransformStr = useMemo((): string | null => {
    const pts: Array<AnchorPoint> = [];
    for (let i = 0; i < 3; i++) {
      const coord = svgCoords[i];
      const form = forms[i];
      if (!form) continue;
      const wx = safeParseFloat(form.worldXStr);
      const wy = safeParseFloat(form.worldYStr);
      if (coord && wx !== null && wy !== null) {
        pts.push({ id: i + 1, name: form.name, svgX: coord.x, svgY: coord.y, worldX: wx, worldY: wy });
      }
    }
    if (pts.length < 3) return null;
    const m = computeAnchorTransform(pts);
    return m ? matrixToSvgString(m) : null;
  }, [svgCoords, forms]);

  const svgData = getCachedData();
  const svgXml = svgData?.xml ?? "";
  const contentVB = svgData?.contentViewBox;
  const vbW = contentVB?.w ?? SVG_VIEWBOX_W;
  const vbH = contentVB?.h ?? SVG_VIEWBOX_H;

  // Convert a screen tap (in the map view) → SVG viewBox coordinates
  function screenToSvgCoords(screenX: number, screenY: number): { x: number; y: number } {
    if (mapW <= 0 || mapH <= 0) return { x: 0, y: 0 };
    // The SVG is rendered to fill mapW × mapH with preserveAspectRatio=xMidYMid meet.
    // Effective scale factors:
    const scaleX = mapW / vbW;
    const scaleY = mapH / vbH;
    const scale = Math.min(scaleX, scaleY);
    const renderW = vbW * scale;
    const renderH = vbH * scale;
    const offsetX = (mapW - renderW) / 2;
    const offsetY = (mapH - renderH) / 2;
    return {
      x: (screenX - offsetX) / scale + (contentVB?.x ?? 0),
      y: (screenY - offsetY) / scale + (contentVB?.y ?? 0),
    };
  }

  const handleMapTap = useCallback((x: number, y: number) => {
    if (pickingSlot === null) return;
    const svgPt = screenToSvgCoords(x, y);
    setSvgCoords((prev) => {
      const next = [...prev] as typeof prev;
      next[pickingSlot] = svgPt;
      return next;
    });
    // Auto-suggest world coordinates from the nearest zone corner (if one is
    // close enough). The admin can still edit the fields before saving.
    const match = findNearestZoneCorner(svgPt, zones, zoneAlignment);
    if (match) {
      setForms((prev) => {
        const next = [...prev] as typeof prev;
        next[pickingSlot] = {
          ...next[pickingSlot],
          worldXStr: String(match.worldX),
          worldYStr: String(match.worldY),
        };
        return next;
      });
    }
    setPickingSlot(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickingSlot, mapW, mapH, vbW, vbH, contentVB, zones, zoneAlignment]);

  const tapGesture = Gesture.Tap()
    .runOnJS(true)
    .onEnd((e) => {
      if (pickingSlot === null) return;
      const x = e.x;
      const y = e.y;
      handleMapTap(x, y);
    });

  const handleSaveSlot = useCallback(async (idx: number) => {
    const coord = svgCoords[idx];
    const form = forms[idx];
    if (!form) return;
    const wx = safeParseFloat(form.worldXStr);
    const wy = safeParseFloat(form.worldYStr);

    if (!coord) {
      Alert.alert("No point placed", "Tap 'Place' to pick a point on the floor plan first.");
      return;
    }
    if (wx === null || wy === null) {
      Alert.alert("Invalid coordinates", "Enter valid world X and Y coordinates.");
      return;
    }

    const slot = (idx + 1) as 1 | 2 | 3;
    const payload: UpsertAnchorPayload = {
      name: form.name.trim(),
      svgX: coord.x,
      svgY: coord.y,
      worldX: wx,
      worldY: wy,
    };

    setSaving((prev) => { const next = [...prev]; next[idx] = true; return next; });
    const ok = await upsertAnchor(slot, payload);
    setSaving((prev) => { const next = [...prev]; next[idx] = false; return next; });

    if (!ok) Alert.alert("Save failed", "Could not save anchor. Please try again.");
  }, [svgCoords, forms, upsertAnchor]);

  const handleDeleteSlot = useCallback(async (idx: number) => {
    const slot = (idx + 1) as 1 | 2 | 3;
    Alert.alert(
      `Clear Anchor ${slot}?`,
      "This will remove the anchor point. The overlay will revert to ZoneAlignment sliders.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: async () => {
            setDeleting((prev) => { const next = [...prev]; next[idx] = true; return next; });
            await deleteAnchor(slot);
            setDeleting((prev) => { const next = [...prev]; next[idx] = false; return next; });
          },
        },
      ],
    );
  }, [deleteAnchor]);

  const isAnchorSaved = useCallback((idx: number): boolean => {
    return anchors.some((a) => a.id === idx + 1);
  }, [anchors]);

  if (isLoading) {
    return <View style={{ flex: 1, backgroundColor: colors.background }} />;
  }

  if (!adminToken || !isAdmin) {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
        <View style={styles.centered}>
          <Text style={[styles.notFoundText, { color: colors.mutedForeground }]}>Not found</Text>
        </View>
      </SafeAreaView>
    );
  }

  const allThreeSaved = anchors.length >= 3;
  const anchorTransformActive = anchorTransformStr !== null;

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={8}>
            <Feather name="arrow-left" size={20} color={colors.foreground} />
          </Pressable>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>Map Calibration</Text>
          {allThreeSaved && (
            <View style={[styles.activeBadge, { backgroundColor: colors.primary + "18", borderColor: colors.primary + "50" }]}>
              <Text style={[styles.activeBadgeText, { color: colors.primary }]}>Anchors active</Text>
            </View>
          )}
        </View>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {/* Info banner */}
          <View style={[styles.infoBanner, { backgroundColor: colors.muted, borderColor: colors.border }]}>
            <Feather name="info" size={14} color={colors.mutedForeground} style={{ marginTop: 1 }} />
            <Text style={[styles.infoText, { color: colors.mutedForeground }]}>
              Place 3 anchor points to enable full affine calibration (translation, scale, rotation, shear).
              With fewer than 3, the ZoneAlignment sliders are used unchanged.
            </Text>
          </View>

          {/* Floor-plan preview with pick overlay */}
          <View
            style={[styles.mapCard, { borderColor: colors.border, backgroundColor: colors.card }]}
            onLayout={(e) => {
              setMapW(e.nativeEvent.layout.width - 2); // -2 for border
              setMapH(e.nativeEvent.layout.height - 2);
            }}
          >
            {svgXml ? (
              <GestureDetector gesture={tapGesture}>
                <Animated.View style={{ width: "100%", height: "100%" }}>
                  <Svg
                    width="100%"
                    height="100%"
                    viewBox={contentVB ? `${contentVB.x} ${contentVB.y} ${contentVB.w} ${contentVB.h}` : `0 0 ${SVG_VIEWBOX_W} ${SVG_VIEWBOX_H}`}
                    preserveAspectRatio="xMidYMid meet"
                  >
                    {/* Floor plan */}
                    <SvgXml
                      xml={svgXml}
                      x={contentVB?.x ?? 0}
                      y={contentVB?.y ?? 0}
                      width={vbW}
                      height={vbH}
                    />
                    {/* Zone overlay preview (when toggled on and transform available) */}
                    {previewOverlay && anchorTransformStr && (
                      <G transform={anchorTransformStr}>
                        <G transform={`translate(${zoneAlignment.translateX}, ${zoneAlignment.translateY}) scale(${zoneAlignment.scale})`}>
                          {zones.slice(0, 200).map((zone) => (
                            <Rect
                              key={zone.id}
                              x={zone.svgX}
                              y={zone.svgY}
                              width={zone.svgWidth}
                              height={zone.svgHeight}
                              fill="rgba(0,112,255,0.10)"
                              stroke="#0070ff"
                              strokeWidth={8}
                            />
                          ))}
                        </G>
                      </G>
                    )}
                    {/* Anchor point markers */}
                    {([0, 1, 2] as const).map((idx) => {
                      const coord = svgCoords[idx];
                      if (!coord) return null;
                      const color = ANCHOR_COLORS[idx];
                      const r = Math.max(vbW, vbH) * 0.012;
                      return (
                        <G key={idx}>
                          <Circle
                            cx={coord.x}
                            cy={coord.y}
                            r={r * 1.4}
                            fill={color + "30"}
                            stroke={color}
                            strokeWidth={r * 0.25}
                          />
                          <Circle
                            cx={coord.x}
                            cy={coord.y}
                            r={r * 0.5}
                            fill={color}
                          />
                          <SvgText
                            x={coord.x + r * 1.6}
                            y={coord.y - r * 0.3}
                            fontSize={r * 1.2}
                            fill={color}
                            fontWeight="bold"
                          >
                            {ANCHOR_LABELS[idx]}
                          </SvgText>
                        </G>
                      );
                    })}
                  </Svg>

                  {/* Pick-mode overlay — box-none lets the GestureDetector's tap
                      reach through the overlay on web (where an absolute-fill
                      <div> would otherwise swallow all pointer events). The
                      cancel Pressable child still receives its own touches. */}
                  {pickingSlot !== null && (
                    <View style={[styles.pickOverlay, { borderColor: ANCHOR_COLORS[pickingSlot] }]} pointerEvents="box-none">
                      <View style={[styles.pickBanner, { backgroundColor: ANCHOR_COLORS[pickingSlot] + "cc" }]}>
                        <Text style={styles.pickBannerText}>
                          Tap to place Anchor {pickingSlot + 1}
                        </Text>
                        <Pressable
                          onPress={() => setPickingSlot(null)}
                          style={styles.pickCancelBtn}
                          hitSlop={8}
                        >
                          <Feather name="x" size={16} color="#fff" />
                        </Pressable>
                      </View>
                    </View>
                  )}
                </Animated.View>
              </GestureDetector>
            ) : (
              <View style={styles.mapPlaceholder}>
                {svgLoading ? (
                  <>
                    <ActivityIndicator size="small" color={colors.primary} />
                    <Text style={[styles.mapPlaceholderText, { color: colors.mutedForeground, marginTop: 8 }]}>
                      Loading floor plan…
                    </Text>
                  </>
                ) : (
                  <Text style={[styles.mapPlaceholderText, { color: colors.mutedForeground }]}>
                    {hasCachedData() ? "Loading floor plan…" : "Floor plan could not be loaded."}
                  </Text>
                )}
              </View>
            )}
          </View>

          {/* Preview toggle */}
          <Pressable
            style={[
              styles.previewToggle,
              {
                backgroundColor: previewOverlay ? colors.primary + "14" : colors.card,
                borderColor: previewOverlay ? colors.primary + "60" : colors.border,
              },
            ]}
            onPress={() => setPreviewOverlay((v) => !v)}
            disabled={!anchorTransformActive}
          >
            <Feather
              name={previewOverlay ? "eye-off" : "eye"}
              size={14}
              color={anchorTransformActive ? (previewOverlay ? colors.primary : colors.foreground) : colors.mutedForeground}
            />
            <Text
              style={[
                styles.previewToggleText,
                { color: anchorTransformActive ? (previewOverlay ? colors.primary : colors.foreground) : colors.mutedForeground },
              ]}
            >
              {anchorTransformActive ? (previewOverlay ? "Hide zone preview" : "Show zone preview") : "Zone preview (need all 3 anchors)"}
            </Text>
          </Pressable>

          {/* Anchor slots */}
          {([0, 1, 2] as const).map((idx) => {
            const slot = idx + 1;
            const color = ANCHOR_COLORS[idx];
            const coord = svgCoords[idx];
            const form = forms[idx];
            const saved = isAnchorSaved(idx);
            const isSaving = saving[idx] ?? false;
            const isDeleting = deleting[idx] ?? false;
            const isPicking = pickingSlot === idx;

            return (
              <View
                key={idx}
                style={[
                  styles.slotCard,
                  {
                    borderColor: isPicking ? color : (saved ? color + "80" : colors.border),
                    backgroundColor: colors.card,
                  },
                ]}
              >
                {/* Slot header */}
                <View style={styles.slotHeader}>
                  <View style={[styles.slotNumBadge, { backgroundColor: color }]}>
                    <Text style={styles.slotNumText}>{slot}</Text>
                  </View>
                  <Text style={[styles.slotTitle, { color: colors.foreground }]}>
                    Anchor {slot}
                    {saved && (
                      <Text style={[styles.savedTag, { color: color }]}> ✓ saved</Text>
                    )}
                  </Text>
                  {saved && (
                    <Pressable
                      onPress={() => handleDeleteSlot(idx)}
                      disabled={isDeleting}
                      style={styles.deleteBtn}
                      hitSlop={8}
                    >
                      {isDeleting
                        ? <ActivityIndicator size="small" color={colors.destructive} />
                        : <Feather name="trash-2" size={15} color={colors.destructive} />
                      }
                    </Pressable>
                  )}
                </View>

                {/* SVG coordinate row */}
                <View style={styles.svgRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Floor plan point</Text>
                    <Text style={[styles.svgCoordText, { color: coord ? colors.foreground : colors.mutedForeground }]}>
                      {coord ? `x: ${coord.x.toFixed(1)},  y: ${coord.y.toFixed(1)}` : "Not placed"}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => setPickingSlot(isPicking ? null : idx)}
                    style={[
                      styles.placeBtn,
                      {
                        backgroundColor: isPicking ? color : (color + "18"),
                        borderColor: color,
                      },
                    ]}
                  >
                    <Feather name={isPicking ? "crosshair" : "map-pin"} size={13} color={isPicking ? "#fff" : color} />
                    <Text style={[styles.placeBtnText, { color: isPicking ? "#fff" : color }]}>
                      {isPicking ? "Cancel" : (coord ? "Re-place" : "Place")}
                    </Text>
                  </Pressable>
                </View>

                {/* Landmark name */}
                <View style={styles.fieldRow}>
                  <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Landmark name</Text>
                  <TextInput
                    style={[styles.textInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
                    value={form.name}
                    onChangeText={(v) => setForms((prev) => {
                      const next = [...prev] as typeof prev;
                      next[idx] = { ...next[idx], name: v };
                      return next;
                    })}
                    placeholder="e.g. Entrance corner"
                    placeholderTextColor={colors.mutedForeground}
                    autoCapitalize="sentences"
                  />
                </View>

                {/* World coordinates */}
                <View style={styles.worldRow}>
                  <View style={{ flex: 1, marginRight: 8 }}>
                    <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Zone X</Text>
                    <TextInput
                      style={[styles.textInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
                      value={form.worldXStr}
                      onChangeText={(v) => setForms((prev) => {
                        const next = [...prev] as typeof prev;
                        next[idx] = { ...next[idx], worldXStr: v };
                        return next;
                      })}
                      placeholder="0"
                      placeholderTextColor={colors.mutedForeground}
                      keyboardType="numeric"
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Zone Y</Text>
                    <TextInput
                      style={[styles.textInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
                      value={form.worldYStr}
                      onChangeText={(v) => setForms((prev) => {
                        const next = [...prev] as typeof prev;
                        next[idx] = { ...next[idx], worldYStr: v };
                        return next;
                      })}
                      placeholder="0"
                      placeholderTextColor={colors.mutedForeground}
                      keyboardType="numeric"
                    />
                  </View>
                </View>

                {/* Save button */}
                <Pressable
                  onPress={() => handleSaveSlot(idx)}
                  disabled={isSaving || !coord}
                  style={({ pressed }) => [
                    styles.saveBtn,
                    {
                      backgroundColor: coord ? color : colors.muted,
                      opacity: (isSaving || !coord) ? 0.6 : pressed ? 0.8 : 1,
                    },
                  ]}
                >
                  {isSaving
                    ? <ActivityIndicator size="small" color="#fff" />
                    : <Text style={styles.saveBtnText}>Save Anchor {slot}</Text>
                  }
                </Pressable>
              </View>
            );
          })}

          {/* Status summary */}
          {anchorTransformActive ? (
            <View style={[styles.statusCard, { backgroundColor: colors.primary + "0e", borderColor: colors.primary + "40" }]}>
              <Feather name="check-circle" size={15} color={colors.primary} />
              <Text style={[styles.statusText, { color: colors.primary }]}>
                Affine transform active — zone overlay uses all 3 anchor points.
              </Text>
            </View>
          ) : (
            <View style={[styles.statusCard, { backgroundColor: colors.muted, borderColor: colors.border }]}>
              <Feather name="sliders" size={15} color={colors.mutedForeground} />
              <Text style={[styles.statusText, { color: colors.mutedForeground }]}>
                {anchors.length === 0
                  ? "No anchors saved — using ZoneAlignment sliders."
                  : `${anchors.length} of 3 anchors saved — need all 3 for affine transform.`}
              </Text>
            </View>
          )}

          <View style={{ height: 32 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const MAP_HEIGHT = 280;

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  notFoundText: { fontSize: 16 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    gap: 12,
  },
  backBtn: {},
  headerTitle: { flex: 1, fontSize: 18, fontFamily: "Inter_600SemiBold" },
  activeBadge: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  activeBadgeText: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  content: { padding: 16, gap: 12 },
  infoBanner: {
    flexDirection: "row",
    gap: 8,
    alignItems: "flex-start",
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  infoText: { flex: 1, fontSize: 12, fontFamily: "Inter_400Regular", lineHeight: 18 },
  mapCard: {
    height: MAP_HEIGHT,
    borderRadius: 12,
    borderWidth: 1,
    overflow: "hidden",
  },
  mapPlaceholder: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  mapPlaceholderText: { fontSize: 13, textAlign: "center", fontFamily: "Inter_400Regular" },
  pickOverlay: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 2,
    borderRadius: 12,
  },
  pickBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  pickBannerText: { color: "#fff", fontSize: 13, fontFamily: "Inter_600SemiBold", flex: 1 },
  pickCancelBtn: { marginLeft: 8 },
  previewToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  previewToggleText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  slotCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    gap: 10,
  },
  slotHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  slotNumBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  slotNumText: { color: "#fff", fontSize: 13, fontFamily: "Inter_700Bold" },
  slotTitle: { flex: 1, fontSize: 14, fontFamily: "Inter_600SemiBold" },
  savedTag: { fontSize: 12, fontFamily: "Inter_500Medium" },
  deleteBtn: { marginLeft: 4 },
  svgRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  fieldLabel: { fontSize: 11, fontFamily: "Inter_500Medium", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 },
  svgCoordText: { fontSize: 12, fontFamily: "Inter_400Regular" },
  placeBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
  },
  placeBtnText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  fieldRow: { gap: 2 },
  textInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
  },
  worldRow: { flexDirection: "row" },
  saveBtn: {
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  saveBtnText: { color: "#fff", fontSize: 13, fontFamily: "Inter_600SemiBold" },
  statusCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  statusText: { flex: 1, fontSize: 12, fontFamily: "Inter_400Regular", lineHeight: 18 },
});
