import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import type { InventoryItem } from "@workspace/api-client-react";
import { useUpdateItemBarcodes } from "@workspace/api-client-react";
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
import { useColors } from "@/hooks/useColors";
import { saveBarcodesAndInvalidate } from "@/utils/listEditorHandlers";

interface BarcodeEditorProps {
  item: InventoryItem | null;
  onClose: () => void;
  onBarcodesChanged?: (id: number, barcodes: Array<string>) => void;
}

export function BarcodeEditor({ item, onClose, onBarcodesChanged }: BarcodeEditorProps) {
  "use no memo";
  const colors = useColors();
  const queryClient = useQueryClient();
  const [barcodes, setBarcodes] = useState<Array<string>>(item?.barcodes ?? []);
  const [newBarcode, setNewBarcode] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);

  const [permission, requestPermission] = useCameraPermissions();
  const scannerLockRef = useRef(false);
  const updateMutation = useUpdateItemBarcodes();
  const itemRef = useRef(item);
  useEffect(() => { itemRef.current = item; }, [item]);

  useEffect(() => {
    setBarcodes(itemRef.current?.barcodes ?? []);
    setNewBarcode("");
    setSaveStatus("idle");
    setErrorMsg(null);
  }, [item?.id]);

  const openScanner = useCallback(async () => {
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        // Permission was denied — offer to open system settings (F-035)
        Alert.alert(
          "Camera Access Required",
          "Barcode scanning needs camera access. Open Settings to allow it.",
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Open Settings",
              onPress: () => { void Linking.openSettings(); },
            },
          ],
        );
        return;
      }
    }
    scannerLockRef.current = false;
    setScannerOpen(true);
  }, [permission, requestPermission]);

  const handleBarcodeScanned = useCallback(({ data }: { data: string }) => {
    if (scannerLockRef.current) return;
    scannerLockRef.current = true;
    setScannerOpen(false);
    const trimmed = data.trim();
    if (trimmed) {
      setBarcodes(prev => prev.includes(trimmed) ? prev : [...prev, trimmed]);
      setSaveStatus("idle");
    }
  }, []);

  const addBarcode = useCallback(() => {
    const trimmed = newBarcode.trim();
    if (!trimmed) {
      setNewBarcode("");
      return;
    }
    if (barcodes.includes(trimmed)) {
      setNewBarcode("");
      return;
    }
    setBarcodes([...barcodes, trimmed]);
    setNewBarcode("");
    setSaveStatus("idle");
  }, [barcodes, newBarcode]);

  const removeBarcode = useCallback((barcode: string) => {
    setBarcodes(barcodes.filter((b) => b !== barcode));
    setSaveStatus("idle");
  }, [barcodes]);

  const handleSave = useCallback(async () => {
    const current = itemRef.current;
    if (!current) return;
    setSaveStatus("saving");
    setErrorMsg(null);

    // Auto-add any pending barcode text before saving
    const pendingBarcode = newBarcode.trim();
    const finalBarcodes =
      pendingBarcode && !barcodes.includes(pendingBarcode)
        ? [...barcodes, pendingBarcode]
        : barcodes;
    if (finalBarcodes !== barcodes) {
      setBarcodes(finalBarcodes);
      setNewBarcode("");
    }

    try {
      const updated = await saveBarcodesAndInvalidate({
        queryClient,
        mutateAsync: updateMutation.mutateAsync,
        itemId: current.id,
        barcodes: finalBarcodes,
      });
      onBarcodesChanged?.(current.id, updated.barcodes);
      setSaveStatus("saved");
      setTimeout(() => onClose(), 400);
    } catch (err) {
      const msg =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : "Save failed";
      setErrorMsg(msg.includes("401") ? "Admin session expired. Re-unlock and try again." : "Could not save barcodes. Check connection and try again.");
      setSaveStatus("error");
    }
  }, [barcodes, newBarcode, updateMutation, queryClient, onBarcodesChanged, onClose]);

  // Intercept close/cancel while there are unsaved edits (F-053).
  // A non-empty newBarcode text field counts as a dirty edit because Save
  // auto-adds it — closing without saving would silently drop the typed value.
  const handleCloseRequest = useCallback(() => {
    const savedBarcodes = itemRef.current?.barcodes ?? [];
    const dirty =
      JSON.stringify(barcodes) !== JSON.stringify(savedBarcodes) ||
      newBarcode.trim() !== "";
    if (!dirty) {
      onClose();
      return;
    }
    Alert.alert(
      "Discard changes?",
      "You have unsaved barcode edits. Do you want to discard them?",
      [
        { text: "Keep editing", style: "cancel" },
        { text: "Discard", style: "destructive", onPress: onClose },
      ],
    );
  }, [barcodes, newBarcode, onClose]);

  if (!item) return null;

  // A non-empty newBarcode field is also an unsaved change: handleSave
  // auto-adds it, so both the dirty guard and the Save-enabled state must
  // account for it (F-053).
  const hasChanges =
    JSON.stringify(barcodes) !== JSON.stringify(item.barcodes ?? []) ||
    newBarcode.trim() !== "";
  const isSaving = saveStatus === "saving";

  const statusColor =
    saveStatus === "saving" ? colors.warning
    : saveStatus === "saved" ? colors.success
    : saveStatus === "error" ? colors.destructive
    : "transparent";
  const statusLabel =
    saveStatus === "saving" ? "Saving…"
    : saveStatus === "saved" ? "✓ Saved"
    : saveStatus === "error" ? "Save failed"
    : "";

  return (
    <>
      <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={handleCloseRequest}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={[styles.container, { backgroundColor: colors.background }]}
        >
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={[styles.title, { color: colors.foreground }]}>Edit Barcodes</Text>
                {saveStatus !== "idle" ? (
                  <View style={[styles.statusBadge, { backgroundColor: statusColor + "22" }]}>
                    {isSaving ? (
                      <ActivityIndicator size="small" color={statusColor} style={{ marginRight: 4 }} />
                    ) : null}
                    <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
                  </View>
                ) : null}
              </View>
              <Text style={[styles.sub, { color: colors.mutedForeground }]} numberOfLines={1}>
                {item.vendor} · {item.catalog}
              </Text>
            </View>
            <Pressable onPress={handleCloseRequest} style={[styles.closeBtn, { backgroundColor: colors.muted }]} accessibilityLabel="Close barcode editor" accessibilityRole="button">
              <Text style={{ color: colors.foreground, fontSize: 14 }}>✕</Text>
            </Pressable>
          </View>

          <ScrollView style={{ flex: 1, padding: 16 }} keyboardShouldPersistTaps="handled">
            {item.description ? (
              <Text style={[styles.desc, { color: colors.mutedForeground }]} numberOfLines={2}>
                {item.description}
              </Text>
            ) : null}

            <Text style={[styles.hint, { color: colors.mutedForeground }]}>
              Tap a barcode to remove it. Tap Save when you're done.
            </Text>

            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
              BARCODES ({barcodes.length})
            </Text>
            <View style={styles.chipRow}>
              {barcodes.map((b) => (
                <Pressable
                  key={b}
                  onPress={() => removeBarcode(b)}
                  style={[styles.chip, { backgroundColor: colors.accent, borderColor: colors.primary + "44" }]}
                >
                  <Text style={[styles.chipText, { color: colors.foreground }]}>{b}</Text>
                  <Text style={[styles.chipRemove, { color: colors.mutedForeground }]}>✕</Text>
                </Pressable>
              ))}
            </View>

            {barcodes.length === 0 ? (
              <Text style={[styles.emptyHint, { color: colors.mutedForeground }]}>
                No barcodes yet. Scan or type one below.
              </Text>
            ) : null}

            <Text style={[styles.sectionLabel, { color: colors.mutedForeground, marginTop: 20 }]}>
              ADD BARCODE
            </Text>
            <View style={styles.addRow}>
              <KeyboardDoneInput
                value={newBarcode}
                onChangeText={setNewBarcode}
                placeholder="Type barcode…"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="number-pad"
                style={[
                  styles.addInput,
                  { flex: 1, backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground },
                ]}
                onSubmitEditing={addBarcode}
                returnKeyType="done"
                autoCorrect={false}
                autoCapitalize="none"
              />
              {Platform.OS !== "web" ? (
                <Pressable
                  onPress={openScanner}
                  style={[styles.scanBtn, { backgroundColor: colors.muted, borderColor: colors.border }]}
                  accessibilityLabel="Scan barcode with camera"
                  accessibilityRole="button"
                >
                  <Feather name="camera" size={18} color={colors.foreground} />
                </Pressable>
              ) : null}
              <Pressable
                onPress={addBarcode}
                disabled={!newBarcode.trim()}
                style={[
                  styles.addBtn,
                  { backgroundColor: newBarcode.trim() ? colors.primary : colors.muted },
                ]}
              >
                <Text style={[styles.addBtnText, { color: newBarcode.trim() ? colors.primaryForeground : colors.mutedForeground }]}>
                  + Add
                </Text>
              </Pressable>
            </View>

            {errorMsg ? (
              <Text style={[styles.errorText, { color: colors.destructive }]}>{errorMsg}</Text>
            ) : null}
          </ScrollView>

          <View style={[styles.footer, { borderTopColor: colors.border }]}>
            <Pressable
              onPress={handleCloseRequest}
              style={[styles.cancelBtn, { borderColor: colors.border }]}
            >
              <Text style={[styles.cancelBtnText, { color: colors.foreground }]}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={handleSave}
              disabled={isSaving || !hasChanges}
              style={[
                styles.saveBtn,
                { backgroundColor: isSaving || !hasChanges ? colors.muted : colors.primary },
              ]}
            >
              {isSaving ? (
                <ActivityIndicator color={colors.primaryForeground} />
              ) : (
                <Text
                  style={[
                    styles.saveBtnText,
                    { color: isSaving || !hasChanges ? colors.mutedForeground : colors.primaryForeground },
                  ]}
                >
                  Save
                </Text>
              )}
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Barcode scanner modal — native only, rendered outside the pageSheet */}
      {Platform.OS !== "web" ? (
        <Modal
          visible={scannerOpen}
          animationType="slide"
          onRequestClose={() => setScannerOpen(false)}
        >
          <View style={styles.scanModal}>
            <CameraView
              style={StyleSheet.absoluteFill}
              onBarcodeScanned={handleBarcodeScanned}
              barcodeScannerSettings={{
                barcodeTypes: ["ean13", "ean8", "code128", "code39", "upc_a", "upc_e", "qr"],
              }}
            />
            <View style={styles.scanOverlay}>
              <View style={[styles.scanHeader, { backgroundColor: "rgba(0,0,0,0.45)" }]}>
                <Pressable onPress={() => setScannerOpen(false)} style={styles.scanCloseBtn} accessibilityLabel="Close barcode scanner" accessibilityRole="button">
                  <Feather name="x" size={20} color="#fff" />
                </Pressable>
                <Text style={styles.scanTitle}>Scan Barcode</Text>
                <View style={{ width: 40 }} />
              </View>
              <View style={styles.viewfinderWrapper}>
                <View style={styles.viewfinder}>
                  <View style={[styles.vfCorner, styles.vfTL]} />
                  <View style={[styles.vfCorner, styles.vfTR]} />
                  <View style={[styles.vfCorner, styles.vfBL]} />
                  <View style={[styles.vfCorner, styles.vfBR]} />
                </View>
              </View>
              <Text style={styles.scanHint}>Point at a barcode to add it automatically</Text>
            </View>
          </View>
        </Modal>
      ) : null}
    </>
  );
}

