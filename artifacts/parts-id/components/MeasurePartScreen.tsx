/**
 * Camera-based dimension estimation and manual dimension editor.
 *
 * Dimensions returned by the vision endpoint are millimetres.  Users may
 * review, correct, or replace them before confirming.
 */
import { Feather } from "@expo/vector-icons";
import type { InventoryItem } from "@workspace/api-client-react";
import { CameraView, useCameraPermissions } from "expo-camera";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { KeyboardDoneInput } from "@/components/KeyboardDoneInput";
import { type DimensionUnit, useApp } from "@/contexts/AppContext";
import { API_BASE } from "@/utils/apiBase";
import { getDeviceId } from "@/utils/deviceId";

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

export function fmtForUnit(v: number | null | undefined, unit: DimensionUnit): string {
  if (v == null) return "";
  if (unit === "cm") return (Math.round((v / 10) * 10) / 10).toFixed(1);
  if (unit === "in") return (v / 25.4).toFixed(2);
  return String(Math.round(v));
}

export function parseFieldToMm(s: string, unit: DimensionUnit): number | null {
  const n = parseFloat(s);
  if (isNaN(n) || n < 0) return null;
  if (unit === "cm") return Math.round(n * 10 * 10) / 10;
  if (unit === "in") return Math.round(n * 25.4 * 10) / 10;
  return Math.round(n * 10) / 10;
}

const fields = ["length", "width", "height", "diameter"] as const;
type Field = (typeof fields)[number];

