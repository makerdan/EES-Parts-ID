/**
 * RecordEditModal
 *
 * Bottom-sheet modal that lets an admin edit any editable field on an
 * inventory record:
 *   • description (free text)
 *   • binLocations (comma-separated string → string[])
 *   • aiKeywords (tag list — add/remove chips)
 *   • tradeSize (free text, nullable)
 *
 * Vendor and catalog are shown read-only for context.
 * Saves via PATCH /api/inventory/{id}.  On success the caller receives the
 * updated item so it can do an optimistic in-place list update.
 */
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useColors } from "@/hooks/useColors";
import type { InventoryItem } from "@workspace/api-client-react";

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : "";

interface Props {
  item: InventoryItem | null;
  adminHeaders: Record<string, string>;
  onClose: () => void;
  onSaved: (updated: InventoryItem) => void;
}

export function RecordEditModal({ item, adminHeaders, onClose, onSaved }: Props) {
  const colors = useColors();

  const [description, setDescription] = useState("");
  const [binText, setBinText] = useState("");
  const [keywords, setKeywords] = useState<string[]>([]);
  const [newKeyword, setNewKeyword] = useState("");
  const [tradeSize, setTradeSize] = useState("");

  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  useEffect(() => {
    if (!item) return;
    setDescription(item.description ?? "");
    setBinText((item.binLocations ?? []).join(", "));
    setKeywords([...(item.aiKeywords ?? [])]);
    setTradeSize(item.tradeSize ?? "");
    setToast(null);
    setNewKeyword("");
  }, [item]);

  const addKeyword = () => {
    const kw = newKeyword.trim();
    if (!kw || keywords.includes(kw)) { setNewKeyword(""); return; }
    setKeywords(prev => [...prev, kw]);
    setNewKeyword("");
  };

  const removeKeyword = (kw: string) => {
    setKeywords(prev => prev.filter(k => k !== kw));
  };

  const handleSave = async () => {
    if (!item) return;
    setSaving(true);
    setToast(null);
    try {
      const binLocations = binText
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);

      const body: Record<string, unknown> = {
        description,
        keywords,
        binLocations,
        tradeSize: tradeSize.trim() || null,
      };

      const res = await fetch(`${API_BASE}/inventory/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...adminHeaders },
        body: JSON.stringify(body),
      });

      if (res.status === 401) {
        setToast({ msg: "Admin session expired — please unlock again.", ok: false });
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setToast({ msg: data.error ?? "Save failed — please try again.", ok: false });
        return;
      }

      const updated = await res.json() as InventoryItem;
      setToast({ msg: "Saved successfully.", ok: true });
      onSaved(updated);
      setTimeout(() => {
        setToast(null);
        onClose();
      }, 900);
    } catch (err) {
      setToast({
        msg: err instanceof Error ? err.message : "Network error — please try again.",
        ok: false,
      });
    } finally {
      setSaving(false);
    }
  };

  if (!item) return null;

  return (
    <Modal
      visible={item !== null}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={s.overlay} onPress={onClose}>
        <Pressable style={[s.sheet, { backgroundColor: colors.card, borderColor: colors.border }]} onPress={() => {}}>
          {/* Header */}
          <View style={[s.header, { borderBottomColor: colors.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={[s.headerTitle, { color: colors.foreground }]} numberOfLines={1}>
                {item.catalog}
              </Text>
              <Text style={[s.headerSub, { color: colors.mutedForeground }]} numberOfLines={1}>
                {item.vendorFullName ?? item.vendor}
                {item.vendorFullName && item.vendorFullName !== item.vendor ? ` (${item.vendor})` : ""}
              </Text>
            </View>
            <Pressable
              onPress={onClose}
              style={[s.closeBtn, { borderColor: colors.border }]}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Text style={[s.closeBtnText, { color: colors.foreground }]}>✕</Text>
            </Pressable>
          </View>

          <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={s.body}>
            {/* Toast */}
            {toast ? (
              <View style={[s.toast, { backgroundColor: toast.ok ? colors.success + "22" : "#ef444422", borderColor: toast.ok ? colors.success : "#ef4444" }]}>
                <Text style={[s.toastText, { color: toast.ok ? colors.success : "#ef4444" }]}>{toast.msg}</Text>
              </View>
            ) : null}

            {/* Description */}
            <Text style={[s.label, { color: colors.mutedForeground }]}>DESCRIPTION</Text>
            <TextInput
              value={description}
              onChangeText={setDescription}
              multiline
              numberOfLines={3}
              placeholder="Enter description…"
              placeholderTextColor={colors.mutedForeground}
              style={[s.textArea, { backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground }]}
              autoCorrect={false}
            />

            {/* Bin Locations */}
            <Text style={[s.label, { color: colors.mutedForeground }]}>BIN LOCATIONS</Text>
            <Text style={[s.fieldHint, { color: colors.mutedForeground }]}>Comma-separated (e.g. A1, B3, C12)</Text>
            <TextInput
              value={binText}
              onChangeText={setBinText}
              placeholder="e.g. A1, B3, C12"
              placeholderTextColor={colors.mutedForeground}
              style={[s.input, { backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground }]}
              autoCapitalize="characters"
              autoCorrect={false}
            />

            {/* Trade Size */}
            <Text style={[s.label, { color: colors.mutedForeground }]}>TRADE SIZE</Text>
            <TextInput
              value={tradeSize}
              onChangeText={setTradeSize}
              placeholder={`e.g. 1/2", 3/4" — leave blank to clear`}
              placeholderTextColor={colors.mutedForeground}
              style={[s.input, { backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground }]}
              autoCorrect={false}
            />

            {/* AI Keywords */}
            <Text style={[s.label, { color: colors.mutedForeground }]}>AI KEYWORDS</Text>
            <View style={s.tagRow}>
              {keywords.map(kw => (
                <Pressable
                  key={kw}
                  onPress={() => removeKeyword(kw)}
                  style={[s.tag, { backgroundColor: colors.primary + "1a", borderColor: colors.primary + "44" }]}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove keyword ${kw}`}
                >
                  <Text style={[s.tagText, { color: colors.primary }]}>{kw}</Text>
                  <Text style={[s.tagRemove, { color: colors.primary }]}>×</Text>
                </Pressable>
              ))}
            </View>
            <View style={s.kwInputRow}>
              <TextInput
                value={newKeyword}
                onChangeText={setNewKeyword}
                placeholder="Add keyword…"
                placeholderTextColor={colors.mutedForeground}
                style={[s.kwInput, { backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground }]}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="done"
                onSubmitEditing={addKeyword}
                blurOnSubmit={false}
              />
              <Pressable
                onPress={addKeyword}
                style={[s.kwAddBtn, { backgroundColor: colors.primary }]}
                accessibilityRole="button"
                accessibilityLabel="Add keyword"
              >
                <Text style={[s.kwAddBtnText, { color: colors.primaryForeground }]}>Add</Text>
              </Pressable>
            </View>
          </ScrollView>

          {/* Footer */}
          <View style={[s.footer, { borderTopColor: colors.border }]}>
            <Pressable
              onPress={onClose}
              style={[s.cancelBtn, { borderColor: colors.border }]}
            >
              <Text style={[s.cancelBtnText, { color: colors.foreground }]}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => { void handleSave(); }}
              disabled={saving}
              style={[s.saveBtn, { backgroundColor: saving ? colors.muted : colors.primary }]}
            >
              {saving ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : (
                <Text style={[s.saveBtnText, { color: colors.primaryForeground }]}>Save Changes</Text>
              )}
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  sheet: {
    maxHeight: "90%",
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    gap: 10,
  },
  headerTitle: { fontSize: 16, fontFamily: "Inter_700Bold" },
  headerSub: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 1 },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  closeBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  body: { padding: 16, gap: 4, paddingBottom: 8 },
  toast: {
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 10,
  },
  toastText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  label: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.6,
    marginTop: 12,
    marginBottom: 4,
  },
  fieldHint: { fontSize: 11, fontFamily: "Inter_400Regular", marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  textArea: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    minHeight: 72,
    textAlignVertical: "top",
  },
  tagRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 6 },
  tag: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
    gap: 4,
  },
  tagText: { fontSize: 12, fontFamily: "Inter_500Medium" },
  tagRemove: { fontSize: 14, fontFamily: "Inter_700Bold", marginTop: -1 },
  kwInputRow: { flexDirection: "row", gap: 8, alignItems: "center" },
  kwInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  kwAddBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center",
  },
  kwAddBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  footer: {
    flexDirection: "row",
    gap: 10,
    padding: 12,
    borderTopWidth: 1,
  },
  cancelBtn: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 13,
    alignItems: "center",
    borderWidth: 1,
  },
  cancelBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  saveBtn: {
    flex: 2,
    borderRadius: 8,
    paddingVertical: 13,
    alignItems: "center",
  },
  saveBtnText: { fontSize: 14, fontFamily: "Inter_700Bold" },
});
