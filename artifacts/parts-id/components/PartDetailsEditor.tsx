import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Modal,
} from "react-native";
import type { InventoryItem } from "@workspace/api-client-react";
import { useUpdateItemBins, useUpdateItemKeywords } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { getListInventoryQueryKey } from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : "http://localhost:8080/api";

interface PartDetailsEditorProps {
  item: InventoryItem | null;
  adminToken: string | null;
  onClose: () => void;
}

/**
 * Combined full-part editor opened after a successful quick-add.
 * Lets admins fill in description, bin locations, and keywords in one place
 * without navigating to the Upload tab.
 */
export function PartDetailsEditor({ item, adminToken, onClose }: PartDetailsEditorProps) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const updateBinsMutation = useUpdateItemBins();
  const updateKeywordsMutation = useUpdateItemKeywords();

  const [description, setDescription] = useState(item?.description ?? "");
  const [bins, setBins] = useState<string[]>(item?.binLocations ?? []);
  const [newBin, setNewBin] = useState("");
  const [keywords, setKeywords] = useState<string[]>(item?.aiKeywords ?? []);
  const [newKeyword, setNewKeyword] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [fieldSaveErrors, setFieldSaveErrors] = useState<{
    description?: string;
    bins?: string;
    keywords?: string;
  }>({});

  const itemRef = useRef(item);
  useEffect(() => { itemRef.current = item; }, [item]);

  useEffect(() => {
    if (!item) return;
    setDescription(item.description ?? "");
    setBins(item.binLocations ?? []);
    setKeywords(item.aiKeywords ?? []);
    setNewBin("");
    setNewKeyword("");
    setSaveStatus("idle");
    setErrorMsg(null);
    setFieldSaveErrors({});
  }, [item?.id]);

  const addBin = () => {
    const trimmed = newBin.trim();
    if (!trimmed) { setNewBin(""); return; }
    if (bins.some((b) => b.toLowerCase() === trimmed.toLowerCase())) { setNewBin(""); return; }
    setBins([...bins, trimmed]);
    setNewBin("");
  };

  const removeBin = (bin: string) => setBins(bins.filter((b) => b !== bin));

  const addKeyword = () => {
    const trimmed = newKeyword.trim().toLowerCase();
    if (!trimmed || keywords.includes(trimmed)) { setNewKeyword(""); return; }
    setKeywords([...keywords, trimmed]);
    setNewKeyword("");
  };

  const removeKeyword = (kw: string) => setKeywords(keywords.filter((k) => k !== kw));

  const handleSave = async () => {
    const current = itemRef.current;
    if (!current || !adminToken) return;
    setSaveStatus("saving");
    setErrorMsg(null);
    setFieldSaveErrors({});

    type SaveOp = {
      field: "description" | "bins" | "keywords";
      promise: Promise<unknown>;
      restoreFn: () => void;
    };

    const ops: SaveOp[] = [];

    if (description.trim() !== (current.description ?? "").trim()) {
      ops.push({
        field: "description",
        restoreFn: () => setDescription(current.description ?? ""),
        promise: fetch(`${API_BASE}/inventory/${current.id}/description`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({ description: description.trim() }),
        }).then(async (res) => {
          if (!res.ok) {
            const data = await res.json().catch(() => ({})) as { error?: string };
            throw new Error(data.error ?? `HTTP ${res.status}`);
          }
        }),
      });
    }

    const binsChanged = JSON.stringify(bins) !== JSON.stringify(current.binLocations ?? []);
    if (binsChanged) {
      ops.push({
        field: "bins",
        restoreFn: () => setBins(current.binLocations ?? []),
        promise: updateBinsMutation.mutateAsync({ id: current.id, data: { binLocations: bins } }),
      });
    }

    const kwChanged = JSON.stringify(keywords) !== JSON.stringify(current.aiKeywords ?? []);
    if (kwChanged) {
      ops.push({
        field: "keywords",
        restoreFn: () => setKeywords(current.aiKeywords ?? []),
        promise: updateKeywordsMutation.mutateAsync({ id: current.id, data: { keywords } }),
      });
    }

    if (ops.length === 0) {
      setSaveStatus("idle");
      return;
    }

    const results = await Promise.allSettled(ops.map((o) => o.promise));
    const newFieldErrors: typeof fieldSaveErrors = {};
    let anyFailed = false;

    results.forEach((result, i) => {
      if (result.status === "rejected") {
        anyFailed = true;
        ops[i].restoreFn();
        const msg =
          result.reason instanceof Error ? result.reason.message : "Save failed";
        newFieldErrors[ops[i].field] = msg.includes("401")
          ? "Session expired — re-unlock admin access"
          : "Could not save — check connection";
      }
    });

    if (anyFailed) {
      setFieldSaveErrors(newFieldErrors);
      setSaveStatus("error");
    } else {
      const listKeyPrefix = getListInventoryQueryKey()[0];
      await queryClient.invalidateQueries({
        predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === listKeyPrefix,
      });
      await queryClient.invalidateQueries({ queryKey: ["searchInventory"] });
      setSaveStatus("saved");
      setTimeout(() => onClose(), 500);
    }
  };

  if (!item) return null;

  const isSaving = saveStatus === "saving";
  const isSaved = saveStatus === "saved";

  const hasChanges =
    description.trim() !== (item.description ?? "").trim() ||
    JSON.stringify(bins) !== JSON.stringify(item.binLocations ?? []) ||
    JSON.stringify(keywords) !== JSON.stringify(item.aiKeywords ?? []);

  const statusColor =
    isSaving ? colors.warning
    : isSaved ? colors.success
    : saveStatus === "error" ? colors.destructive
    : "transparent";

  const statusLabel =
    isSaving ? "Saving…"
    : isSaved ? "✓ Saved"
    : saveStatus === "error" ? "Save failed"
    : "";

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={[styles.container, { backgroundColor: colors.background }]}
      >
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={[styles.title, { color: colors.foreground }]}>Edit Part</Text>
              {saveStatus !== "idle" && (
                <View style={[styles.statusBadge, { backgroundColor: statusColor + "22" }]}>
                  {isSaving ? (
                    <ActivityIndicator size="small" color={statusColor} style={{ marginRight: 4 }} />
                  ) : null}
                  <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
                </View>
              )}
            </View>
            <Text style={[styles.sub, { color: colors.mutedForeground }]} numberOfLines={1}>
              {item.vendor} · {item.catalog}
            </Text>
          </View>
          <Pressable
            onPress={onClose}
            style={[styles.closeBtn, { backgroundColor: colors.muted }]}
          >
            <Text style={{ color: colors.foreground, fontSize: 14 }}>✕</Text>
          </Pressable>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={[styles.hint, { color: colors.mutedForeground }]}>
            Edit this part's description, bin locations, and searchable keywords.
          </Text>

          {/* Description */}
          <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>DESCRIPTION</Text>
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="Brief description of the part…"
            placeholderTextColor={colors.mutedForeground}
            multiline
            numberOfLines={3}
            style={[
              styles.descInput,
              { backgroundColor: colors.muted, borderColor: fieldSaveErrors.description ? colors.destructive : colors.border, color: colors.foreground },
            ]}
            autoCorrect
            autoCapitalize="sentences"
            returnKeyType="default"
          />
          {fieldSaveErrors.description ? (
            <Text style={[styles.fieldErrorText, { color: colors.destructive }]}>{fieldSaveErrors.description}</Text>
          ) : null}

          {/* Bin Locations */}
          <Text style={[styles.sectionLabel, { color: colors.mutedForeground, marginTop: 20 }]}>
            BIN LOCATIONS ({bins.length})
          </Text>
          <Text style={[styles.fieldHint, { color: colors.mutedForeground }]}>
            Tap a bin to remove it.
          </Text>
          <View style={styles.chipRow}>
            {bins.map((b) => (
              <Pressable
                key={b}
                onPress={() => removeBin(b)}
                style={[styles.chip, { backgroundColor: colors.accent, borderColor: colors.primary + "44" }]}
              >
                <Text style={[styles.chipText, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>{b}</Text>
                <Text style={[styles.chipRemove, { color: colors.mutedForeground }]}>✕</Text>
              </Pressable>
            ))}
          </View>
          {fieldSaveErrors.bins ? (
            <Text style={[styles.fieldErrorText, { color: colors.destructive }]}>{fieldSaveErrors.bins}</Text>
          ) : null}
          {bins.length === 0 && (
            <Text style={[styles.emptyHint, { color: colors.mutedForeground }]}>
              No additional bins. The initial bin was added on creation.
            </Text>
          )}
          <View style={[styles.addRow, { marginTop: 10 }]}>
            <TextInput
              value={newBin}
              onChangeText={setNewBin}
              placeholder="e.g. A1-04"
              placeholderTextColor={colors.mutedForeground}
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
              <Text
                style={[
                  styles.addBtnText,
                  { color: newBin.trim() ? colors.primaryForeground : colors.mutedForeground },
                ]}
              >
                + Add
              </Text>
            </Pressable>
          </View>

          {/* Keywords */}
          <Text style={[styles.sectionLabel, { color: colors.mutedForeground, marginTop: 24 }]}>
            KEYWORDS ({keywords.length})
          </Text>
          <Text style={[styles.fieldHint, { color: colors.mutedForeground }]}>
            Tap a keyword to remove it.
          </Text>
          <View style={styles.chipRow}>
            {keywords.map((kw) => (
              <Pressable
                key={kw}
                onPress={() => removeKeyword(kw)}
                style={[styles.chip, { backgroundColor: colors.accent, borderColor: colors.primary + "44" }]}
              >
                <Text style={[styles.chipText, { color: colors.foreground }]}>{kw}</Text>
                <Text style={[styles.chipRemove, { color: colors.mutedForeground }]}>✕</Text>
              </Pressable>
            ))}
          </View>
          {fieldSaveErrors.keywords ? (
            <Text style={[styles.fieldErrorText, { color: colors.destructive }]}>{fieldSaveErrors.keywords}</Text>
          ) : null}
          {keywords.length === 0 && (
            <Text style={[styles.emptyHint, { color: colors.mutedForeground }]}>
              No keywords yet. Add some below.
            </Text>
          )}
          <View style={[styles.addRow, { marginTop: 10 }]}>
            <TextInput
              value={newKeyword}
              onChangeText={setNewKeyword}
              placeholder="Type keyword and press Add…"
              placeholderTextColor={colors.mutedForeground}
              style={[
                styles.addInput,
                { flex: 1, backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground },
              ]}
              onSubmitEditing={addKeyword}
              returnKeyType="done"
              autoCorrect={false}
              autoCapitalize="none"
            />
            <Pressable
              onPress={addKeyword}
              style={[styles.addBtn, { backgroundColor: colors.primary }]}
            >
              <Text style={[styles.addBtnText, { color: colors.primaryForeground }]}>+ Add</Text>
            </Pressable>
          </View>

          {errorMsg ? (
            <View style={[styles.errorBanner, { backgroundColor: colors.destructive + "14", borderColor: colors.destructive + "55" }]}>
              <Text style={[styles.errorText, { color: colors.destructive }]}>{errorMsg}</Text>
            </View>
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
            disabled={isSaving || (!hasChanges && saveStatus !== "error")}
            style={[
              styles.saveBtn,
              { backgroundColor: isSaving || (!hasChanges && saveStatus !== "error") ? colors.muted : colors.primary },
            ]}
          >
            {isSaving ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text
                style={[
                  styles.saveBtnText,
                  { color: isSaving || (!hasChanges && saveStatus !== "error") ? colors.mutedForeground : colors.primaryForeground },
                ]}
              >
                Save Details
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
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    gap: 3,
  },
  statusText: { fontSize: 12, fontFamily: "Inter_500Medium" },
  scrollContent: { padding: 16, gap: 0, paddingBottom: 32 },
  hint: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
    lineHeight: 18,
    marginBottom: 20,
  },
  sectionLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  fieldHint: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
    marginBottom: 10,
    lineHeight: 16,
  },
  descInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    minHeight: 80,
    textAlignVertical: "top",
    lineHeight: 20,
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
  chipText: { fontSize: 13, fontFamily: "Inter_400Regular" },
  chipRemove: { fontSize: 11 },
  emptyHint: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
  },
  fieldErrorText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    marginTop: 4,
  },
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
  errorBanner: {
    marginTop: 16,
    borderRadius: 8,
    borderWidth: 1,
    padding: 12,
  },
  errorText: { fontSize: 13, fontFamily: "Inter_500Medium", lineHeight: 18 },
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
