/**
 * Admin Map Calibration Screen
 *
 * Allows an admin to place up to 3 named anchor points on the warehouse
 * floor-plan SVG.  Each anchor maps an SVG tap coordinate to a zone-data
 * (world) coordinate.  When all 3 are drafted the admin enters a review step
 * that shows the zone overlay with the computed affine transform.  Only after
 * the admin confirms are all three anchors written to the server atomically.
 *
 * Route: /admin-map-calibration
 */
import { useClerk } from "@clerk/expo";
import { Feather } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  BackHandler,
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
import { useWarehouseZones, ZONES_CACHE_KEY } from "@/hooks/useWarehouseZones";
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

function safeParseFloat(s: string): number | null {
  const n = parseFloat(s.trim());
  return isFinite(n) ? n : null;
}

// ── Main screen ──────────────────────────────────────────────────────────────
export default function AdminMapCalibrationScreen() {
  "use no memo";
  const colors = useColors();
  const { isLoading, adminToken, isAdmin } = useApp();
  const clerk = useClerk();
  const clerkRef = useRef(clerk);
  useEffect(() => { clerkRef.current = clerk; }, [clerk]);
  const router = useRouter();

  const { anchors, upsertAnchor, deleteAnchor, mfaRequired: anchorsMfaRequired } = useMapAnchors(adminToken);
  const { zones, alignment: zoneAlignment, refetch: refetchZones } = useWarehouseZones();

  // Slot form state (indexed 0–2 for slots 1–3)
  const [forms, setForms] = useState<[SlotForm, SlotForm, SlotForm]>([emptySlot(), emptySlot(), emptySlot()]);
  // SVG coordinates recorded for each slot (or null if not placed yet)
  const [svgCoords, setSvgCoords] = useState<[{ x: number; y: number } | null, { x: number; y: number } | null, { x: number; y: number } | null]>([null, null, null]);
  // Which slot is in pick mode (null = none)
  const [pickingSlot, setPickingSlot] = useState<0 | 1 | 2 | null>(null);

  // Review step state
  const [step, setStep] = useState<"edit" | "review">("edit");
  const [isConfirming, setIsConfirming] = useState(false);
  // Ref-based guard prevents double-taps from both starting a confirm in the
  // same synchronous event batch before React has flushed the isConfirming state.
  const confirmingRef = useRef(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  // Snapshot of the reviewed draft anchors.  Taken on the FIRST Confirm press
  // and reused on retries so that mid-confirm refetch calls (triggered by each
  // successful upsertAnchor inside useMapAnchors) cannot overwrite forms/svgCoords
  // and corrupt the pending slot writes before they complete.  Cleared on full
  // success or when the admin explicitly goes back to the edit step to re-adjust.
  const confirmedSnapshotRef = useRef<Array<AnchorPoint> | null>(null);

  // Per-slot deleting state
  const [deleting, setDeleting] = useState<Array<boolean>>([false, false, false]);
  // Per-slot saving state
  const [savingSlot, setSavingSlot] = useState<[boolean, boolean, boolean]>([false, false, false]);
  const [saveErrorSlot, setSaveErrorSlot] = useState<[string | null, string | null, string | null]>([null, null, null]);
  const [savedSlot, setSavedSlot] = useState<[boolean, boolean, boolean]>([false, false, false]);

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
  // saved (to detect deletions). Unsaved local drafts are left intact so a
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

    // Sync savedSlot: true for slots present on the server, false for cleared slots
    setSavedSlot((prev) => {
      const next = [...prev] as typeof prev;
      for (let i = 0; i < 3; i++) {
        const slot = i + 1;
        const serverAnchor = anchorMap.get(slot);
        if (serverAnchor) {
          next[i] = true;
        } else if (prevIds.has(slot)) {
          next[i] = false;                        // deleted → reset
        }
      }
      return next;
    });

    prevAnchorIdsRef.current = new Set(anchors.map((a) => a.id));
  }, [anchors]);

  // ── Draft anchor computation ─────────────────────────────────────────────
  // All three slots must have a valid coord + finite worldX/worldY to be ready.
  const draftAnchors = useMemo((): Array<AnchorPoint> | null => {
    const pts: Array<AnchorPoint> = [];
    for (let i = 0; i < 3; i++) {
      const coord = svgCoords[i];
      const form = forms[i];
      if (!form || !coord) return null;
      const wx = safeParseFloat(form.worldXStr);
      const wy = safeParseFloat(form.worldYStr);
      if (wx === null || wy === null) return null;
      pts.push({
        id: i + 1,
        name: form.name || `Anchor ${i + 1}`,
        svgX: coord.x,
        svgY: coord.y,
        worldX: wx,
        worldY: wy,
      });
    }
    return pts;
  }, [svgCoords, forms]);

  const draftTransformMatrix = useMemo(() => {
    if (!draftAnchors) return null;
    return computeAnchorTransform(draftAnchors);
  }, [draftAnchors]);

  const draftTransformStr = useMemo(() => {
    if (!draftTransformMatrix) return null;
    return matrixToSvgString(draftTransformMatrix);
  }, [draftTransformMatrix]);

  // All 3 slots filled but points are collinear / degenerate
  const hasDegenerate = draftAnchors !== null && draftTransformMatrix === null;

  // Whether any local draft differs from the server state (used for back-guard)
  const hasDraftChanges = useMemo(() => {
    if (step === "review") return true;
    for (let i = 0; i < 3; i++) {
      const serverAnchor = anchors.find((a) => a.id === i + 1);
      const coord = svgCoords[i];
      const form = forms[i];
      if (!form) continue;
      const wx = safeParseFloat(form.worldXStr);
      const wy = safeParseFloat(form.worldYStr);
      if (serverAnchor) {
        // Local coord placed and differs from server
        if (coord && (
          Math.abs(coord.x - serverAnchor.svgX) > 0.5 ||
          Math.abs(coord.y - serverAnchor.svgY) > 0.5 ||
          wx !== serverAnchor.worldX || wy !== serverAnchor.worldY ||
          form.name.trim() !== serverAnchor.name
        )) return true;
      } else {
        // Slot not on server — any local coord is a draft change
        if (coord !== null) return true;
      }
    }
    return false;
  }, [step, forms, svgCoords, anchors]);

  const svgData = getCachedData();
  const svgXml = svgData?.xml ?? "";
  const contentVB = svgData?.contentViewBox;
  const vbW = contentVB?.w ?? SVG_VIEWBOX_W;
  const vbH = contentVB?.h ?? SVG_VIEWBOX_H;

  // Convert a screen tap (in the map view) → SVG viewBox coordinates
  function screenToSvgCoords(screenX: number, screenY: number): { x: number; y: number } {
    if (mapW <= 0 || mapH <= 0) return { x: 0, y: 0 };
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
    // Re-placing the pin marks this slot as having unsaved changes
    setSavedSlot((prev) => {
      const next = [...prev] as typeof prev;
      next[pickingSlot] = false;
      return next;
    });
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
      handleMapTap(e.x, e.y);
    });

  // ── Atomic confirm ───────────────────────────────────────────────────────
  // Writes all three draft anchors to the server sequentially. On any failure
  // Helper: return from review step back to edit, discarding the confirm cycle.
  // Clears confirmedSnapshotRef so the next Confirm session takes a fresh snapshot.
  const goBackToEdit = useCallback(() => {
    confirmedSnapshotRef.current = null;
    setStep("edit");
  }, []);

  // the operation stops and shows a retry-able error — no partial set is applied
  // to the live cache. Only on full success is AsyncStorage invalidated so the
  // Map tab reloads with the new alignment.
  const handleConfirm = useCallback(async () => {
    // confirmingRef guards synchronous double-taps (before the re-render that
    // would flip isConfirming); isConfirming guards subsequent renders.
    if (!draftAnchors || !draftTransformMatrix || confirmingRef.current || isConfirming) return;

    // Take a snapshot of the reviewed draft on the first Confirm press and reuse
    // it on every retry.  This prevents the anchor-sync useEffect (triggered by
    // each upsertAnchor's internal refetch) from overwriting forms/svgCoords for
    // not-yet-saved slots between the partial write and the retry Confirm press.
    if (!confirmedSnapshotRef.current) {
      confirmedSnapshotRef.current = [...draftAnchors];
    }
    const snapshot = confirmedSnapshotRef.current;

    confirmingRef.current = true;
    setIsConfirming(true);
    setConfirmError(null);

    for (const pt of snapshot) {
      const slot = pt.id as 1 | 2 | 3;
      const payload: UpsertAnchorPayload = {
        name: pt.name,
        svgX: pt.svgX,
        svgY: pt.svgY,
        worldX: pt.worldX,
        worldY: pt.worldY,
      };
      const result = await upsertAnchor(slot, payload);
      if (!result.ok) {
        confirmingRef.current = false;
        setIsConfirming(false);
        if (result.mfaRequired) {
          confirmedSnapshotRef.current = null;
          Alert.alert(
            "Two-Factor Authentication Required",
            "Admin access requires two-factor authentication (2FA). Enable it in your account settings under Security → Two-step verification.",
            [
              { text: "Dismiss", style: "cancel" },
              {
                text: "Open Account Settings",
                onPress: () => { clerkRef.current?.openUserProfile(); },
              },
            ],
          );
          return;
        }
        setConfirmError("Could not save all anchors. Check your connection and try again.");
        // Do NOT clear confirmedSnapshotRef — the admin can retry with the same reviewed set.
        return;
      }
    }

    // All 3 saved — invalidate zones cache so Map tab reloads fresh alignment
    await AsyncStorage.removeItem(ZONES_CACHE_KEY).catch(() => {});
    refetchZones();
    confirmedSnapshotRef.current = null;
    confirmingRef.current = false;
    setIsConfirming(false);
    setStep("edit");
  }, [draftAnchors, draftTransformMatrix, isConfirming, upsertAnchor, refetchZones]);

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
            const result = await deleteAnchor(slot);
            setDeleting((prev) => { const next = [...prev]; next[idx] = false; return next; });
            if (!result.ok && result.mfaRequired) {
              Alert.alert(
                "Two-Factor Authentication Required",
                "Admin access requires two-factor authentication (2FA). Enable it in your account settings under Security → Two-step verification.",
                [
                  { text: "Dismiss", style: "cancel" },
                  {
                    text: "Open Account Settings",
                    onPress: () => { clerkRef.current?.openUserProfile(); },
                  },
                ],
              );
            }
          },
        },
      ],
    );
  }, [deleteAnchor]);

  const isAnchorSaved = useCallback((idx: number): boolean => {
    return anchors.some((a) => a.id === idx + 1);
  }, [anchors]);

  // ── Per-slot save ────────────────────────────────────────────────────────
  const handleSaveSlot = useCallback(async (idx: number) => {
    if (savingSlot[idx]) return;
    const coord = svgCoords[idx];
    const form = forms[idx];
    if (!coord || !form) return;
    const wx = safeParseFloat(form.worldXStr);
    const wy = safeParseFloat(form.worldYStr);
    if (wx === null || wy === null) return;

    const slot = (idx + 1) as 1 | 2 | 3;
    const payload: UpsertAnchorPayload = {
      name: form.name || `Anchor ${slot}`,
      svgX: coord.x,
      svgY: coord.y,
      worldX: wx,
      worldY: wy,
    };

    setSavingSlot((prev) => { const next = [...prev] as typeof prev; next[idx] = true; return next; });
    setSaveErrorSlot((prev) => { const next = [...prev] as typeof prev; next[idx] = null; return next; });

    const result = await upsertAnchor(slot, payload);

    setSavingSlot((prev) => { const next = [...prev] as typeof prev; next[idx] = false; return next; });

    if (result.ok) {
      setSavedSlot((prev) => { const next = [...prev] as typeof prev; next[idx] = true; return next; });
      setSaveErrorSlot((prev) => { const next = [...prev] as typeof prev; next[idx] = null; return next; });
    } else if (result.mfaRequired) {
      Alert.alert(
        "Two-Factor Authentication Required",
        "Admin access requires two-factor authentication (2FA). Enable it in your account settings under Security → Two-step verification.",
        [
          { text: "Dismiss", style: "cancel" },
          {
            text: "Open Account Settings",
            onPress: () => { clerkRef.current?.openUserProfile(); },
          },
        ],
      );
    } else {
      setSaveErrorSlot((prev) => { const next = [...prev] as typeof prev; next[idx] = "Could not save — check your connection."; return next; });
    }
  }, [savingSlot, svgCoords, forms, upsertAnchor]);

  // ── Back navigation guard ────────────────────────────────────────────────
  const handleBack = useCallback(() => {
    if (step === "review") {
      // Go back to editing — drafts remain, snapshot cleared for next session.
      goBackToEdit();
      return;
    }
    if (!hasDraftChanges) {
      router.back();
      return;
    }
    Alert.alert(
      "Unsaved changes",
      "You have unsaved anchor edits. Leave without applying them?",
      [
        { text: "Stay", style: "cancel" },
        { text: "Leave", style: "destructive", onPress: () => router.back() },
      ],
    );
  }, [step, hasDraftChanges, router, goBackToEdit]);

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (step === "review") {
        goBackToEdit();
        return true;
      }
      if (hasDraftChanges) {
        handleBack();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [step, hasDraftChanges, handleBack, goBackToEdit]);

  // ── Slot readiness ───────────────────────────────────────────────────────
  const slotReady = useMemo(() => ([0, 1, 2] as const).map((i) => {
    const coord = svgCoords[i];
    const form = forms[i];
    if (!coord || !form) return false;
    return safeParseFloat(form.worldXStr) !== null && safeParseFloat(form.worldYStr) !== null;
  }), [svgCoords, forms]);

  const allThreeDraftReady = slotReady[0] && slotReady[1] && slotReady[2];

  // ── Early returns ────────────────────────────────────────────────────────
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

  const allThreeConfirmed = anchors.length >= 3;

  // ── Shared map card (used in both edit and review steps) ─────────────────
  const renderMapCard = (overlayTransformStr: string | null, heightStyle?: object) => (
    <View
      style={[styles.mapCard, { borderColor: colors.border, backgroundColor: colors.card }, heightStyle]}
      onLayout={(e) => {
        setMapW(e.nativeEvent.layout.width - 2);
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
              {/* Zone overlay — shown when a valid transform string is provided */}
              {overlayTransformStr && (
                <G transform={overlayTransformStr}>
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
              {/* Faint zone overlay in edit mode — helps the admin aim near a corner */}
              {!overlayTransformStr && zones.length > 0 && (
                <G transform={`translate(${zoneAlignment.translateX}, ${zoneAlignment.translateY}) scale(${zoneAlignment.scale})`}>
                  {zones.slice(0, 200).map((zone) => (
                    <Rect
                      key={zone.id}
                      testID="edit-zone-overlay-rect"
                      x={zone.svgX}
                      y={zone.svgY}
                      width={zone.svgWidth}
                      height={zone.svgHeight}
                      fill="rgba(0,112,255,0.06)"
                      stroke="#0070ff"
                      strokeWidth={6}
                      strokeOpacity={0.3}
                    />
                  ))}
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

            {/* Pick-mode overlay */}
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
  );

  // ── Review step ──────────────────────────────────────────────────────────
  if (step === "review") {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
        {/* Review header */}
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <Pressable
            onPress={goBackToEdit}
            style={styles.backBtn}
            hitSlop={8}
            accessibilityLabel="Go back to adjust"
          >
            <Feather name="arrow-left" size={20} color={colors.foreground} />
          </Pressable>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>Review Alignment</Text>
        </View>

        <View style={{ flex: 1, padding: 16, gap: 12 }}>
          {/* Floor plan + overlay preview */}
          {renderMapCard(draftTransformStr, { flex: 1 })}

          {/* Degenerate warning */}
          {hasDegenerate && (
            <View style={[styles.warnCard, { backgroundColor: colors.destructive + "14", borderColor: colors.destructive + "50" }]}>
              <Feather name="alert-triangle" size={15} color={colors.destructive} />
              <Text style={[styles.warnText, { color: colors.destructive }]}>
                Anchor points are collinear or overlap — cannot compute a valid transform.
                Go back and adjust their positions.
              </Text>
            </View>
          )}

          {/* Confirm error */}
          {confirmError && (
            <View style={[styles.warnCard, { backgroundColor: colors.destructive + "14", borderColor: colors.destructive + "50" }]}>
              <Feather name="wifi-off" size={15} color={colors.destructive} />
              <Text style={[styles.warnText, { color: colors.destructive }]}>{confirmError}</Text>
            </View>
          )}

          {/* Action buttons */}
          <View style={styles.reviewActions}>
            <Pressable
              onPress={goBackToEdit}
              style={[styles.reviewBackBtn, { borderColor: colors.border, backgroundColor: colors.card }]}
              disabled={isConfirming}
            >
              <Feather name="edit-2" size={14} color={colors.foreground} />
              <Text style={[styles.reviewBackBtnText, { color: colors.foreground }]}>Adjust anchors</Text>
            </Pressable>

            <Pressable
              onPress={handleConfirm}
              disabled={hasDegenerate || isConfirming}
              style={[
                styles.confirmBtn,
                {
                  backgroundColor: hasDegenerate ? colors.muted : colors.primary,
                  opacity: (hasDegenerate || isConfirming) ? 0.6 : 1,
                },
              ]}
              accessibilityLabel="Confirm and apply anchors"
            >
              {isConfirming ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Feather name="check" size={14} color="#fff" />
                  <Text style={styles.confirmBtnText}>Confirm & Apply</Text>
                </>
              )}
            </Pressable>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // ── Edit step ────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <Pressable onPress={handleBack} style={styles.backBtn} hitSlop={8}>
            <Feather name="arrow-left" size={20} color={colors.foreground} />
          </Pressable>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>Map Calibration</Text>
          {allThreeConfirmed && (
            <View style={[styles.activeBadge, { backgroundColor: colors.primary + "18", borderColor: colors.primary + "50" }]}>
              <Text style={[styles.activeBadgeText, { color: colors.primary }]}>Anchors active</Text>
            </View>
          )}
        </View>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {/* MFA required banner */}
          {anchorsMfaRequired && (
            <Pressable
              onPress={() => { clerkRef.current?.openUserProfile(); }}
              style={[styles.mfaBanner, { backgroundColor: "#fef3c7", borderColor: "#fbbf24" }]}
              accessibilityRole="button"
              accessibilityLabel="Open Account Settings to enable two-factor authentication"
            >
              <Feather name="lock" size={14} color="#92400e" style={{ marginTop: 1 }} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.mfaBannerTitle, { color: "#92400e" }]}>Two-factor authentication required</Text>
                <Text style={[styles.mfaBannerBody, { color: "#78350f" }]}>
                  Anchor data cannot be loaded or saved until 2FA is enabled. Tap to open Account Settings → Security → Two-step verification.
                </Text>
              </View>
              <Feather name="chevron-right" size={14} color="#92400e" />
            </Pressable>
          )}

          {/* Info banner */}
          <View style={[styles.infoBanner, { backgroundColor: colors.muted, borderColor: colors.border }]}>
            <Feather name="info" size={14} color={colors.mutedForeground} style={{ marginTop: 1 }} />
            <Text style={[styles.infoText, { color: colors.mutedForeground }]}>
              Place 3 anchor points, then tap "Review Alignment" to preview the zone overlay and confirm.
              Changes only take effect after you confirm.
            </Text>
          </View>

          {/* Floor-plan preview (edit mode — no overlay) */}
          {renderMapCard(null)}

          {/* Anchor slots */}
          {([0, 1, 2] as const).map((idx) => {
            const slot = idx + 1;
            const color = ANCHOR_COLORS[idx];
            const coord = svgCoords[idx];
            const form = forms[idx];
            const saved = isAnchorSaved(idx);
            const isDeleting = deleting[idx] ?? false;
            const isPicking = pickingSlot === idx;
            const ready = slotReady[idx];

            return (
              <View
                key={idx}
                style={[
                  styles.slotCard,
                  {
                    borderColor: isPicking ? color : (ready ? color + "80" : colors.border),
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
                    {ready && (
                      <Text style={[styles.readyTag, { color: color }]}> ✓ ready</Text>
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
                    onChangeText={(v) => {
                      setForms((prev) => {
                        const next = [...prev] as typeof prev;
                        next[idx] = { ...next[idx], name: v };
                        return next;
                      });
                      setSavedSlot((prev) => { const next = [...prev] as typeof prev; next[idx] = false; return next; });
                    }}
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
                      onChangeText={(v) => {
                        setForms((prev) => {
                          const next = [...prev] as typeof prev;
                          next[idx] = { ...next[idx], worldXStr: v };
                          return next;
                        });
                        setSavedSlot((prev) => { const next = [...prev] as typeof prev; next[idx] = false; return next; });
                      }}
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
                      onChangeText={(v) => {
                        setForms((prev) => {
                          const next = [...prev] as typeof prev;
                          next[idx] = { ...next[idx], worldYStr: v };
                          return next;
                        });
                        setSavedSlot((prev) => { const next = [...prev] as typeof prev; next[idx] = false; return next; });
                      }}
                      placeholder="0"
                      placeholderTextColor={colors.mutedForeground}
                      keyboardType="numeric"
                    />
                  </View>
                </View>
                <Text style={[styles.hint, { color: colors.mutedForeground }]}>
                  Tap the map near a zone corner to auto-fill. If the fields stay blank after placing the pin, try a spot closer to a corner.
                </Text>

                {/* No-snap helper — shown when a pin is placed but Zone X/Y weren't auto-filled */}
                {coord !== null && (form.worldXStr === "" || form.worldYStr === "") && (
                  <Text style={[styles.noSnapHint, { color: colors.mutedForeground }]}>
                    No nearby zone corner found — type the Zone X / Zone Y coordinates from your Zone Editor.
                  </Text>
                )}

                {/* Per-slot Save button — shown when slot is ready */}
                {ready && (
                  <View style={styles.saveSlotRow}>
                    <Pressable
                      onPress={() => handleSaveSlot(idx)}
                      disabled={savingSlot[idx] || savedSlot[idx]}
                      style={[
                        styles.saveSlotBtn,
                        savedSlot[idx]
                          ? { backgroundColor: color + "20", borderColor: color }
                          : { backgroundColor: colors.card, borderColor: colors.border },
                        (savingSlot[idx] || savedSlot[idx]) && { opacity: 0.75 },
                      ]}
                      accessibilityLabel={`Save anchor ${slot}`}
                    >
                      {savingSlot[idx] ? (
                        <>
                          <ActivityIndicator size="small" color={colors.mutedForeground} />
                          <Text style={[styles.saveSlotBtnText, { color: colors.mutedForeground }]}>Saving…</Text>
                        </>
                      ) : savedSlot[idx] ? (
                        <>
                          <Feather name="check" size={13} color={color} />
                          <Text style={[styles.saveSlotBtnText, { color }]}>Saved</Text>
                        </>
                      ) : (
                        <>
                          <Feather name="save" size={13} color={colors.foreground} />
                          <Text style={[styles.saveSlotBtnText, { color: colors.foreground }]}>Save</Text>
                        </>
                      )}
                    </Pressable>
                    {saveErrorSlot[idx] && (
                      <Text style={[styles.saveSlotError, { color: colors.destructive }]}>
                        {saveErrorSlot[idx]}
                      </Text>
                    )}
                  </View>
                )}
              </View>
            );
          })}

          {/* Degenerate warning (edit step) */}
          {hasDegenerate && (
            <View style={[styles.warnCard, { backgroundColor: colors.destructive + "14", borderColor: colors.destructive + "50" }]}>
              <Feather name="alert-triangle" size={15} color={colors.destructive} />
              <Text style={[styles.warnText, { color: colors.destructive }]}>
                Anchor points appear collinear or overlapping. Adjust their positions before reviewing.
              </Text>
            </View>
          )}

          {/* Review Alignment button — shown when all 3 drafts are ready */}
          {allThreeDraftReady && !hasDegenerate && (
            <Pressable
              onPress={() => {
                setConfirmError(null);
                setStep("review");
              }}
              style={({ pressed }) => [
                styles.reviewBtn,
                {
                  backgroundColor: colors.primary,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
              accessibilityLabel="Review alignment"
            >
              <Feather name="eye" size={15} color="#fff" />
              <Text style={styles.reviewBtnText}>Review Alignment →</Text>
            </Pressable>
          )}

          {/* Status summary */}
          {allThreeConfirmed ? (
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
  mfaBanner: {
    flexDirection: "row",
    gap: 8,
    alignItems: "flex-start",
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  mfaBannerTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 2,
  },
  mfaBannerBody: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
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
  readyTag: { fontSize: 12, fontFamily: "Inter_500Medium" },
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
  hint: { fontSize: 11, fontFamily: "Inter_400Regular", lineHeight: 15, marginTop: 6 },
  warnCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  warnText: { flex: 1, fontSize: 12, fontFamily: "Inter_400Regular", lineHeight: 18 },
  reviewBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 13,
    borderRadius: 10,
  },
  reviewBtnText: { color: "#fff", fontSize: 14, fontFamily: "Inter_600SemiBold" },
  reviewActions: {
    flexDirection: "row",
    gap: 10,
  },
  reviewBackBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 13,
    borderRadius: 10,
    borderWidth: 1,
  },
  reviewBackBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  confirmBtn: {
    flex: 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 13,
    borderRadius: 10,
  },
  confirmBtnText: { color: "#fff", fontSize: 14, fontFamily: "Inter_600SemiBold" },
  statusCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  statusText: { flex: 1, fontSize: 12, fontFamily: "Inter_400Regular", lineHeight: 18 },
  saveSlotRow: { gap: 4 },
  saveSlotBtn: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  saveSlotBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  saveSlotError: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 2 },
  noSnapHint: { fontSize: 11, fontFamily: "Inter_400Regular", lineHeight: 16 },
});
