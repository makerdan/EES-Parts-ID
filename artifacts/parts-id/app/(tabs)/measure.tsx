/**
 * Measure Tab — Admin-only LiDAR dimension capture screen.
 *
 * Mounts NativeLidarDepthView so admins can scan a part's bounding-box
 * dimensions directly from the tab bar.  After a successful scan the confirmed
 * dimensions are either:
 *
 *   a) Written back to the item-edit form that launched this screen
 *      (when `fromItemForm=true` param is present): stored in AppContext's
 *      `pendingLidarDims`, then the screen navigates back so `edit-item` can
 *      read and pre-fill the form fields.
 *
 *   b) Applied as a size-range filter on the Search tab (standalone path):
 *      stored in AppContext's `pendingMeasureSearch`.
 *
 * Hidden in the tab bar on non-LiDAR devices and non-admin users — see _layout.tsx.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  AppStateStatus,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { KeyboardDoneInput } from "@/components/KeyboardDoneInput";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Feather } from "@expo/vector-icons";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import {
  cancelMeasure,
  isLiDARSupported,
  measureObject,
  NativeLidarDepthView,
} from "lidar-measure";
import { useApp, type DimensionUnit } from "@/contexts/AppContext";
import { useColors } from "@/hooks/useColors";
import { useTrackScreen } from "@/utils/useTrackScreen";
import { fmtForUnit, parseFieldToMm } from "@/components/MeasurePartScreen";

const LIDAR_TIMEOUT_S = 4;

const LIDAR_HINTS: Record<string, string> = {
  ERR_LIDAR_NOT_SUPPORTED:
    "LiDAR is not available on this device.",
  ERR_NO_FRAME:
    "Move closer to the object and try again.",
  ERR_NO_MESH:
    "No surface detected — aim directly at the part and try again.",
  ERR_ZERO_DIMS:
    "The object may be too small or too far away. Adjust your distance.",
  ERR_INTERRUPTED:
    "Scan was interrupted. Please try again.",
};

function getLidarHint(msg: string): string {
  for (const [code, hint] of Object.entries(LIDAR_HINTS)) {
    if (msg.includes(code)) return hint;
  }
  return "Try again or enter dimensions manually on the edit form.";
}

type Phase = "ready" | "scanning" | "confirm";

export default function MeasureScreen() {
  "use no memo";
  useTrackScreen("Measure Part");

  const colors = useColors();
  const {
    settings,
    isAdmin,
    setPendingMeasureSearch,
    setPendingLidarDims,
    showToast,
  } = useApp();
  const unit = settings.dimensionUnit;

  // `fromItemForm=true` is passed by edit-item.tsx when the admin taps LiDAR.
  // In that mode, confirming dims stores them in pendingLidarDims and navigates
  // back instead of forwarding to the Search tab.
  const { fromItemForm, itemLabel } = useLocalSearchParams<{
    fromItemForm?: string;
    itemLabel?: string;
  }>();
  const isItemFormMode = fromItemForm === "true";

  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>("ready");
  const [scanSecsLeft, setScanSecsLeft] = useState(LIDAR_TIMEOUT_S);
  const [scanError, setScanError] = useState<string | null>(null);

  const [lengthStr, setLengthStr] = useState("");
  const [widthStr, setWidthStr] = useState("");
  const [heightStr, setHeightStr] = useState("");

  const scanInterruptedRef = useRef(false);

  const scanPulse = useRef(new Animated.Value(0)).current;
  const scanLoopRef = useRef<Animated.CompositeAnimation | null>(null);

  const lidarSupported = isLiDARSupported();

  // ── Request camera permission on first focus and reset state ─────────────────
  useFocusEffect(
    useCallback(() => {
      if (!permission?.granted && Platform.OS !== "web") {
        requestPermission();
      }
      setPhase("ready");
      setScanError(null);
      setScanSecsLeft(LIDAR_TIMEOUT_S);
      setLengthStr("");
      setWidthStr("");
      setHeightStr("");
      return () => {
        if (phase === "scanning") {
          cancelMeasure();
        }
      };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [permission, requestPermission])
  );

  // ── Pulse animation during scan ─────────────────────────────────────────────
  useEffect(() => {
    if (phase === "scanning") {
      scanLoopRef.current = Animated.loop(
        Animated.sequence([
          Animated.timing(scanPulse, { toValue: 1, duration: 900, useNativeDriver: true }),
          Animated.timing(scanPulse, { toValue: 0, duration: 900, useNativeDriver: true }),
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
  }, [phase, scanPulse]);

  // ── Countdown timer ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== "scanning") return;
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

  // ── Cancel scan if app is backgrounded ─────────────────────────────────────
  useEffect(() => {
    if (phase !== "scanning") return;
    const handleAppState = (nextState: AppStateStatus) => {
      if (nextState === "background" || nextState === "inactive") {
        scanInterruptedRef.current = true;
        cancelMeasure();
        setScanError("Scan interrupted — please try again.");
        setPhase("ready");
      }
    };
    const sub = AppState.addEventListener("change", handleAppState);
    return () => sub.remove();
  }, [phase]);

  // ── LiDAR scan ──────────────────────────────────────────────────────────────
  const handleScan = useCallback(async () => {
    scanInterruptedRef.current = false;
    setScanError(null);
    setPhase("scanning");
    try {
      const dims = await measureObject(LIDAR_TIMEOUT_S);
      setLengthStr(fmtForUnit(dims.length, unit));
      setWidthStr(fmtForUnit(dims.width, unit));
      setHeightStr(fmtForUnit(dims.height, unit));
      setPhase("confirm");
    } catch (err) {
      if (scanInterruptedRef.current) return;
      const msg = err instanceof Error ? err.message : "LiDAR scan failed";
      setScanError(msg);
      setPhase("ready");
      Alert.alert("Scan failed", `${msg}\n\n${getLidarHint(msg)}`);
    }
  }, [unit]);

  // ── Confirm: apply dims to item-edit form (item-form mode) ──────────────────
  const handleApplyToForm = useCallback(() => {
    const toMm = (s: string) => parseFieldToMm(s, unit);
    setPendingLidarDims({
      length: toMm(lengthStr),
      width: toMm(widthStr),
      height: toMm(heightStr),
      diameter: null,
    });
    showToast("Dimensions ready — pre-filling the form.");
    router.back();
  }, [lengthStr, widthStr, heightStr, unit, setPendingLidarDims, showToast]);

  // ── Confirm: search by captured dimensions (standalone mode) ─────────────────
  const handleSearchByDimensions = useCallback(() => {
    const toStr = (s: string) => {
      const mm = parseFieldToMm(s, unit);
      return mm != null ? String(Math.round(mm)) : "";
    };
    const params = {
      minLength: toStr(lengthStr),
      maxLength: toStr(lengthStr),
      minWidth: toStr(widthStr),
      maxWidth: toStr(widthStr),
      minHeight: toStr(heightStr),
      maxHeight: toStr(heightStr),
      minDiameter: "",
      maxDiameter: "",
    };
    if (Object.values(params).some(Boolean)) {
      setPendingMeasureSearch(params);
      showToast("Dimensions applied to search.");
    }
    router.navigate("/");
  }, [lengthStr, widthStr, heightStr, unit, setPendingMeasureSearch, showToast]);

  const handleRescan = useCallback(() => {
    setLengthStr("");
    setWidthStr("");
    setHeightStr("");
    setScanError(null);
    setPhase("ready");
  }, []);

  const unitLabel = unit === "in" ? "in" : unit;
  const pulseOpacity = scanPulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] });
  const hasCameraAccess = Platform.OS !== "web" && permission?.granted;
  const isScanning = phase === "scanning";
  const progressPct = isScanning ? (LIDAR_TIMEOUT_S - scanSecsLeft) / LIDAR_TIMEOUT_S : 0;
  const hasDims = !!(lengthStr || widthStr || heightStr);

  // ── Guard: non-admin or non-LiDAR device ────────────────────────────────────
  if (!isAdmin || !lidarSupported) {
    return (
      <SafeAreaView style={[s.root, { backgroundColor: colors.background }]}>
        <View style={s.unsupportedContainer}>
          <Feather name="lock" size={40} color={colors.mutedForeground} />
          <Text style={[s.unsupportedTitle, { color: colors.foreground }]}>
            {!isAdmin ? "Admin access required" : "LiDAR not available"}
          </Text>
          <Text style={[s.unsupportedSub, { color: colors.mutedForeground }]}>
            {!isAdmin
              ? "Sign in as an admin to access the Measure tab."
              : "LiDAR scanning requires an iPhone 12 Pro or later, or an iPad Pro (2020 or later)."}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={s.root}>
      {/* Camera / AR depth view fills the screen */}
      {isScanning && NativeLidarDepthView ? (
        <NativeLidarDepthView style={StyleSheet.absoluteFill} unit={unit} />
      ) : hasCameraAccess ? (
        <CameraView style={StyleSheet.absoluteFill} facing="back" />
      ) : (
        <View style={[StyleSheet.absoluteFill, s.cameraBg]} />
      )}

      {/* Dim overlay */}
      <View
        style={[
          StyleSheet.absoluteFill,
          isScanning ? s.dimOverlayLight : s.dimOverlay,
        ]}
      />

      <SafeAreaView style={s.safeArea}>
        {/* Header */}
        <View style={s.header}>
          <View style={{ width: 40 }} />
          <Text style={s.headerTitle}>
            {isScanning
              ? "LiDAR Scanning…"
              : phase === "confirm"
              ? "Dimensions Captured"
              : "Measure Part"}
          </Text>
          <View style={{ width: 40 }} />
        </View>

        {/* Context banner when launched from an item form */}
        {isItemFormMode && phase !== "scanning" ? (
          <View style={s.contextBanner}>
            <Feather name="edit-2" size={13} color="rgba(255,255,255,0.75)" style={{ marginRight: 6 }} />
            <Text style={s.contextBannerText} numberOfLines={1}>
              {itemLabel
                ? `For: ${itemLabel}`
                : "Scan to pre-fill item dimensions"}
            </Text>
          </View>
        ) : null}

        {/* ── Ready phase ──────────────────────────────────────────────────── */}
        {phase === "ready" && (
          <View style={s.phaseContainer}>
            <View style={s.viewfinderBox}>
              <View style={[s.vfCorner, s.vfTL]} />
              <View style={[s.vfCorner, s.vfTR]} />
              <View style={[s.vfCorner, s.vfBL]} />
              <View style={[s.vfCorner, s.vfBR]} />
              <Text style={s.vfEmoji}>📐</Text>
            </View>

            {scanError ? (
              <Text style={s.errorText}>{scanError}</Text>
            ) : null}

            <Text style={s.instructionText}>
              Point at the part so all sides are visible, then tap Scan.
            </Text>
            <Text style={s.subText}>
              LiDAR measures real bounding-box dimensions — no photo needed.
            </Text>

            {!hasCameraAccess && Platform.OS !== "web" ? (
              <Pressable onPress={requestPermission} style={s.permBtn}>
                <Feather name="camera" size={14} color="#fff" style={{ marginRight: 6 }} />
                <Text style={s.permBtnText}>Enable Camera</Text>
              </Pressable>
            ) : (
              <Pressable onPress={handleScan} style={s.scanBtn}>
                <Feather name="maximize" size={18} color="#fff" style={{ marginRight: 8 }} />
                <Text style={s.scanBtnText}>Scan with LiDAR</Text>
              </Pressable>
            )}
          </View>
        )}

        {/* ── Scanning phase ───────────────────────────────────────────────── */}
        {phase === "scanning" && (
          <View style={s.scanningContainer}>
            <Animated.View style={[s.scanRing, { opacity: pulseOpacity }]}>
              <View style={s.scanRingInner}>
                <ActivityIndicator size="large" color="#10b981" />
                <Text style={s.scanLabel}>Scanning…</Text>
                <Text style={s.scanSecs}>{scanSecsLeft}s</Text>
              </View>
            </Animated.View>

            <View style={s.progressBarWrap}>
              <View style={s.progressTrack}>
                <View style={[s.progressFill, { width: `${progressPct * 100}%` }]} />
              </View>
              <Text style={s.progressLabel}>Building depth mesh…</Text>
            </View>

            <Pressable
              onPress={() => {
                cancelMeasure();
                scanInterruptedRef.current = true;
                setPhase("ready");
                setScanError(null);
              }}
              style={s.cancelBtn}
            >
              <Text style={s.cancelBtnText}>Cancel</Text>
            </Pressable>
          </View>
        )}

        {/* ── Confirm phase ────────────────────────────────────────────────── */}
        {phase === "confirm" && (
          <View style={s.confirmContainer}>
            <View style={s.confirmCard}>
              <Text style={s.confirmTitle}>Dimensions scanned</Text>
              <Text style={s.confirmSub}>
                Review and edit values ({unitLabel}), then confirm.
              </Text>

              {/* Dimension fields */}
              <View style={s.fieldsGrid}>
                {(
                  [
                    { label: "Length", value: lengthStr, set: setLengthStr },
                    { label: "Width", value: widthStr, set: setWidthStr },
                    { label: "Height", value: heightStr, set: setHeightStr },
                  ] as const
                ).map(({ label, value, set }) => (
                  <View key={label} style={s.fieldGroup}>
                    <Text style={s.fieldLabel}>{label}</Text>
                    <KeyboardDoneInput
                      value={value}
                      onChangeText={set}
                      keyboardType="decimal-pad"
                      returnKeyType="done"
                      selectTextOnFocus
                      style={s.fieldInput}
                      placeholder="—"
                      placeholderTextColor="#aaa"
                    />
                  </View>
                ))}
              </View>

              <Text style={s.unitNote}>
                Values in{" "}
                {unit === "mm"
                  ? "millimetres"
                  : unit === "cm"
                  ? "centimetres"
                  : "inches"}
                . Change the unit in Settings.
              </Text>

              {/* Primary action — changes based on mode */}
              {isItemFormMode ? (
                <Pressable
                  onPress={handleApplyToForm}
                  disabled={!hasDims}
                  style={[s.primaryBtn, !hasDims && s.primaryBtnDisabled]}
                >
                  <Feather name="check" size={16} color="#fff" style={{ marginRight: 8 }} />
                  <Text style={s.primaryBtnText}>
                    {itemLabel ? `Apply to ${itemLabel}` : "Apply to Item Form"}
                  </Text>
                </Pressable>
              ) : (
                <Pressable
                  onPress={handleSearchByDimensions}
                  disabled={!hasDims}
                  style={[s.primaryBtn, !hasDims && s.primaryBtnDisabled]}
                >
                  <Feather name="search" size={16} color="#fff" style={{ marginRight: 8 }} />
                  <Text style={s.primaryBtnText}>Search by These Dimensions</Text>
                </Pressable>
              )}

              <Pressable onPress={handleRescan} style={s.rescanBtn}>
                <Feather name="refresh-cw" size={14} color="#444" style={{ marginRight: 6 }} />
                <Text style={s.rescanBtnText}>Rescan</Text>
              </Pressable>
            </View>
          </View>
        )}
      </SafeAreaView>
    </View>
  );
}

