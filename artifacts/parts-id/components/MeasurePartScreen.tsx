/**
 * MeasurePartScreen
 *
 * iOS-only camera screen that offers two dimension-capture paths:
 *
 *   1. LiDAR Scan (iPhone 12 Pro+ / iPad Pro 2020+)
 *      Starts a native ARKit scene-reconstruction session for ~4 s, then reads
 *      the bounding-box of the nearest detected surface in real mm.
 *      Implemented in modules/lidar-measure (Swift / ARKit).
 *
 *   2. AI Photo Estimate (all other iOS devices)
 *      Captures a JPEG and calls POST /inventory/estimate-dimensions, which
 *      uses OpenAI Vision to infer a bounding-box estimate.
 *
 *   3. Manual entry — always available as a fallback.
 *
 * Gating: iOS only — callers must hide the trigger on Android and Web.
 */
import { Feather } from "@expo/vector-icons";
import type { InventoryItem } from "@workspace/api-client-react";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Device from "expo-device";
import { cancelMeasure, measureObject, NativeLidarDepthView } from "lidar-measure";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  AppStateStatus,
  Linking,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { KeyboardDoneInput } from "@/components/KeyboardDoneInput";
import { type DimensionUnit,useApp } from "@/contexts/AppContext";
import { API_BASE } from "@/utils/apiBase";
import { getDeviceId } from "@/utils/deviceId";

/**
 * Returns true when the current iOS device is known to include LiDAR hardware
 * (iPhone 12 Pro+ / iPad Pro 2020+).  Falls back to true in development
 * (simulator or unknown model) so the feature is accessible while testing.
 * In production on a non-LiDAR device the button is hidden by the caller.
 */
export function isLiDARCapableDevice(): boolean {
  if (!Device.modelName) return true;
  const m = Device.modelName;
  const iPhoneProPattern = /iPhone (1[2-9]|[2-9]\d+) Pro/i;
  const iPadProPattern = /iPad Pro/i;
  return iPhoneProPattern.test(m) || iPadProPattern.test(m);
}

// ── LiDAR error-code → user-friendly hint ────────────────────────────────────
// The native LidarMeasureModule rejects with one of these code strings embedded
// in the error message.  Map each to an actionable hint shown below the raw
// error text so the user knows what to do next.
const LIDAR_HINTS: Record<string, string> = {
  ERR_LIDAR_NOT_SUPPORTED:
    "LiDAR is not available on this device. Use photo estimation or enter dimensions manually.",
  ERR_NO_FRAME:
    "Move closer to the object and try again.",
  ERR_NO_MESH:
    "No surface detected — aim directly at a nearby object and try again.",
  ERR_ZERO_DIMS:
    "The object may be too small or too far away. Try adjusting your distance.",
  ERR_INTERRUPTED:
    "Scan was interrupted. Please try again.",
};

function getLidarHint(errMsg: string): string {
  for (const [code, hint] of Object.entries(LIDAR_HINTS)) {
    if (errMsg.includes(code)) return hint;
  }
  return "You can use photo estimation or enter dimensions manually.";
}

export interface PartDimensions {
  length?: number | null;
  width?: number | null;
  height?: number | null;
  diameter?: number | null;
}

interface MeasurePartScreenProps {
  visible: boolean;
  onClose: () => void;
  onConfirm: (dims: PartDimensions) => void;
  initialDims?: PartDimensions | null;
  initialItem?: InventoryItem | null;
  adminToken: string;
}

type Phase = "preview" | "lidar_scanning" | "estimating" | "confirm";
type RescanAxis = "length" | "width" | "height";

const LIDAR_TIMEOUT_S = 4;

/** Format a mm value for display in the chosen unit. */
export function fmtForUnit(v: number | null | undefined, unit: DimensionUnit): string {
  if (v == null) return "";
  switch (unit) {
    case "cm": return (Math.round((v / 10) * 10) / 10).toFixed(1);
    case "in": return (v / 25.4).toFixed(2);
    default:   return String(Math.round(v));
  }
}

/** Parse a field string (in display unit) and return the value in mm, or null. */
export function parseFieldToMm(s: string, unit: DimensionUnit): number | null {
  const n = parseFloat(s);
  if (isNaN(n) || n < 0) return null;
  switch (unit) {
    case "cm": return Math.round(n * 10 * 10) / 10;
    case "in": return Math.round(n * 25.4 * 10) / 10;
    default:   return Math.round(n * 10) / 10;
  }
}

/** Human-readable suffix for a dimension unit. */
function unitLabel(unit: DimensionUnit): string {
  return unit;
}

