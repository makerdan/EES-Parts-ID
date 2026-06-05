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
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Device from "expo-device";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { isLiDARSupported, measureObject } from "lidar-measure";

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

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : "http://localhost:8080/api";

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
  adminToken: string;
}

type Phase = "preview" | "lidar_scanning" | "estimating" | "confirm";

const LIDAR_TIMEOUT_S = 4;

function parseField(s: string): number | null {
  const n = parseFloat(s);
  return isNaN(n) || n < 0 ? null : Math.round(n * 10) / 10;
}

function fmt(v: number | null | undefined): string {
  return v == null ? "" : String(Math.round(v));
}

export function MeasurePartScreen({
  visible,
  onClose,
  onConfirm,
  initialDims,
  adminToken,
}: MeasurePartScreenProps) {
  const colors = useColors();
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>("preview");
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [lidarAvailable] = useState<boolean>(() => isLiDARSupported());

  const [lengthStr, setLengthStr] = useState("");
  const [widthStr, setWidthStr] = useState("");
  const [heightStr, setHeightStr] = useState("");
  const [diameterStr, setDiameterStr] = useState("");

  const cameraRef = useRef<CameraView>(null);

  useEffect(() => {
    if (visible) {
      setPhase("preview");
      setEstimateError(null);
      setLengthStr(fmt(initialDims?.length));
      setWidthStr(fmt(initialDims?.width));
      setHeightStr(fmt(initialDims?.height));
      setDiameterStr(fmt(initialDims?.diameter));
      if (!permission?.granted) requestPermission();
    }
  }, [visible, initialDims, permission, requestPermission]);

  // ── LiDAR scan path ────────────────────────────────────────────────────────

  const handleLidarScan = useCallback(async () => {
    setPhase("lidar_scanning");
    setEstimateError(null);
    try {
      const dims = await measureObject(LIDAR_TIMEOUT_S);
      setLengthStr(fmt(dims.length));
      setWidthStr(fmt(dims.width));
      setHeightStr(fmt(dims.height));
      setDiameterStr("");
      setPhase("confirm");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "LiDAR scan failed";
      setEstimateError(msg);
      setPhase("preview");
      Alert.alert(
        "LiDAR scan failed",
        `${msg}\n\nYou can use photo estimation or enter dimensions manually.`
      );
    }
  }, []);

  // ── AI photo-estimate path ─────────────────────────────────────────────────

  const handleCapture = useCallback(async () => {
    if (!cameraRef.current) return;
    setPhase("estimating");
    setEstimateError(null);

    try {
      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.4,
        skipProcessing: true,
      });

      if (!photo?.base64) {
        throw new Error("Camera did not return image data");
      }

      const response = await fetch(`${API_BASE}/inventory/estimate-dimensions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          imageBase64: photo.base64,
          mimeType: "image/jpeg",
        }),
      });

      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(err.error ?? `Server error ${response.status}`);
      }

      const dims = (await response.json()) as PartDimensions;
      setLengthStr(fmt(dims.length));
      setWidthStr(fmt(dims.width));
      setHeightStr(fmt(dims.height));
      setDiameterStr(fmt(dims.diameter));
      setPhase("confirm");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Estimation failed";
      setEstimateError(msg);
      setPhase("preview");
      Alert.alert(
        "Estimation failed",
        `${msg}\n\nYou can enter dimensions manually.`
      );
    }
  }, [adminToken]);

  const handleConfirm = useCallback(() => {
    onConfirm({
      length: parseField(lengthStr),
      width: parseField(widthStr),
      height: parseField(heightStr),
      diameter: parseField(diameterStr),
    });
  }, [lengthStr, widthStr, heightStr, diameterStr, onConfirm]);

  const goManual = useCallback(() => {
    setPhase("confirm");
    setEstimateError(null);
  }, []);

  if (!visible) return null;

  const hasCameraAccess = Platform.OS !== "web" && permission?.granted;
  const isScanning = phase === "estimating" || phase === "lidar_scanning";

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={ms.root}>
        {hasCameraAccess ? (
          <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />
        ) : (
          <View style={[StyleSheet.absoluteFill, ms.cameraBg]} />
        )}
        <View style={[StyleSheet.absoluteFill, ms.dimOverlay]} />

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
                  <Text style={ms.instructionText}>
                    Frame the part so all sides are visible, then tap Capture.
                  </Text>
                  <Text style={ms.subText}>
                    AI will estimate dimensions from the photo.
                  </Text>
                </>
              )}

              {!permission?.granted && Platform.OS !== "web" ? (
                <Pressable onPress={requestPermission} style={ms.permBtn}>
                  <Feather
                    name="camera"
                    size={14}
                    color="#fff"
                    style={{ marginRight: 6 }}
                  />
                  <Text style={ms.permBtnText}>Enable Camera</Text>
                </Pressable>
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
            <View style={ms.phaseContainer}>
              <ActivityIndicator size="large" color="#10b981" />
              <Text style={ms.instructionText}>Scanning with LiDAR…</Text>
              <Text style={ms.subText}>
                Hold still — reading depth data ({LIDAR_TIMEOUT_S} s)
              </Text>
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
                    ? "Review and adjust before saving. All values in mm."
                    : "All values in mm. Leave blank to skip."}
                </Text>

                <View style={ms.fieldsGrid}>
                  {(
                    [
                      { label: "Length", value: lengthStr, set: setLengthStr },
                      { label: "Width", value: widthStr, set: setWidthStr },
                      { label: "Height", value: heightStr, set: setHeightStr },
                      {
                        label: "Diameter (opt.)",
                        value: diameterStr,
                        set: setDiameterStr,
                      },
                    ] as const
                  ).map(({ label, value, set }) => (
                    <View key={label} style={ms.fieldGroup}>
                      <Text style={ms.fieldLabel}>{label}</Text>
                      <TextInput
                        value={value}
                        onChangeText={(v) =>
                          set(v.replace(/[^0-9.]/g, ""))
                        }
                        placeholder="–"
                        placeholderTextColor="#aaa"
                        keyboardType="numeric"
                        returnKeyType="next"
                        style={ms.fieldInput}
                      />
                    </View>
                  ))}
                </View>

                {lengthStr && widthStr && heightStr ? (
                  <Text style={ms.dimPreview}>
                    {[
                      `${lengthStr} × ${widthStr} × ${heightStr} mm`,
                      diameterStr ? `⌀ ${diameterStr} mm` : null,
                    ]
                      .filter(Boolean)
                      .join("   ")}
                  </Text>
                ) : null}

                <View style={ms.btnRow}>
                  <Pressable
                    onPress={() => setPhase("preview")}
                    style={ms.rescanBtn}
                  >
                    <Text style={ms.rescanBtnText}>Re-scan</Text>
                  </Pressable>
                  <Pressable onPress={handleConfirm} style={ms.confirmBtn}>
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
  root: { flex: 1, backgroundColor: "#000" },
  cameraBg: { backgroundColor: "#111" },
  dimOverlay: { backgroundColor: "rgba(0,0,0,0.45)" },
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
  rescanBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#444" },
  confirmBtn: {
    flex: 2,
    backgroundColor: "#3b82f6",
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: "center",
  },
  confirmBtnText: { fontSize: 15, fontFamily: "Inter_700Bold", color: "#fff" },
});