const CORNER = 20;
const CORNER_W = 3;

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    paddingTop: 20,
    borderBottomWidth: 1,
    gap: 8,
  },
  title: { fontSize: 18, fontFamily: "Inter_700Bold" },
  sub: { fontSize: 13, fontFamily: "Inter_400Regular", marginTop: 2 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    gap: 3,
  },
  statusText: { fontSize: 12, fontFamily: "Inter_500Medium" },
  desc: { fontSize: 13, fontFamily: "Inter_400Regular", marginBottom: 10, lineHeight: 19 },
  hint: { fontSize: 12, fontFamily: "Inter_400Regular", fontStyle: "italic", marginBottom: 16, lineHeight: 18 },
  sectionLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 10,
  },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    gap: 6,
  },
  chipText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  chipRemove: { fontSize: 11 },
  emptyHint: { fontSize: 13, fontFamily: "Inter_400Regular", fontStyle: "italic" },
  addRow: { flexDirection: "row", gap: 8 },
  addInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  scanBtn: {
    width: 44,
    borderWidth: 1,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  addBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    justifyContent: "center",
  },
  addBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  errorText: { fontSize: 13, fontFamily: "Inter_500Medium", marginTop: 12 },
  footer: {
    flexDirection: "row",
    padding: 16,
    borderTopWidth: 1,
    gap: 10,
  },
  cancelBtn: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
  },
  cancelBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  saveBtn: {
    flex: 2,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
  },
  saveBtnText: { fontSize: 15, fontFamily: "Inter_700Bold" },
  // Scanner modal
  scanModal: { flex: 1, backgroundColor: "#000" },
  scanOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "space-between",
    paddingBottom: 48,
  },
  scanHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 56,
    paddingBottom: 16,
  },
  scanCloseBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  scanTitle: { color: "#fff", fontSize: 17, fontFamily: "Inter_600SemiBold" },
  viewfinderWrapper: { flex: 1, alignItems: "center", justifyContent: "center" },
  viewfinder: { width: 260, height: 160, position: "relative" },
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
  scanHint: {
    color: "rgba(255,255,255,0.75)",
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    paddingHorizontal: 32,
  },
});
