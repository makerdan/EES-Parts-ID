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
import { useUpdateItemKeywords } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useColors } from "@/hooks/useColors";

interface KeywordEditorProps {
  item: InventoryItem | null;
  onClose: () => void;
  /** Called after keywords are saved so parent can update local Fuse index */
  onKeywordsChanged?: (id: number, keywords: string[]) => void;
}

const DEBOUNCE_MS = 900;

export function KeywordEditor({ item, onClose, onKeywordsChanged }: KeywordEditorProps) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const [keywords, setKeywords] = useState<string[]>(item?.aiKeywords ?? []);
  const [newKeyword, setNewKeyword] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const updateMutation = useUpdateItemKeywords();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestKeywordsRef = useRef<string[]>(keywords);
  // The keywords that were last successfully persisted to the server
  const lastSavedKeywordsRef = useRef<string[]>(item?.aiKeywords ?? []);
  // Tracks whether a mutateAsync call is currently in flight to prevent concurrent saves
  const isSavingRef = useRef(false);
  // When a save is in flight at close-time, stash the latest keywords here so
  // the in-flight save's finally block can fire one follow-up flush.
  const postFlushRef = useRef<{ id: number; keywords: string[] } | null>(null);
  // Keep item in a ref so callbacks always see the latest value without stale closure issues
  const itemRef = useRef(item);
  useEffect(() => { itemRef.current = item; }, [item]);

  // Sync keywords when item changes (e.g. different item opened)
  useEffect(() => {
    const kws = item?.aiKeywords ?? [];
    setKeywords(kws);
    latestKeywordsRef.current = kws;
    lastSavedKeywordsRef.current = kws;
    setSaveStatus("idle");
  }, [item?.id]);

  // Auto-save with debounce whenever keywords change
  const triggerSave = useCallback(
    (kws: string[]) => {
      const current = itemRef.current;
      if (!current) return;
      latestKeywordsRef.current = kws;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      setSaveStatus("idle");
      debounceRef.current = setTimeout(async () => {
        debounceRef.current = null;
        if (isSavingRef.current) return; // skip if a mutation is already in flight
        isSavingRef.current = true;
        setSaveStatus("saving");
        try {
          await updateMutation.mutateAsync({ id: current.id, data: { keywords: kws } });
          lastSavedKeywordsRef.current = kws;
          onKeywordsChanged?.(current.id, kws);
          await queryClient.invalidateQueries({ queryKey: ["searchInventory"] });
          setSaveStatus("saved");
          setTimeout(() => setSaveStatus("idle"), 1800);
        } catch {
          setSaveStatus("error");
        } finally {
          isSavingRef.current = false;
          // Fire any post-close flush that was queued while this save was in flight
          const pending = postFlushRef.current;
          if (pending) {
            postFlushRef.current = null;
            updateMutation
              .mutateAsync({ id: pending.id, data: { keywords: pending.keywords } })
              .then(() => {
                lastSavedKeywordsRef.current = pending.keywords;
                onKeywordsChanged?.(pending.id, pending.keywords);
                queryClient.invalidateQueries({ queryKey: ["searchInventory"] });
              })
              .catch((err) => {
                console.warn("KeywordEditor: post-close flush failed:", err);
              });
          }
        }
      }, DEBOUNCE_MS);
    },
    [updateMutation, queryClient, onKeywordsChanged],
  );

  // Flush pending save on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleKeywordsChange = (next: string[]) => {
    setKeywords(next);
    triggerSave(next);
  };

  const addKeyword = () => {
    const trimmed = newKeyword.trim().toLowerCase();
    if (!trimmed || keywords.includes(trimmed)) {
      setNewKeyword("");
      return;
    }
    const next = [...keywords, trimmed];
    setNewKeyword("");
    handleKeywordsChange(next);
  };

  const removeKeyword = (kw: string) => {
    handleKeywordsChange(keywords.filter((k) => k !== kw));
  };

  const handleClose = () => {
    const current = itemRef.current;
    // Cancel any pending debounce timer
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    if (current) {
      const latestKws = latestKeywordsRef.current;
      const hasUnsaved =
        JSON.stringify(latestKws) !== JSON.stringify(lastSavedKeywordsRef.current);

      if (hasUnsaved) {
        if (!isSavingRef.current) {
          // No save in flight — flush immediately with the latest keywords
          isSavingRef.current = true;
          const kws = [...latestKws];
          updateMutation
            .mutateAsync({ id: current.id, data: { keywords: kws } })
            .then(() => {
              lastSavedKeywordsRef.current = kws;
              onKeywordsChanged?.(current.id, kws);
              queryClient.invalidateQueries({ queryKey: ["searchInventory"] });
            })
            .catch((err) => {
              console.warn("KeywordEditor: background save on close failed:", err);
            })
            .finally(() => {
              isSavingRef.current = false;
            });
        } else {
          // A save is in flight (with older data) — queue the latest keywords so the
          // in-flight save's finally block can fire one follow-up flush.
          postFlushRef.current = { id: current.id, keywords: [...latestKws] };
        }
      }
      // else: nothing changed since last save — no action needed
    }

    onClose();
  };

  // All hooks declared — now safe to gate rendering on item
  if (!item) return null;

  const statusColor =
    saveStatus === "saving"
      ? colors.warning
      : saveStatus === "saved"
      ? colors.success
      : saveStatus === "error"
      ? "#ef4444"
      : "transparent";

  const statusLabel =
    saveStatus === "saving"
      ? "Saving…"
      : saveStatus === "saved"
      ? "✓ Saved"
      : saveStatus === "error"
      ? "Save failed"
      : "";

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={[styles.container, { backgroundColor: colors.background }]}
      >
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={[styles.title, { color: colors.foreground }]}>Edit Keywords</Text>
              {saveStatus !== "idle" && (
                <View style={[styles.statusBadge, { backgroundColor: statusColor + "22" }]}>
                  {saveStatus === "saving" ? (
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
          <Pressable onPress={handleClose} style={[styles.closeBtn, { backgroundColor: colors.muted }]}>
            <Text style={{ color: colors.foreground, fontSize: 14 }}>✕</Text>
          </Pressable>
        </View>

        <ScrollView style={{ flex: 1, padding: 16 }}>
          <Text style={[styles.desc, { color: colors.mutedForeground }]} numberOfLines={2}>
            {item.description}
          </Text>

          <Text style={[styles.hint, { color: colors.mutedForeground }]}>
            Changes save automatically as you edit. Tap a keyword to remove it.
          </Text>

          {/* Current keywords */}
          <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
            KEYWORDS ({keywords.length})
          </Text>
          <View style={styles.kwRow}>
            {keywords.map((kw) => (
              <Pressable
                key={kw}
                onPress={() => removeKeyword(kw)}
                style={[styles.kwChip, { backgroundColor: colors.accent, borderColor: colors.primary + "44" }]}
              >
                <Text style={[styles.kwText, { color: colors.foreground }]}>{kw}</Text>
                <Text style={[styles.kwRemove, { color: colors.mutedForeground }]}>✕</Text>
              </Pressable>
            ))}
          </View>

          {keywords.length === 0 ? (
            <Text style={[styles.emptyHint, { color: colors.mutedForeground }]}>
              No keywords yet. Add some below.
            </Text>
          ) : null}

          {/* Add keyword */}
          <Text style={[styles.sectionLabel, { color: colors.mutedForeground, marginTop: 20 }]}>
            ADD KEYWORD
          </Text>
          <View style={styles.addRow}>
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
        </ScrollView>

        {/* Footer — just Done, no separate Save button */}
        <View style={[styles.footer, { borderTopColor: colors.border }]}>
          <Pressable
            onPress={handleClose}
            style={[styles.doneBtn, { backgroundColor: colors.primary }]}
          >
            <Text style={[styles.doneBtnText, { color: colors.primaryForeground }]}>Done</Text>
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
  hint: { fontSize: 12, fontFamily: "Inter_400Regular", fontStyle: "italic", marginBottom: 16, lineHeight: 18 },
  desc: { fontSize: 13, fontFamily: "Inter_400Regular", marginBottom: 10, lineHeight: 19 },
  sectionLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 10,
  },
  kwRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  kwChip: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    gap: 6,
  },
  kwText: { fontSize: 13, fontFamily: "Inter_400Regular" },
  kwRemove: { fontSize: 11 },
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
  footer: {
    padding: 16,
    borderTopWidth: 1,
  },
  doneBtn: {
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
  },
  doneBtnText: { fontSize: 15, fontFamily: "Inter_700Bold" },
});