export function MeasurePartScreen({
  visible,
  onClose,
  onConfirm,
  initialDims,
  initialItem,
  adminToken,
}: MeasurePartScreenProps) {
  "use no memo";
  const { settings } = useApp();
  const unit = settings.dimensionUnit;
  const seedDims = initialDims ?? initialItem?.dimensions;
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<"preview" | "estimating" | "confirm">("preview");
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<Field, string>>({
    length: fmtForUnit(seedDims?.length, unit),
    width: fmtForUnit(seedDims?.width, unit),
    height: fmtForUnit(seedDims?.height, unit),
    diameter: fmtForUnit(seedDims?.diameter, unit),
  });
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!visible) return;
    setPhase("preview");
    setError(null);
    setValues({
      length: fmtForUnit(seedDims?.length, unit),
      width: fmtForUnit(seedDims?.width, unit),
      height: fmtForUnit(seedDims?.height, unit),
      diameter: fmtForUnit(seedDims?.diameter, unit),
    });
  }, [visible, seedDims, unit]);

  useEffect(() => {
    if (
      visible &&
      Platform.OS !== "web" &&
      permission &&
      !permission.granted &&
      permission.canAskAgain !== false
    ) {
      void requestPermission();
    }
  }, [permission, requestPermission, visible]);

  const setField = useCallback((field: Field, value: string) => {
    setValues(previous => ({ ...previous, [field]: value.replace(/[^0-9.]/g, "") }));
  }, []);

  const captureEstimate = useCallback(async () => {
    if (!cameraRef.current) return;
    setPhase("estimating");
    setError(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.4,
        skipProcessing: true,
      });
      if (!photo?.base64) throw new Error("Camera did not return image data");
      const endpoint = adminToken
        ? `${API_BASE}/inventory/estimate-dimensions`
        : `${API_BASE}/inventory/estimate-dimensions/search`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Device-ID": await getDeviceId(),
          ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
        },
        body: JSON.stringify({ imageBase64: photo.base64, mimeType: "image/jpeg" }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Server error ${response.status}`);
      }
      const dims = await response.json() as PartDimensions;
      if (!mountedRef.current) return;
      setValues({
        length: fmtForUnit(dims.length, unit),
        width: fmtForUnit(dims.width, unit),
        height: fmtForUnit(dims.height, unit),
        diameter: fmtForUnit(dims.diameter, unit),
      });
      setPhase("confirm");
    } catch (cause) {
      if (!mountedRef.current) return;
      const message = cause instanceof Error && cause.name === "AbortError"
        ? "Estimate timed out — try again or enter dimensions manually."
        : cause instanceof Error ? cause.message : "Estimation failed";
      setError(message);
      setPhase("preview");
      if (!(cause instanceof Error && cause.name === "AbortError")) {
        Alert.alert("Estimation failed", `${message}\n\nYou can enter dimensions manually.`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }, [adminToken, unit]);

  const confirm = useCallback(() => {
    onConfirm({
      length: parseFieldToMm(values.length, unit),
      width: parseFieldToMm(values.width, unit),
      height: parseFieldToMm(values.height, unit),
      diameter: parseFieldToMm(values.diameter, unit),
    });
  }, [onConfirm, unit, values]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.header}>
          <Text style={styles.title}>{phase === "confirm" ? "Review dimensions" : "Estimate dimensions"}</Text>
          <Pressable onPress={onClose} accessibilityLabel="Close">
            <Feather name="x" size={24} color="#fff" />
          </Pressable>
        </View>
        {phase !== "confirm" ? (
          <View style={styles.preview}>
            {permission?.granted ? (
              <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />
            ) : (
              <View style={styles.cameraPlaceholder}>
                <Feather name="camera" size={42} color="#9ca3af" />
                <Text style={styles.muted}>Camera permission is required for photo estimation.</Text>
              </View>
            )}
            {phase === "estimating" ? (
              <View style={styles.loading}>
                <ActivityIndicator color="#fff" size="large" />
                <Text style={styles.loadingText}>Estimating dimensions…</Text>
              </View>
            ) : null}
          </View>
        ) : null}
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {phase === "preview" ? (
            <>
              {!permission?.granted && Platform.OS !== "web" ? (
                permission?.canAskAgain === false ? (
                  <>
                    <Text style={styles.hint}>
                      Camera permission was permanently denied. Open Settings to enable photo estimation.
                    </Text>
                    <Pressable style={styles.secondaryButton} onPress={() => void Linking.openSettings()}>
                      <Text style={styles.buttonText}>Open Settings</Text>
                    </Pressable>
                  </>
                ) : (
                  <Pressable style={styles.secondaryButton} onPress={requestPermission}>
                    <Text style={styles.buttonText}>Enable Camera</Text>
                  </Pressable>
                )
              ) : (
                <Pressable style={styles.primaryButton} onPress={captureEstimate}>
                  <Feather name="camera" size={18} color="#fff" />
                  <Text style={styles.buttonText}>Capture & estimate</Text>
                </Pressable>
              )}
              <Text style={styles.hint}>You can also enter dimensions manually below.</Text>
            </>
          ) : null}
          {phase === "confirm" ? (
            <Text style={styles.hint}>Review the estimate, make corrections if needed, then confirm.</Text>
          ) : null}
          {fields.map(field => (
            <View key={field} style={styles.field}>
              <Text style={styles.label}>{field.charAt(0).toUpperCase() + field.slice(1)} ({unit})</Text>
              <KeyboardDoneInput
                value={values[field]}
                onChangeText={value => setField(field, value)}
                keyboardType="decimal-pad"
                placeholder="—"
                style={styles.input}
              />
            </View>
          ))}
          {phase === "preview" ? (
            <Pressable style={styles.secondaryButton} onPress={confirm}>
              <Text style={styles.secondaryText}>Confirm dimensions</Text>
            </Pressable>
          ) : null}
          {phase === "confirm" ? (
            <View style={styles.actions}>
              <Pressable style={styles.secondaryButton} onPress={() => setPhase("preview")}>
                <Text style={styles.secondaryText}>Estimate again</Text>
              </Pressable>
              <Pressable style={styles.primaryButton} onPress={confirm}>
                <Text style={styles.buttonText}>Confirm dimensions</Text>
              </Pressable>
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#111827" },
  header: { padding: 18, paddingTop: 56, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { color: "#fff", fontSize: 20, fontWeight: "700" },
  preview: { height: 260, marginHorizontal: 16, overflow: "hidden", borderRadius: 12, backgroundColor: "#1f2937" },
  cameraPlaceholder: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  loading: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", backgroundColor: "#0008", gap: 12 },
  loadingText: { color: "#fff", fontSize: 16 },
  content: { padding: 20, gap: 12 },
  hint: { color: "#d1d5db", fontSize: 14, lineHeight: 20 },
  muted: { color: "#9ca3af", textAlign: "center", paddingHorizontal: 24 },
  error: { color: "#fca5a5", fontSize: 14 },
  field: { gap: 5 },
  label: { color: "#d1d5db", fontSize: 12, textTransform: "capitalize" },
  input: { color: "#fff", backgroundColor: "#1f2937", borderColor: "#4b5563", borderWidth: 1, borderRadius: 8, padding: 12 },
  actions: { gap: 10, marginTop: 8 },
  primaryButton: { backgroundColor: "#2563eb", padding: 14, borderRadius: 9, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8 },
  secondaryButton: { borderColor: "#6b7280", borderWidth: 1, padding: 14, borderRadius: 9, alignItems: "center" },
  buttonText: { color: "#fff", fontWeight: "700" },
  secondaryText: { color: "#e5e7eb", fontWeight: "700" },
});