const CORNER = 20;
const CORNER_W = 3;

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  safeArea: { flex: 1 },
  cameraBg: { backgroundColor: "#1a1a1a" },
  dimOverlay: { backgroundColor: "rgba(0,0,0,0.55)" },
  dimOverlayLight: { backgroundColor: "rgba(0,0,0,0.2)" },
  unsupportedContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 40,
    gap: 16,
  },
  unsupportedTitle: {
    fontSize: 18,
    fontFamily: "Inter_600SemiBold",
    textAlign: "center",
  },
  unsupportedSub: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 20,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  headerTitle: {
    color: "#fff",
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
  },
  contextBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(59,130,246,0.25)",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(59,130,246,0.3)",
  },
  contextBannerText: {
    color: "rgba(255,255,255,0.85)",
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    flex: 1,
  },
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
  vfBL: { bottom: 0, left: 0, borderBottomWidth: CORNER_W, borderLeftWidth: CORNER_W },
  vfBR: { bottom: 0, right: 0, borderBottomWidth: CORNER_W, borderRightWidth: CORNER_W },
  vfEmoji: { fontSize: 32 },
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
  permBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.15)",
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 10,
  },
  permBtnText: { color: "#fff", fontSize: 13, fontFamily: "Inter_500Medium" },
  scanBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#10b981",
    paddingHorizontal: 32,
    paddingVertical: 16,
    borderRadius: 14,
  },
  scanBtnText: { color: "#fff", fontSize: 16, fontFamily: "Inter_700Bold" },
  scanningContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 32,
    paddingHorizontal: 24,
  },
  scanRing: {
    width: 200,
    height: 200,
    borderRadius: 100,
    borderWidth: 2,
    borderColor: "#10b981",
    backgroundColor: "rgba(16,185,129,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  scanRingInner: {
    alignItems: "center",
    gap: 10,
  },
  scanLabel: {
    color: "#fff",
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
  scanSecs: {
    color: "#10b981",
    fontSize: 28,
    fontFamily: "Inter_700Bold",
  },
  progressBarWrap: {
    width: "100%",
    maxWidth: 280,
    gap: 6,
  },
  progressTrack: {
    width: "100%",
    height: 4,
    backgroundColor: "rgba(255,255,255,0.15)",
    borderRadius: 2,
    overflow: "hidden",
  },
  progressFill: {
    height: 4,
    backgroundColor: "#10b981",
    borderRadius: 2,
  },
  progressLabel: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  cancelBtn: {
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  cancelBtnText: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    textDecorationLine: "underline",
  },
  confirmContainer: {
    flex: 1,
    justifyContent: "flex-end",
    padding: 16,
    paddingBottom: 24,
  },
  confirmCard: {
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 20,
    gap: 14,
  },
  confirmTitle: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: "#111",
  },
  confirmSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#888",
    marginTop: -6,
  },
  fieldsGrid: {
    flexDirection: "row",
    gap: 10,
  },
  fieldGroup: {
    flex: 1,
    gap: 4,
  },
  fieldLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: "#555",
    textTransform: "uppercase",
    letterSpacing: 0.5,
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
  unitNote: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: "#aaa",
    marginTop: -6,
  },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#3b82f6",
    borderRadius: 12,
    paddingVertical: 14,
  },
  primaryBtnDisabled: {
    opacity: 0.4,
  },
  primaryBtnText: {
    color: "#fff",
    fontSize: 15,
    fontFamily: "Inter_700Bold",
  },
  rescanBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 12,
    paddingVertical: 12,
  },
  rescanBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "#444",
  },
});
