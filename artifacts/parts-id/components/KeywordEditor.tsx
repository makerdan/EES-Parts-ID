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
import {
  useUpdateInventoryItem,
  useSuggestItemDescription,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useColors } from "@/hooks/useColors";

interface KeywordEditorProps {
  item: InventoryItem | null;
  onClose: () => void;
  /** Called after keywords are saved so parent can update local Fuse index. */
  onKeywordsChanged?: (id: number, keywords: string[]) => void;
  /** Called after the description is saved so parent can update local Fuse index
   *  and surface the new description on the underlying card. */
  onDescriptionChanged?: (id: number, description: string) => void;
}

const DEBOUNCE_MS = 900;

type SaveStatus = "idle" | "saving" | "saved" | "error";

export function KeywordEditor({
  item,
  onClose,
  onKeywordsChanged,
  onDescriptionChanged,
}: KeywordEditorProps) {
  const colors = useColors();
  const queryClient = useQueryClient();

  // ── Edited values ──────────────────────────────────────────────────────────
  const [keywords, setKeywords] = useState<string[]>(item?.aiKeywords ?? []);
  const [description, setDescription] = useState<string>(item?.description ?? "");
  const [newKeyword, setNewKeyword] = useState("");

  // ── Save status — single badge reflects whichever field is in flight ───────
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");

  // ── AI suggestion state ────────────────────────────────────────────────────
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const suggestMutation = useSuggestItemDescription();

  const updateMutation = useUpdateInventoryItem();

  // Debounce timers — separate per field so a fast keyword tap doesn't keep
  // resetting the description debounce (and vice versa).
  const kwDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const descDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const latestKeywordsRef = useRef<string[]>(keywords);
  const latestDescriptionRef = useRef<string>(description);

  // Last successfully persisted values
  const lastSavedKeywordsRef = useRef<string[]>(item?.aiKeywords ?? []);
  const lastSavedDescriptionRef = useRef<string>(item?.description ?? "");

  // Tracks whether a mutateAsync call is currently in flight
  const isSavingRef = useRef(false);

  // When a save is in flight at close-time, stash the latest snapshot here so
  // the in-flight save's finally block can fire one follow-up flush.
  const postFlushRef = useRef<{
    id: number;
    keywords?: string[];
    description?: string;
  } | null>(null);

  // Keep item in a ref so callbacks always see the latest value
  const itemRef = useRef(item);
  useEffect(() => { itemRef.current = item; }, [item]);

  // Sync values when item changes (e.g. different item opened)
  useEffect(() => {
    const kws = item?.aiKeywords ?? [];
    const desc = item?.description ?? "";
    setKeywords(kws);
    setDescription(desc);
    setSuggestion(null);
    setSuggestError(null);
    latestKeywordsRef.current = kws;
    latestDescriptionRef.current = desc;
    lastSavedKeywordsRef.current = kws;
    lastSavedDescriptionRef.current = desc;
    setSaveStatus("idle");
  }, [item?.id]);

  // ── Persist a single field (or both if both have changed) ──────────────────
  // Always sends only the dirty fields so unrelated edits are never clobbered.
  const persist = useCallback(
    async (
      id: number,
      payload: { keywords?: string[]; description?: string },
    ) => {
      if (payload.keywords === undefined && payload.description === undefined) return;
      isSavingRef.current = true;
      setSaveStatus("saving");
      try {
        await updateMutation.mutateAsync({ id, data: payload });
        if (payload.keywords !== undefined) {
          lastSavedKeywordsRef.current = payload.keywords;
          onKeywordsChanged?.(id, payload.keywords);
        }
        if (payload.description !== undefined) {
          lastSavedDescriptionRef.current = payload.description;
          onDescriptionChanged?.(id, payload.description);
        }
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
          const next: { keywords?: string[]; description?: string } = {};
          if (pending.keywords !== undefined) next.keywords = pending.keywords;
          if (pending.description !== undefined) next.description = pending.description;
          updateMutation
            .mutateAsync({ id: pending.id, data: next })
            .then(() => {
              if (next.keywords !== undefined) {
                lastSavedKeywordsRef.current = next.keywords;
                onKeywordsChanged?.(pending.id, next.keywords);
              }
              if (next.description !== undefined) {
                lastSavedDescriptionRef.current = next.description;
                onDescriptionChanged?.(pending.id, next.description);
              }
              queryClient.invalidateQueries({ queryKey: ["searchInventory"] });
            })
            .catch((err) => {
              console.warn("KeywordEditor: post-close flush failed:", err);
            });
        }
      }
    },
    [updateMutation, queryClient, onKeywordsChanged, onDescriptionChanged],
  );

  // Debounced save for keywords
  const triggerKeywordSave = useCallback(
    (kws: string[]) => {
      const current = itemRef.current;
      if (!current) return;
      latestKeywordsRef.current = kws;
      if (kwDebounceRef.current) clearTimeout(kwDebounceRef.current);
      setSaveStatus("idle");
      kwDebounceRef.current = setTimeout(async () => {
        kwDebounceRef.current = null;
        if (isSavingRef.current) return; // skip if already saving
        await persist(current.id, { keywords: kws });
      }, DEBOUNCE_MS);
    },
    [persist],
  );

  // Debounced save for description
  const triggerDescriptionSave = useCallback(
    (desc: string) => {
      const current = itemRef.current;
      if (!current) return;
      latestDescriptionRef.current = desc;
      if (descDebounceRef.current) clearTimeout(descDebounceRef.current);
      setSaveStatus("idle");
      descDebounceRef.current = setTimeout(async () => {
        descDebounceRef.current = null;
        if (isSavingRef.current) return;
        await persist(current.id, { description: desc });
      }, DEBOUNCE_MS);
    },
    [persist],
  );

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (kwDebounceRef.current) clearTimeout(kwDebounceRef.current);
      if (descDebounceRef.current) clearTimeout(descDebounceRef.current);
    };
  }, []);

  const handleKeywordsChange = (next: string[]) => {
    setKeywords(next);
    triggerKeywordSave(next);
  };

  const handleDescriptionChange = (next: string) => {
    setDescription(next);
    triggerDescriptionSave(next);
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

  // ── AI suggestion ──────────────────────────────────────────────────────────
  const handleSuggest = async () => {
    const current = itemRef.current;
    if (!current) return;
    setSuggestError(null);
    setSuggestion(null);
    try {
      const res = await suggestMutation.mutateAsync({ id: current.id });
      setSuggestion(res.description);
    } catch {
      setSuggestError("Couldn't generate a suggestion. Please try again.");
    }
  };

  const handleUseSuggestion = () => {
    if (!suggestion) return;
    handleDescriptionChange(suggestion);
    setSuggestion(null);
    setSuggestError(null);
  };

  const handleDismissSuggestion = () => {
    setSuggestion(null);
    setSuggestError(null);
  };

  // ── Close: flush any pending edits, then close ─────────────────────────────
  const handleClose = () => {
    const current = itemRef.current;
    // Cancel any pending debounce timers
    if (kwDebounceRef.current) {
      clearTimeout(kwDebounceRef.current);
      kwDebounceRef.current = null;
    }
    if (descDebounceRef.current) {
      clearTimeout(descDebounceRef.current);
      descDebounceRef.current = null;
    }

    if (current) {
      const latestKws = latestKeywordsRef.current;
      const latestDesc = latestDescriptionRef.current;
      const kwsDirty = JSON.stringify(latestKws) !== JSON.stringify(lastSavedKeywordsRef.current);
      const descDirty = latestDesc !== lastSavedDescriptionRef.current;

      if (kwsDirty || descDirty) {
        const payload: { keywords?: string[]; description?: string } = {};
        if (kwsDirty) payload.keywords = [...latestKws];
        if (descDirty) payload.description = latestDesc;

        if (!isSavingRef.current) {
          // No save in flight — flush immediately
          isSavingRef.current = true;
          updateMutation
            .mutateAsync({ id: current.id, data: payload })
            .then(() => {
              if (payload.keywords !== undefined) {
                lastSavedKeywordsRef.current = payload.keywords;
                onKeywordsChanged?.(current.id, payload.keywords);
              }
              if (payload.description !== undefined) {
                lastSavedDescriptionRef.current = payload.description;
                onDescriptionChanged?.(current.id, payload.description);
              }
              queryClient.invalidateQueries({ queryKey: ["searchInventory"] });
            })
            .catch((err) => {
              console.warn("KeywordEditor: background save on close failed:", err);
            })
            .finally(() => {
              isSavingRef.current = false;
            });
        } else {
          // A save is in flight (with older data) — queue the latest snapshot
          // so the in-flight save's finally block can fire one follow-up flush.
          const queued: { id: number; keywords?: string[]; description?: string } = { id: current.id };
          if (payload.keywords !== undefined) queued.keywords = payload.keywords;
          if (payload.description !== undefined) queued.description = payload.description;
          postFlushRef.current = queued;
        }
      }
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

  const isSuggesting = suggestMutation.isPending;

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
              <Text style={[styles.title, { color: colors.foreground }]}>Edit Part Details</Text>
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

        <ScrollView style={{ flex: 1, padding: 16 }} keyboardShouldPersistTaps="handled">
          <Text style={[styles.hint, { color: colors.mutedForeground }]}>
            Changes save automatically as you edit.
          </Text>

          {/* ── Description ───────────────────────────────────────────── */}
          <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
            DESCRIPTION
          </Text>
          <TextInput
            value={description}
            onChangeText={handleDescriptionChange}
            placeholder="Describe this part…"
            placeholderTextColor={colors.mutedForeground}
            multiline
            style={[
              styles.descInput,
              { backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground },
            ]}
            autoCorrect
            autoCapitalize="sentences"
          />

          <Pressable
            onPress={handleSuggest}
            disabled={isSuggesting}
            style={[
              styles.suggestBtn,
              {
                borderColor: colors.primary + "55",
                backgroundColor: isSuggesting ? colors.muted : colors.accent,
                opacity: isSuggesting ? 0.7 : 1,
              },
            ]}
          >
            {isSuggesting ? (
              <ActivityIndicator size="small" color={colors.primary} style={{ marginRight: 6 }} />
            ) : null}
            <Text style={[styles.suggestBtnText, { color: colors.primary }]}>
              {isSuggesting ? "Generating…" : "✨ Suggest improved description"}
            </Text>
          </Pressable>

          {suggestError ? (
            <Text style={[styles.suggestError, { color: "#ef4444" }]}>
              {suggestError}
            </Text>
          ) : null}

          {suggestion ? (
            <View style={[styles.suggestionBlock, { borderColor: colors.primary + "55", backgroundColor: colors.accent }]}>
              <Text style={[styles.suggestionLabel, { color: colors.mutedForeground }]}>
                AI SUGGESTION
              </Text>
              <Text style={[styles.suggestionText, { color: colors.foreground }]}>
                {suggestion}
              </Text>
              <View style={styles.suggestionActions}>
                <Pressable
                  onPress={handleUseSuggestion}
                  style={[styles.suggestionUse, { backgroundColor: colors.primary }]}
                >
                  <Text style={[styles.suggestionUseText, { color: colors.primaryForeground }]}>
                    Use this
                  </Text>
                </Pressable>
                <Pressable
                  onPress={handleDismissSuggestion}
                  style={[styles.suggestionDismiss, { borderColor: colors.border }]}
                >
                  <Text style={[styles.suggestionDismissText, { color: colors.foreground }]}>
                    Dismiss
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          {/* ── Keywords ──────────────────────────────────────────────── */}
          <Text style={[styles.sectionLabel, { color: colors.mutedForeground, marginTop: 24 }]}>
            KEYWORDS ({keywords.length})
          </Text>
          <Text style={[styles.subHint, { color: colors.mutedForeground }]}>
            Tap a keyword to remove it.
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
  subHint: { fontSize: 12, fontFamily: "Inter_400Regular", fontStyle: "italic", marginBottom: 8, lineHeight: 18 },
  sectionLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 10,
  },
  descInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
    minHeight: 90,
    textAlignVertical: "top",
  },
  suggestBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginTop: 10,
  },
  suggestBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  suggestError: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    marginTop: 8,
    lineHeight: 18,
  },
  suggestionBlock: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginTop: 12,
  },
  suggestionLabel: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  suggestionText: { fontSize: 13, fontFamily: "Inter_400Regular", lineHeight: 19, marginBottom: 10 },
  suggestionActions: { flexDirection: "row", gap: 8 },
  suggestionUse: { borderRadius: 6, paddingHorizontal: 14, paddingVertical: 8 },
  suggestionUseText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  suggestionDismiss: {
    borderRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
  },
  suggestionDismissText: { fontSize: 13, fontFamily: "Inter_500Medium" },
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
