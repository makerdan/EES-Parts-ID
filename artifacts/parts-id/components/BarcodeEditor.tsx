import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { InventoryItem } from "@workspace/api-client-react";
import { useUpdateItemBarcodes } from "@workspace/api-client-react";
import { getListInventoryQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useColors } from "@/hooks/useColors";

interface BarcodeEditorProps {
  item: InventoryItem | null;
  onClose: () => void;
  onBarcodesChanged?: (id: number, barcodes: string[]) => void;
}

export function BarcodeEditor({ item, onClose, onBarcodesChanged }: BarcodeEditorProps) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const [barcodes, setBarcodes] = useState<string[]>(item?.barcodes ?? []);
  const [newBarcode, setNewBarcode] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const updateMutation = useUpdateItemBarcodes();
  const itemRef = useRef(item);
  useEffect(() => { itemRef.current = item; }, [item]);

  useEffect(() => {
    setBarcodes(item?.barcodes ?? []);
    setNewBarcode("");
    setSaveStatus("idle");
    setErrorMsg(null);
  }, [item?.id]);

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
    try {
      const updated = await updateMutation.mutateAsync({
        id: current.id,
        data: { barcodes },
      });
      onBarcodesChanged?.(current.id, updated.barcodes);
      const listKeyPrefix = getListInventoryQueryKey()[0];
      await queryClient.invalidateQueries({
        predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === listKeyPrefix,
      });
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
  }, [barcodes, updateMutation, queryClient, onBarcodesChanged, onClose]);

  if (!item) return null;

  const hasChanges =
    JSON.stringify(barcodes) !== JSON.stringify(item.barcodes ?? []);
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
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
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
          <Pressable onPress={onClose} style={[styles.closeBtn, { backgroundColor: colors.muted }]}>
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
            <TextInput
              value={newBarcode}
              onChangeText={setNewBarcode}
              placeholder="Type or paste barcode…"
              placeholderTextColor={colors.mutedForeground}
              style={[
                styles.addInput,
                { flex: 1, backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground },
              ]}
              onSubmitEditing={addBarcode}
              returnKeyType="done"
              autoCorrect={false}
              autoCapitalize="none"
            />
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
            onPress={onClose}
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
  );
}

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
});
