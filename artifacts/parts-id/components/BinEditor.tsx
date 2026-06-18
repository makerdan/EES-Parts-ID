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
  View,
} from "react-native";
import { KeyboardDoneInput } from "@/components/KeyboardDoneInput";
import { isBinLocationValid, BIN_FORMAT_HINT } from "@/utils/binValidation";
import type { InventoryItem } from "@workspace/api-client-react";
import { useUpdateItemBins } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { saveBinsAndInvalidate } from "@/utils/listEditorHandlers";
import { useColors } from "@/hooks/useColors";
import { DismissKeyboard } from "@/components/DismissKeyboard";

interface BinEditorProps {
  item: InventoryItem | null;
  onClose: () => void;
  /** Called after a save succeeds so callers can update local state. */
  onBinsChanged?: (id: number, binLocations: string[]) => void;
}

/**
 * Per-part bin editor (Task #454). Lets warehouse admins add/remove bins on a
 * single inventory row without re-uploading the spreadsheet. Save is explicit
 * (Save button) — bins are operational data and we don't want partial drafts.
 */
export function BinEditor({ item, onClose, onBinsChanged }: BinEditorProps) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const [bins, setBins] = useState<string[]>(item?.binLocations ?? []);
  const [newBin, setNewBin] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const updateMutation = useUpdateItemBins();
  const itemRef = useRef(item);
  useEffect(() => { itemRef.current = item; }, [item]);

  // Reset state whenever a different item is opened
  useEffect(() => {
    setBins(itemRef.current?.binLocations ?? []);
    setNewBin("");
    setSaveStatus("idle");
    setErrorMsg(null);
  }, [item?.id]);

  const addBin = useCallback(() => {
    const trimmed = newBin.trim();
    if (!trimmed) {
      setNewBin("");
      return;
    }
    // Case-insensitive de-dup; preserve user-typed casing of the first occurrence
    if (bins.some((b) => b.toLowerCase() === trimmed.toLowerCase())) {
      setNewBin("");
      return;
    }
    setBins([...bins, trimmed]);
    setNewBin("");
    setSaveStatus("idle");
  }, [bins, newBin]);

  const removeBin = useCallback((bin: string) => {
    setBins(bins.filter((b) => b !== bin));
    setSaveStatus("idle");
  }, [bins]);

  const handleSave = useCallback(async () => {
    const current = itemRef.current;
    if (!current) return;
    setSaveStatus("saving");
    setErrorMsg(null);
    try {
      const updated = await saveBinsAndInvalidate({
        queryClient,
        mutateAsync: updateMutation.mutateAsync,
        itemId: current.id,
        bins,
      });
      onBinsChanged?.(current.id, updated.binLocations);
      setSaveStatus("saved");
      setTimeout(() => onClose(), 400);
    } catch (err) {
      const msg =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : "Save failed";
      // 401 = admin session expired; surface a useful hint.
      setErrorMsg(msg.includes("401") ? "Admin session expired. Re-unlock and try again." : "Could not save bins. Check connection and try again.");
      setSaveStatus("error");
    }
  }, [bins, updateMutation, queryClient, onBinsChanged, onClose]);

  if (!item) return null;

  const hasChanges =
    JSON.stringify(bins) !== JSON.stringify(item.binLocations ?? []);
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
        <DismissKeyboard>
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={[styles.title, { color: colors.foreground }]}>Edit Bins</Text>
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
          <Pressable onPress={onClose} style={[styles.closeBtn, { backgroundColor: colors.muted }]} accessibilityLabel="Close bin editor" accessibilityRole="button">
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
            Tap a bin to remove it. Tap Save when you're done.
          </Text>

          <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
            BINS ({bins.length})
          </Text>
          <View style={styles.binRow}>
            {bins.map((b) => (
              <Pressable
                key={b}
                onPress={() => removeBin(b)}
                style={[styles.binChip, { backgroundColor: colors.accent, borderColor: colors.primary + "44" }]}
              >
                <Text style={[styles.binText, { color: colors.foreground }]}>{b}</Text>
                <Text style={[styles.binRemove, { color: colors.mutedForeground }]}>✕</Text>
              </Pressable>
            ))}
          </View>

          {bins.length === 0 ? (
            <Text style={[styles.emptyHint, { color: colors.mutedForeground }]}>
              No bins yet. Add one below — or save with no bins to clear this part.
            </Text>
          ) : null}

          <Text style={[styles.sectionLabel, { color: colors.mutedForeground, marginTop: 20 }]}>
            ADD BIN
          </Text>
          <View style={styles.addRow}>
            <KeyboardDoneInput
              value={newBin}
              onChangeText={setNewBin}
              placeholder="e.g. A1-04"
              placeholderTextColor={colors.mutedForeground}
              maxLength={30}
              style={[
                styles.addInput,
                { flex: 1, backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground },
              ]}
              onSubmitEditing={addBin}
              returnKeyType="done"
              autoCorrect={false}
              autoCapitalize="characters"
            />
            <Pressable
              onPress={addBin}
              disabled={!newBin.trim()}
              style={[
                styles.addBtn,
                { backgroundColor: newBin.trim() ? colors.primary : colors.muted },
              ]}
            >
              <Text style={[styles.addBtnText, { color: newBin.trim() ? colors.primaryForeground : colors.mutedForeground }]}>
                + Add
              </Text>
            </Pressable>
          </View>

          {newBin.trim() && !isBinLocationValid(newBin) ? (
            <Text style={[styles.binFormatHint, { color: colors.warning }]}>
              ⚠ {BIN_FORMAT_HINT}
            </Text>
          ) : null}

          {errorMsg ? (
            <Text style={[styles.errorText, { color: colors.destructive }]}>{errorMsg}</Text>
          ) : null}
        </ScrollView>

        {/* Footer — explicit Save / Cancel */}
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
        </DismissKeyboard>
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
  binRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  binChip: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    gap: 6,
  },
  binText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  binRemove: { fontSize: 11 },
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
  binFormatHint: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 5, marginBottom: 2 },
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