export function MeasurePartScreen({
  visible,
  onClose,
  onConfirm,
  initialDims,
  initialItem,
  adminToken,
}: MeasurePartScreenProps) {
  "use no memo";
  const { settings, updateSetting } = useApp();
  const unit = settings.dimensionUnit;
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>("preview");
  const [estimateError, setEstimateError] = useState<string | null>(null);
  // Use the JS model-name check so the LiDAR option surfaces correctly on
  // LiDAR-capable hardware even when running in Expo Go (where the native
  // module is not bundled and isLiDARSupported() always returns false).
  // The actual scan call (measureObject) still rejects gracefully if the
  // native module is absent at runtime.
  const [lidarAvailable] = useState<boolean>(() => isLiDARCapableDevice());
  const [scanSecsLeft, setScanSecsLeft] = useState(LIDAR_TIMEOUT_S);

  const [lengthStr, setLengthStr] = useState("");
  const [widthStr, setWidthStr] = useState("");
  const [heightStr, setHeightStr] = useState("");
  const [diameterStr, setDiameterStr] = useState("");

  const [rescanningAxis, setRescanningAxis] = useState<RescanAxis | null>(null);
  const [isReestimating, setIsReestimating] = useState(false);
  const [confirmEstimateError, setConfirmEstimateError] = useState<string | null>(null);
  const [previousMmDims, setPreviousMmDims] = useState<PartDimensions | null>(null);

  // Stable ref to the current unit so the initialization effect can read the
  // latest value without listing `unit` as a reactive dependency (which would
  // cause the effect — and therefore a full field reset — to fire every time
  // the user switches units mid-session).
  const unitRef = useRef<DimensionUnit>(unit);
  useEffect(() => { unitRef.current = unit; }, [unit]);

  // Track the unit used to populate the current field strings so we can
  // re-derive display strings when the user switches units mid-session.
  const fieldUnitRef = useRef<DimensionUnit>(unit);

  // Canonical dimension values in mm. Updated when LiDAR / AI writes a value
  // programmatically, or when the user commits a field on blur. Display
  // strings are always derived from these, avoiding lossy re-parsing of
  // partially-typed text when the unit changes.
  const lengthMmRef   = useRef<number | null>(initialDims?.length   ?? null);
  const widthMmRef    = useRef<number | null>(initialDims?.width    ?? null);
  const heightMmRef   = useRef<number | null>(initialDims?.height   ?? null);
  const diameterMmRef = useRef<number | null>(initialDims?.diameter ?? null);

  const scanPulse = useRef(new Animated.Value(0)).current;
  const scanLoopRef = useRef<Animated.CompositeAnimation | null>(null);
  const scanInterruptedRef = useRef(false);

  useEffect(() => {
    if (rescanningAxis !== null) {
      scanLoopRef.current = Animated.loop(
        Animated.sequence([
          Animated.timing(scanPulse, {
            toValue: 1,
            duration: 900,
            useNativeDriver: true,
          }),
          Animated.timing(scanPulse, {
            toValue: 0,
            duration: 900,
            useNativeDriver: true,
          }),
        ])
      );
      scanLoopRef.current.start();
    } else {
      scanLoopRef.current?.stop();
      scanLoopRef.current = null;
      scanPulse.setValue(0);
    }
    return () => {
      scanLoopRef.current?.stop();
      scanLoopRef.current = null;
    };
  }, [rescanningAxis, scanPulse]);

  const cameraRef = useRef<CameraView>(null);

  useEffect(() => {
    if (visible) {
      setPhase("preview");
      setEstimateError(null);
      setRescanningAxis(null);
      setIsReestimating(false);
      setConfirmEstimateError(null);
      setPreviousMmDims(null);
      // Read from unitRef so this effect does not re-run on unit changes
      // (which would reset measured values whenever the user switches units).
      const currentUnit = unitRef.current;
      fieldUnitRef.current = currentUnit;
      // Seed canonical mm refs: prefer explicit initialDims, fall back to
      // the dimensions stored on initialItem (e.g. admin bridge "Measure Now").
      const itemDims = initialItem?.dimensions ?? null;
      const seedDims: PartDimensions | null | undefined = initialDims ?? itemDims;
      lengthMmRef.current   = seedDims?.length   ?? null;
      widthMmRef.current    = seedDims?.width    ?? null;
      heightMmRef.current   = seedDims?.height   ?? null;
      diameterMmRef.current = seedDims?.diameter ?? null;
      setLengthStr(fmtForUnit(seedDims?.length, currentUnit));
      setWidthStr(fmtForUnit(seedDims?.width, currentUnit));
      setHeightStr(fmtForUnit(seedDims?.height, currentUnit));
      setDiameterStr(fmtForUnit(seedDims?.diameter, currentUnit));
      if (!permission?.granted && permission?.canAskAgain !== false) {
        void (async () => {
          try {
            await requestPermission();
          } catch {
            // silently handled — UI already shows "Open Settings" when
            // canAskAgain is false after a permanent denial
          }
        })();
      }
    }
  }, [visible, initialDims, initialItem, permission, requestPermission]);

  // Re-derive display strings from canonical mm refs when the unit changes.
  // Using the mm refs rather than re-parsing display strings avoids precision
  // loss and prevents partially-typed values from being corrupted mid-edit.
  useEffect(() => {
    if (!visible) { fieldUnitRef.current = unit; return; }
    if (fieldUnitRef.current === unit) return;
    fieldUnitRef.current = unit;
    setLengthStr(fmtForUnit(lengthMmRef.current, unit));
    setWidthStr(fmtForUnit(widthMmRef.current, unit));
    setHeightStr(fmtForUnit(heightMmRef.current, unit));
    setDiameterStr(fmtForUnit(diameterMmRef.current, unit));
  }, [unit, visible]);

  // ── Countdown timer for LiDAR scan phase ──────────────────────────────────
  useEffect(() => {
    if (phase !== "lidar_scanning") return;
    setScanSecsLeft(LIDAR_TIMEOUT_S);
    const interval = setInterval(() => {
      setScanSecsLeft((s) => {
        const next = s - 1;
        if (next <= 0) clearInterval(interval);
        return next > 0 ? next : 0;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [phase]);

  // ── AppState guard: cancel scan if app is backgrounded mid-scan ────────────
  useEffect(() => {
    if (phase !== "lidar_scanning") return;

    const handleAppStateChange = (nextState: AppStateStatus) => {
      if (nextState === "background" || nextState === "inactive") {
        scanInterruptedRef.current = true;
        cancelMeasure();
        setEstimateError("Scan interrupted — please try again.");
        setPhase("preview");
      }
    };

    const subscription = AppState.addEventListener("change", handleAppStateChange);
    return () => subscription.remove();
  }, [phase]);

  // ── LiDAR full scan path ────────────────────────────────────────────────────

  const handleLidarScan = useCallback(async () => {
    scanInterruptedRef.current = false;
    setScanSecsLeft(LIDAR_TIMEOUT_S);
    setPhase("lidar_scanning");
    setEstimateError(null);
    try {
      const dims = await measureObject(LIDAR_TIMEOUT_S);
      if (!isMountedRef.current) return;
      lengthMmRef.current   = dims.length ?? null;
      widthMmRef.current    = dims.width  ?? null;
      heightMmRef.current   = dims.height ?? null;
      diameterMmRef.current = null;
      setLengthStr(fmtForUnit(dims.length, unit));
      setWidthStr(fmtForUnit(dims.width, unit));
      setHeightStr(fmtForUnit(dims.height, unit));
      setDiameterStr("");
      setPhase("confirm");
    } catch (err) {
      if (scanInterruptedRef.current) {
        return;
      }
      if (!isMountedRef.current) return;
      const msg = err instanceof Error ? err.message : "LiDAR scan failed";
      setEstimateError(msg);
      setPhase("preview");
      Alert.alert(
        "LiDAR scan failed",
        `${msg}\n\n${getLidarHint(msg)}`
      );
    }
  }, [unit]);

  // ── LiDAR per-axis re-scan ──────────────────────────────────────────────────

  const handleAxisRescan = useCallback(async (axis: RescanAxis) => {
    setRescanningAxis(axis);
    try {
      const dims = await measureObject(LIDAR_TIMEOUT_S);
      if (!isMountedRef.current) return;
      if (axis === "length") { lengthMmRef.current = dims.length ?? null; setLengthStr(fmtForUnit(dims.length, unit)); }
      else if (axis === "width") { widthMmRef.current = dims.width ?? null; setWidthStr(fmtForUnit(dims.width, unit)); }
      else if (axis === "height") { heightMmRef.current = dims.height ?? null; setHeightStr(fmtForUnit(dims.height, unit)); }
    } catch (err) {
      if (!isMountedRef.current) return;
      const msg = err instanceof Error ? err.message : "LiDAR scan failed";
      Alert.alert(
        "Re-scan failed",
        `${msg}\n\n${getLidarHint(msg)}`
      );
    } finally {
      if (isMountedRef.current) setRescanningAxis(null);
    }
  }, [unit]);

  // ── AI photo-estimate path ─────────────────────────────────────────────────

  const handleCapture = useCallback(async () => {
    if (!cameraRef.current) return;
    setPhase("estimating");
    setEstimateError(null);

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), 30_000);

    try {
      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.4,
        skipProcessing: true,
      });

      if (!photo?.base64) {
        throw new Error("Camera did not return image data");
      }

      // Use the open search endpoint when no admin token is present.
      // For search-mode, dimensions are not persisted — they are only used to
      // filter inventory. Admins can also use this path when in search mode.
      const estimateUrl = adminToken
        ? `${API_BASE}/inventory/estimate-dimensions`
        : `${API_BASE}/inventory/estimate-dimensions/search`;

      const deviceId = await getDeviceId();
      const response = await fetch(estimateUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Device-ID": deviceId,
          ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
        },
        body: JSON.stringify({
          imageBase64: photo.base64,
          mimeType: "image/jpeg",
        }),
        signal: abortController.signal,
      });

      if (!isMountedRef.current) return;

      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(err.error ?? `Server error ${response.status}`);
      }

      const dims = (await response.json()) as PartDimensions;
      if (!isMountedRef.current) return;
      lengthMmRef.current   = dims.length   ?? null;
      widthMmRef.current    = dims.width    ?? null;
      heightMmRef.current   = dims.height   ?? null;
      diameterMmRef.current = dims.diameter ?? null;
      setLengthStr(fmtForUnit(dims.length, unit));
      setWidthStr(fmtForUnit(dims.width, unit));
      setHeightStr(fmtForUnit(dims.height, unit));
      setDiameterStr(fmtForUnit(dims.diameter, unit));
      setPhase("confirm");
    } catch (err) {
      if (!isMountedRef.current) return;
      const isTimeout = err instanceof Error && err.name === "AbortError";
      const msg = isTimeout
        ? "Estimate timed out — tap to retry or enter dimensions manually"
        : err instanceof Error ? err.message : "Estimation failed";
      setEstimateError(msg);
      setPhase("preview");
      if (!isTimeout) {
        Alert.alert(
          "Estimation failed",
          `${msg}\n\nYou can enter dimensions manually.`
        );
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }, [adminToken, unit]);

  // ── AI photo re-estimate from confirm screen ───────────────────────────────

  const handleCaptureOnConfirm = useCallback(async () => {
    if (!cameraRef.current) return;
    setIsReestimating(true);
    setConfirmEstimateError(null);

    // Snapshot the current field values (in mm) before the network call so
    // we can show them as "Previous" if the re-estimate succeeds.
    const snapL = parseFieldToMm(lengthStr, unit);
    const snapW = parseFieldToMm(widthStr, unit);
    const snapH = parseFieldToMm(heightStr, unit);
    const snapD = parseFieldToMm(diameterStr, unit);
    const prevSnapshot: PartDimensions | null =
      snapL != null || snapW != null || snapH != null || snapD != null
        ? { length: snapL, width: snapW, height: snapH, diameter: snapD }
        : null;

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), 30_000);

    try {
      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.4,
        skipProcessing: true,
      });

      if (!photo?.base64) {
        throw new Error("Camera did not return image data");
      }

      const reEstimateUrl = adminToken
        ? `${API_BASE}/inventory/estimate-dimensions`
        : `${API_BASE}/inventory/estimate-dimensions/search`;

      const deviceId = await getDeviceId();
      const response = await fetch(reEstimateUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Device-ID": deviceId,
          ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
        },
        body: JSON.stringify({
          imageBase64: photo.base64,
          mimeType: "image/jpeg",
        }),
        signal: abortController.signal,
      });

      if (!isMountedRef.current) return;

      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(err.error ?? `Server error ${response.status}`);
      }

      const dims = (await response.json()) as PartDimensions;
      if (!isMountedRef.current) return;
      // Show the pre-estimate values as "Previous" so admins can compare.
      lengthMmRef.current   = dims.length   ?? null;
      widthMmRef.current    = dims.width    ?? null;
      heightMmRef.current   = dims.height   ?? null;
      diameterMmRef.current = dims.diameter ?? null;
      setPreviousMmDims(prevSnapshot);
      setLengthStr(fmtForUnit(dims.length, unit));
      setWidthStr(fmtForUnit(dims.width, unit));
      setHeightStr(fmtForUnit(dims.height, unit));
      setDiameterStr(fmtForUnit(dims.diameter, unit));
    } catch (err) {
      if (!isMountedRef.current) return;
      const isTimeout = err instanceof Error && err.name === "AbortError";
      const msg = isTimeout
        ? "Estimate timed out — tap to retry or enter dimensions manually"
        : err instanceof Error ? err.message : "Estimation failed";
      setConfirmEstimateError(msg);
    } finally {
      clearTimeout(timeoutId);
      if (isMountedRef.current) setIsReestimating(false);
    }
  }, [adminToken, unit, lengthStr, widthStr, heightStr, diameterStr]);

  const handleConfirm = useCallback(() => {
    setPreviousMmDims(null);
    onConfirm({
      length: parseFieldToMm(lengthStr, unit),
      width: parseFieldToMm(widthStr, unit),
      height: parseFieldToMm(heightStr, unit),
      diameter: parseFieldToMm(diameterStr, unit),
    });
  }, [lengthStr, widthStr, heightStr, diameterStr, unit, onConfirm]);

  const goManual = useCallback(() => {
    setPhase("confirm");
    setEstimateError(null);
  }, []);

  if (!visible) return null;

  const hasCameraAccess = Platform.OS !== "web" && permission?.granted;
  const isScanning =
    phase === "estimating" ||
    phase === "lidar_scanning" ||
    rescanningAxis !== null ||
    isReestimating;

  type FieldDef = {
    label: string;
    value: string;
    set: (v: string) => void;
    onBlur: () => void;
    axis?: RescanAxis;
  };

  const fieldDefs: Array<FieldDef> = [
    { label: "Length",          value: lengthStr,   set: setLengthStr,   onBlur: () => { lengthMmRef.current   = parseFieldToMm(lengthStr,   unit); }, axis: "length" },
    { label: "Width",           value: widthStr,    set: setWidthStr,    onBlur: () => { widthMmRef.current    = parseFieldToMm(widthStr,    unit); }, axis: "width"  },
    { label: "Height",          value: heightStr,   set: setHeightStr,   onBlur: () => { heightMmRef.current   = parseFieldToMm(heightStr,   unit); }, axis: "height" },
    { label: "Diameter (opt.)", value: diameterStr, set: setDiameterStr, onBlur: () => { diameterMmRef.current = parseFieldToMm(diameterStr, unit); } },
  ];

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={ms.root}>
        {/* During LiDAR scanning (full or per-axis) show the native AR depth
            overlay so the mesh wireframe is visible; otherwise fall back to the
            regular CameraView so photo-estimate still works. */}
        {(phase === "lidar_scanning" || rescanningAxis !== null) &&
        NativeLidarDepthView ? (
          <NativeLidarDepthView style={StyleSheet.absoluteFill} unit={unit} />
        ) : hasCameraAccess ? (
          <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />
        ) : (
          <View style={[StyleSheet.absoluteFill, ms.cameraBg]} />
        )}
        {/* Dim overlay — lighter during any LiDAR scan so the mesh is clearly
            visible; darker otherwise */}
        <View
          style={[
            StyleSheet.absoluteFill,
            phase === "lidar_scanning" || rescanningAxis !== null
              ? ms.dimOverlayLight
              : ms.dimOverlay,
          ]}
        />

        <SafeAreaView style={ms.safeArea}>
          {/* Header */}
          <View style={ms.header}>
            <Pressable onPress={onClose} style={ms.closeBtn} disabled={isScanning}>
              <Feather name="x" size={20} color="#fff" />
            </Pressable>
            <Text style={ms.headerTitle}>
              {phase === "lidar_scanning"
                ? "LiDAR Scanning…"
                : phase === "estimating"
                ? "Estimating…"
                : phase === "confirm"
                ? "Review Dimensions"
                : "Measure Part"}
            </Text>
            <View style={{ width: 40 }} />
          </View>

          {/* ── Preview phase ── */}
          {phase === "preview" && (
            <View style={ms.phaseContainer}>
              <View style={ms.viewfinderBox}>
                <View style={[ms.vfCorner, ms.vfTL]} />
                <View style={[ms.vfCorner, ms.vfTR]} />
                <View style={[ms.vfCorner, ms.vfBL]} />
                <View style={[ms.vfCorner, ms.vfBR]} />
                <Text style={ms.vfLabel}>📐</Text>
              </View>

              {estimateError ? (
                <Text style={ms.errorText}>{estimateError}</Text>
              ) : null}

              {/* LiDAR primary path */}
              {lidarAvailable && (
                <>
                  <Text style={ms.instructionText}>
                    Point at the part so all sides are visible, then tap Scan.
                  </Text>
                  <Text style={ms.subText}>
                    LiDAR measures dimensions in real-time — no photo needed.
                  </Text>
                  <Pressable onPress={handleLidarScan} style={ms.lidarBtn}>
                    <Feather
                      name="maximize"
                      size={18}
                      color="#fff"
                      style={{ marginRight: 8 }}
                    />
                    <Text style={ms.lidarBtnText}>Scan with LiDAR</Text>
                  </Pressable>
                  <View style={ms.dividerRow}>
                    <View style={ms.dividerLine} />
                    <Text style={ms.dividerText}>or</Text>
                    <View style={ms.dividerLine} />
                  </View>
                </>
              )}

              {/* Photo estimate secondary / primary path */}
              {!lidarAvailable && (
                <>
                  <View style={ms.lidarUnsupportedBanner}>
                    <Feather name="info" size={15} color="#f59e0b" style={{ marginRight: 8, marginTop: 1 }} />
                    <Text style={ms.lidarUnsupportedText}>
                      LiDAR measurement requires a LiDAR-capable device (iPhone 12 Pro or later, or iPad Pro 2020 or later). Use photo estimation or enter dimensions manually.
                    </Text>
                  </View>
                  {adminToken ? (
                    <>
                      <Text style={ms.instructionText}>
                        Frame the part so all sides are visible, then tap Capture.
                      </Text>
                      <Text style={ms.subText}>
                        AI will estimate dimensions from the photo.
                      </Text>
                      <Text style={ms.subText}>
                        For better accuracy, place a coin, ruler, or dollar bill next to the part as a scale reference.
                      </Text>
                    </>
                  ) : (
                    <Text style={ms.subText}>
                      Photo estimation is not available on this device — enter dimensions manually below.
                    </Text>
                  )}
                </>
              )}

              {!permission?.granted && Platform.OS !== "web" ? (
                permission?.canAskAgain === false ? (
                  <View style={{ alignItems: "center", gap: 8 }}>
                    <Text style={[ms.permBtnText, { color: "rgba(255,255,255,0.7)", fontSize: 13, fontFamily: "Inter_400Regular" }]}>
                      Camera access was permanently denied.
                    </Text>
                    <Pressable onPress={() => void Linking.openSettings()} style={ms.permBtn}>
                      <Feather
                        name="settings"
                        size={14}
                        color="#fff"
                        style={{ marginRight: 6 }}
                      />
                      <Text style={ms.permBtnText}>Open Settings</Text>
                    </Pressable>
                  </View>
                ) : (
                  <Pressable onPress={requestPermission} style={ms.permBtn}>
                    <Feather
                      name="camera"
                      size={14}
                      color="#fff"
                      style={{ marginRight: 6 }}
                    />
                    <Text style={ms.permBtnText}>Enable Camera</Text>
                  </Pressable>
                )
              ) : (
                <Pressable
                  onPress={handleCapture}
                  style={[
                    ms.captureBtn,
                    lidarAvailable && ms.captureBtnSecondary,
                  ]}
                >
                  <Feather
                    name="camera"
                    size={18}
                    color="#fff"
                    style={{ marginRight: 8 }}
                  />
                  <Text style={ms.captureBtnText}>
                    {lidarAvailable ? "Photo Estimate Instead" : "Capture & Estimate"}
                  </Text>
                </Pressable>
              )}

              <Pressable onPress={goManual} style={ms.manualBtn}>
                <Text style={ms.manualBtnText}>Enter manually instead</Text>
              </Pressable>
            </View>
          )}

          {/* ── LiDAR scanning phase ── */}
          {phase === "lidar_scanning" && (
            <View style={ms.lidarScanContainer}>
              {/* Top hint — tells the admin what the green wireframe is */}
              <View style={ms.lidarTopHint}>
                <View style={ms.lidarDot} />
                <Text style={ms.lidarTopHintText}>
                  Live depth mesh — point at all sides of the part
                </Text>
              </View>

              {/* Spacer so the bottom card sits at the bottom */}
              <View style={{ flex: 1 }} />

              {/* Bottom status card */}
              <View style={ms.lidarStatusCard}>
                <View style={ms.lidarStatusRow}>
                  <ActivityIndicator size="small" color="#10b981" />
                  <Text style={ms.lidarStatusText}>
                    Building mesh… hold still
                  </Text>
                </View>

                {/* Countdown bar */}
                <View style={ms.countdownTrack}>
                  <View
                    style={[
                      ms.countdownFill,
                      {
                        width: `${(scanSecsLeft / LIDAR_TIMEOUT_S) * 100}%`,
                      },
                    ]}
                  />
                </View>
                <Text style={ms.countdownLabel}>
                  {scanSecsLeft > 0
                    ? `Reading for ${scanSecsLeft}s more…`
                    : "Finalising measurement…"}
                </Text>
              </View>
            </View>
          )}

          {/* ── AI estimating phase ── */}
          {phase === "estimating" && (
            <View style={ms.phaseContainer}>
              <ActivityIndicator size="large" color="#3b82f6" />
              <Text style={ms.instructionText}>Analysing photo…</Text>
              <Text style={ms.subText}>Asking AI to estimate dimensions</Text>
            </View>
          )}

          {/* ── Per-axis rescan depth overlay ── */}
          {phase === "confirm" && rescanningAxis !== null && (
            <View
              style={[ms.axisOverlayContainer, { pointerEvents: "none" }]}
            >
              <Animated.View
                style={[
                  ms.axisOverlayRing,
                  {
                    opacity: scanPulse.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0.35, 0.9],
                    }),
                    transform: [
                      {
                        scale: scanPulse.interpolate({
                          inputRange: [0, 1],
                          outputRange: [0.88, 1.08],
                        }),
                      },
                    ],
                  },
                ]}
              />
              <View style={ms.axisOverlayInner}>
                <ActivityIndicator size="large" color="#10b981" />
                <Text style={ms.axisOverlayScanText}>
                  Scanning{" "}
                  {rescanningAxis.charAt(0).toUpperCase() +
                    rescanningAxis.slice(1)}
                  …
                </Text>
                <Text style={ms.axisOverlaySubText}>
                  Hold still — reading depth ({LIDAR_TIMEOUT_S} s)
                </Text>
              </View>
            </View>
          )}

          {/* ── Confirm phase ── */}
          {phase === "confirm" && (
            <View style={ms.confirmContainer}>
              <View style={ms.confirmCard}>
                <Text style={ms.confirmTitle}>
                  {lengthStr || widthStr || heightStr
                    ? "Measured Dimensions"
                    : "Enter Dimensions"}
                </Text>
                <Text style={ms.confirmSub}>
                  {lengthStr || widthStr || heightStr
                    ? `Review and adjust before saving. All values in ${unitLabel(unit)}.`
                    : `All values in ${unitLabel(unit)}. Leave blank to skip.`}
                </Text>

                {/* Unit picker */}
                <View style={ms.unitPickerRow}>
                  {(["mm", "cm", "in"] as Array<DimensionUnit>).map((u) => (
                    <Pressable
                      key={u}
                      onPress={() => {
                        updateSetting("dimensionUnit", u);
                      }}
                      style={[
                        ms.unitPickerBtn,
                        unit === u && ms.unitPickerBtnActive,
                      ]}
                    >
                      <Text
                        style={[
                          ms.unitPickerBtnText,
                          unit === u && ms.unitPickerBtnTextActive,
                        ]}
                      >
                        {u}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                <View style={ms.fieldsGrid}>
                  {fieldDefs.map(({ label, value, set, onBlur, axis }) => {
                    const isRescanning = axis != null && rescanningAxis === axis;
                    const anyRescanning = rescanningAxis !== null;
                    return (
                      <View key={label} style={ms.fieldGroup}>
                        <View style={ms.fieldLabelRow}>
                          <Text style={ms.fieldLabel}>{label}</Text>
                          {lidarAvailable && axis != null && (
                            <Pressable
                              onPress={() => handleAxisRescan(axis)}
                              disabled={anyRescanning}
                              style={[
                                ms.axisRescanBtn,
                                anyRescanning && ms.axisRescanBtnDisabled,
                              ]}
                              accessibilityLabel={`Re-scan ${label} with LiDAR`}
                            >
                              {isRescanning ? (
                                <ActivityIndicator size={10} color="#10b981" />
                              ) : (
                                <Feather
                                  name="refresh-cw"
                                  size={11}
                                  color={anyRescanning ? "#bbb" : "#10b981"}
                                />
                              )}
                            </Pressable>
                          )}
                        </View>
                        <KeyboardDoneInput
                          value={value}
                          onChangeText={(v) =>
                            set(v.replace(/[^0-9.]/g, ""))
                          }
                          onBlur={onBlur}
                          placeholder="–"
                          placeholderTextColor="#aaa"
                          keyboardType="numeric"
                          returnKeyType="next"
                          editable={!isRescanning && !isReestimating}
                          style={[
                            ms.fieldInput,
                            isRescanning && ms.fieldInputRescanning,
                            isReestimating && ms.fieldInputReestimating,
                          ]}
                        />
                      </View>
                    );
                  })}
                </View>

                {previousMmDims && (
                  <Text style={ms.previousDimsText}>
                    {[
                      (previousMmDims.length != null ||
                        previousMmDims.width != null ||
                        previousMmDims.height != null)
                        ? `Previous: ${fmtForUnit(previousMmDims.length, unit)} × ${fmtForUnit(previousMmDims.width, unit)} × ${fmtForUnit(previousMmDims.height, unit)} ${unitLabel(unit)}`
                        : null,
                      previousMmDims.diameter != null
                        ? `⌀ ${fmtForUnit(previousMmDims.diameter, unit)} ${unitLabel(unit)}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join("   ")}
                  </Text>
                )}

                {lengthStr && widthStr && heightStr ? (
                  <Text style={ms.dimPreview}>
                    {[
                      `${lengthStr} × ${widthStr} × ${heightStr} ${unitLabel(unit)}`,
                      diameterStr ? `⌀ ${diameterStr} ${unitLabel(unit)}` : null,
                    ]
                      .filter(Boolean)
                      .join("   ")}
                  </Text>
                ) : null}

                {confirmEstimateError ? (
                  <Text style={ms.confirmEstimateError}>
                    {confirmEstimateError}
                  </Text>
                ) : null}

                <Pressable
                  onPress={handleCaptureOnConfirm}
                  disabled={isReestimating || rescanningAxis !== null}
                  style={[
                    ms.photoEstimateBtn,
                    (isReestimating || rescanningAxis !== null) &&
                      ms.photoEstimateBtnDisabled,
                  ]}
                >
                  {isReestimating ? (
                    <ActivityIndicator
                      size="small"
                      color="#3b82f6"
                      style={{ marginRight: 8 }}
                    />
                  ) : (
                    <Feather
                      name="camera"
                      size={15}
                      color={rescanningAxis !== null ? "#aaa" : "#3b82f6"}
                      style={{ marginRight: 8 }}
                    />
                  )}
                  <Text
                    style={[
                      ms.photoEstimateBtnText,
                      (isReestimating || rescanningAxis !== null) &&
                        ms.photoEstimateBtnTextDisabled,
                    ]}
                  >
                    {isReestimating ? "Estimating…" : "Photo Estimate"}
                  </Text>
                </Pressable>

                <View style={ms.btnRow}>
                  <Pressable
                    onPress={() => setPhase("preview")}
                    disabled={rescanningAxis !== null || isReestimating}
                    style={[
                      ms.rescanBtn,
                      (rescanningAxis !== null || isReestimating) && ms.rescanBtnDisabled,
                    ]}
                  >
                    <Text style={ms.rescanBtnText}>Re-scan all</Text>
                  </Pressable>
                  <Pressable
                    onPress={handleConfirm}
                    disabled={rescanningAxis !== null || isReestimating}
                    style={[
                      ms.confirmBtn,
                      (rescanningAxis !== null || isReestimating) && ms.confirmBtnDisabled,
                    ]}
                  >
                    <Text style={ms.confirmBtnText}>Save Dimensions</Text>
                  </Pressable>
                </View>
              </View>
            </View>
          )}
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const CORNER = 22;
const CORNER_W = 3;

const ms = StyleSheet.create({
  // ── Unit picker ─────────────────────────────────────────────────────────────
  unitPickerRow: {
    flexDirection: "row",
    gap: 6,
    marginBottom: 4,
  },
  unitPickerBtn: {
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.25)",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  unitPickerBtnActive: {
    borderColor: "#10b981",
    backgroundColor: "rgba(16,185,129,0.18)",
  },
  unitPickerBtnText: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  unitPickerBtnTextActive: {
    color: "#10b981",
  },

  root: { flex: 1, backgroundColor: "#000" },
  cameraBg: { backgroundColor: "#111" },
  dimOverlay: { backgroundColor: "rgba(0,0,0,0.45)" },
  dimOverlayLight: { backgroundColor: "rgba(0,0,0,0.18)" },

  // ── LiDAR scanning phase ────────────────────────────────────────────────────
  lidarScanContainer: {
    flex: 1,
    paddingHorizontal: 16,
    paddingBottom: 20,
  },
  lidarTopHint: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "center",
    marginTop: 20,
    gap: 8,
    backgroundColor: "rgba(0,0,0,0.55)",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
  },
  lidarDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#10b981",
  },
  lidarTopHintText: {
    color: "#fff",
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  lidarStatusCard: {
    backgroundColor: "rgba(0,0,0,0.72)",
    borderRadius: 16,
    padding: 16,
    gap: 10,
  },
  lidarStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  lidarStatusText: {
    color: "#fff",
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  countdownTrack: {
    height: 4,
    backgroundColor: "rgba(255,255,255,0.15)",
    borderRadius: 2,
    overflow: "hidden",
  },
  countdownFill: {
    height: 4,
    backgroundColor: "#10b981",
    borderRadius: 2,
  },
  countdownLabel: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  safeArea: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  closeBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: { color: "#fff", fontSize: 17, fontFamily: "Inter_600SemiBold" },
  phaseContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    gap: 18,
  },
  viewfinderBox: {
    width: 240,
    height: 200,
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
  },
  vfCorner: {
    position: "absolute",
    width: CORNER,
    height: CORNER,
    borderColor: "#fff",
  },
  vfTL: { top: 0, left: 0, borderTopWidth: CORNER_W, borderLeftWidth: CORNER_W },
  vfTR: { top: 0, right: 0, borderTopWidth: CORNER_W, borderRightWidth: CORNER_W },
  vfBL: {
    bottom: 0,
    left: 0,
    borderBottomWidth: CORNER_W,
    borderLeftWidth: CORNER_W,
  },
  vfBR: {
    bottom: 0,
    right: 0,
    borderBottomWidth: CORNER_W,
    borderRightWidth: CORNER_W,
  },
  vfLabel: { fontSize: 32 },
  instructionText: {
    color: "#fff",
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    textAlign: "center",
    maxWidth: 280,
  },
  subText: {
    color: "rgba(255,255,255,0.65)",
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    maxWidth: 280,
  },
  errorText: {
    color: "#fca5a5",
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    maxWidth: 280,
  },
  lidarBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#10b981",
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 12,
  },
  lidarBtnText: { color: "#fff", fontSize: 16, fontFamily: "Inter_700Bold" },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    width: 240,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: "rgba(255,255,255,0.25)" },
  dividerText: {
    color: "rgba(255,255,255,0.45)",
    fontSize: 12,
    fontFamily: "Inter_400Regular",
  },
  permBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.15)",
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 10,
  },
  permBtnText: { color: "#fff", fontSize: 13, fontFamily: "Inter_500Medium" },
  captureBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#3b82f6",
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 12,
  },
  captureBtnSecondary: {
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  captureBtnText: { color: "#fff", fontSize: 16, fontFamily: "Inter_700Bold" },
  lidarUnsupportedBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: "rgba(245,158,11,0.15)",
    borderWidth: 1,
    borderColor: "rgba(245,158,11,0.4)",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    maxWidth: 300,
  },
  lidarUnsupportedText: {
    flex: 1,
    color: "#fde68a",
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
  manualBtn: { paddingVertical: 8 },
  manualBtnText: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    textDecorationLine: "underline",
  },
  confirmContainer: { flex: 1, justifyContent: "flex-end", padding: 16 },
  confirmCard: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 20,
    gap: 10,
  },
  confirmTitle: { fontSize: 16, fontFamily: "Inter_700Bold", color: "#111" },
  confirmSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#888",
    marginTop: -4,
  },
  fieldsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  fieldGroup: { width: "47%", gap: 4 },
  fieldLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  fieldLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: "#555",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  axisRescanBtn: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "rgba(16,185,129,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  axisRescanBtnDisabled: {
    backgroundColor: "rgba(0,0,0,0.05)",
  },
  fieldInput: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: "#111",
    backgroundColor: "#f5f5f5",
  },
  fieldInputRescanning: {
    borderColor: "#10b981",
    backgroundColor: "#f0fdf8",
  },
  previousDimsText: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.45)",
    textAlign: "center",
    letterSpacing: 0.2,
    marginTop: 2,
  },
  dimPreview: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#3b82f6",
    textAlign: "center",
    letterSpacing: 0.3,
  },
  btnRow: { flexDirection: "row", gap: 10, marginTop: 4 },
  rescanBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: "center",
  },
  rescanBtnDisabled: {
    opacity: 0.4,
  },
  rescanBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#444" },
  confirmBtn: {
    flex: 2,
    backgroundColor: "#3b82f6",
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: "center",
  },
  confirmBtnDisabled: {
    opacity: 0.4,
  },
  confirmBtnText: { fontSize: 15, fontFamily: "Inter_700Bold", color: "#fff" },
  confirmEstimateError: {
    color: "#ef4444",
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  photoEstimateBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#3b82f6",
    borderRadius: 10,
    paddingVertical: 11,
    backgroundColor: "rgba(59,130,246,0.06)",
  },
  photoEstimateBtnDisabled: {
    borderColor: "#ddd",
    backgroundColor: "rgba(0,0,0,0.03)",
  },
  photoEstimateBtnText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: "#3b82f6",
  },
  photoEstimateBtnTextDisabled: {
    color: "#aaa",
  },
  fieldInputReestimating: {
    borderColor: "#3b82f6",
    backgroundColor: "#eff6ff",
  },
  axisOverlayContainer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    paddingBottom: 260,
  },
  axisOverlayRing: {
    position: "absolute",
    width: 180,
    height: 180,
    borderRadius: 90,
    borderWidth: 2,
    borderColor: "#10b981",
    backgroundColor: "rgba(16,185,129,0.08)",
  },
  axisOverlayInner: {
    alignItems: "center",
    gap: 12,
  },
  axisOverlayScanText: {
    color: "#fff",
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    textAlign: "center",
  },
  axisOverlaySubText: {
    color: "rgba(255,255,255,0.65)",
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
});
