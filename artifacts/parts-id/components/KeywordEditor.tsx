/**
 * Inline AI-keyword editor for a single inventory item.
 *
 * Workers tap a chip to remove it or type new ones to add. Edits are
 * PATCHed to /inventory/:id/keywords; the local cache is updated
 * optimistically so the row reflects the change before the request
 * settles.
 */
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
import { ErrorBanner } from "@/components/ErrorBanner";
import { useApp } from "@/contexts/AppContext";

interface KeywordEditorProps {
  item: InventoryItem | null;
  onClose: () => void;
  /** Called after keywords are saved so parent can update local Fuse index. */
  onKeywordsChanged?: (id: number, keywords: string[]) => void;
  /** Called after the description is saved so parent can update local Fuse index
   *  and surface the new description on the underlying card. */
  onDescriptionChanged?: (id: number, description: string) => void;
  /** Called after trade size is saved. */
  onTradeSizeChanged?: (id: number, tradeSize: string | null) => void;
}

const DEBOUNCE_MS = 900;

type SaveStatus = "idle" | "saving" | "saved" | "error";

export function KeywordEditor({
  item,
  onClose,
  onKeywordsChanged,
  onDescriptionChanged,
  onTradeSizeChanged,
}: KeywordEditorProps) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const { isAdmin } = useApp();

  // ── Edited values ──────────────────────────────────────────────────────────
  const [keywords, setKeywords] = useState<string[]>(item?.aiKeywords ?? []);
  const [description, setDescription] = useState<string>(item?.description ?? "");
  const [tradeSize, setTradeSize] = useState<string>(item?.tradeSize ?? "");
  const [binLocations, setBinLocations] = useState<string[]>(item?.binLocations ?? []);
  const [newKeyword, setNewKeyword] = useState("");
  const [newBin, setNewBin] = useState("");
  const [binError, setBinError] = useState<string | null>(null);

  // ── Save status — single badge reflects whichever field is in flight ───────
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");

  // ── AI suggestion state ────────────────────────────────────────────────────
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const suggestMutation = useSuggestItemDescription();

  const updateMutation = useUpdateInventoryItem();

  // Debounce timers — separate per field so a fast keyword tap doesn't keep
  // resetting the description debounce (and vice versa).
  const kwInputRef = useRef<TextInput>(null);
  const kwDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const descDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tradeSizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const binDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const latestKeywordsRef = useRef<string[]>(keywords);
  const latestDescriptionRef = useRef<string>(description);
  const latestTradeSizeRef = useRef<string>(tradeSize);
  const latestBinsRef = useRef<string[]>(binLocations);

  // Last successfully persisted values
  const lastSavedKeywordsRef = useRef<string[]>(item?.aiKeywords ?? []);
  const lastSavedDescriptionRef = useRef<string>(item?.description ?? "");
  const lastSavedTradeSizeRef = useRef<string>(item?.tradeSize ?? "");
  const lastSavedBinsRef = useRef<string[]>(item?.binLocations ?? []);

  // Tracks whether a mutateAsync call is currently in flight
  const isSavingRef = useRef(false);

  // When a save is in flight at close-time, stash the latest snapshot here so
  // the in-flight save's finally block can fire one follow-up flush.
  const postFlushRef = useRef<{
    id: number;
    keywords?: string[];
    description?: string;
    tradeSize?: string | null;
    binLocations?: string[];
  } | null>(null);

  // Keep item in a ref so callbacks always see the latest value
  const itemRef = useRef(item);
  useEffect(() => { itemRef.current = item; }, [item]);

  // Sync values when item changes (e.g. different item opened)
  useEffect(() => {
    const kws = item?.aiKeywords ?? [];
    const desc = item?.description ?? "";
    const ts = item?.tradeSize ?? "";
    const bins = item?.binLocations ?? [];
    setKeywords(kws);
    setDescription(desc);
    setTradeSize(ts);
    setBinLocations(bins);
    setSuggestion(null);
    setSuggestError(null);
    setNewBin("");
    setBinError(null);
    latestKeywordsRef.current = kws;
    latestDescriptionRef.current = desc;
    latestTradeSizeRef.current = ts;
    latestBinsRef.current = bins;
    lastSavedKeywordsRef.current = kws;
    lastSavedDescriptionRef.current = desc;
    lastSavedTradeSizeRef.current = ts;
    lastSavedBinsRef.current = bins;
    setSaveStatus("idle");
  }, [item?.id]);

  // ── Persist a single field (or both if both have changed) ──────────────────
  // Always sends only the dirty fields so unrelated edits are never clobbered.
  const persist = useCallback(
    async (
      id: number,
      payload: { keywords?: string[]; description?: string; tradeSize?: string | null; binLocations?: string[] },
    ) => {
      if (payload.keywords === undefined && payload.description === undefined && payload.tradeSize === undefined && payload.binLocations === undefined) return;
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
        if (payload.tradeSize !== undefined) {
          const ts = payload.tradeSize ?? null;
          lastSavedTradeSizeRef.current = ts ?? "";
          onTradeSizeChanged?.(id, ts);
        }
        if (payload.binLocations !== undefined) {
          lastSavedBinsRef.current = payload.binLocations;
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
          const next: { keywords?: string[]; description?: string; tradeSize?: string | null; binLocations?: string[] } = {};
          if (pending.keywords !== undefined) next.keywords = pending.keywords;
          if (pending.description !== undefined) next.description = pending.description;
          if (pending.tradeSize !== undefined) next.tradeSize = pending.tradeSize;
          if (pending.binLocations !== undefined) next.binLocations = pending.binLocations;
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
              if (next.tradeSize !== undefined) {
                const ts = next.tradeSize ?? null;
                lastSavedTradeSizeRef.current = ts ?? "";
                onTradeSizeChanged?.(pending.id, ts);
              }
              if (next.binLocations !== undefined) {
                lastSavedBinsRef.current = next.binLocations;
              }
              queryClient.invalidateQueries({ queryKey: ["searchInventory"] });
            })
            .catch((err) => {
              console.warn("KeywordEditor: post-close flush failed:", err);
            });
        }
      }
    },
    [updateMutation, queryClient, onKeywordsChanged, onDescriptionChanged, onTradeSizeChanged],
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

  // Debounced save for trade size
  const triggerTradeSizeSave = useCallback(
    (ts: string) => {
      const current = itemRef.current;
      if (!current) return;
      latestTradeSizeRef.current = ts;
      if (tradeSizeDebounceRef.current) clearTimeout(tradeSizeDebounceRef.current);
      setSaveStatus("idle");
      tradeSizeDebounceRef.current = setTimeout(async () => {
        tradeSizeDebounceRef.current = null;
        if (isSavingRef.current) return;
        await persist(current.id, { tradeSize: ts.trim() === "" ? null : ts.trim() });
      }, DEBOUNCE_MS);
    },
    [persist],
  );

  // Debounced save for bin locations
  const triggerBinsSave = useCallback(
    (bins: string[]) => {
      const current = itemRef.current;
      if (!current) return;
      latestBinsRef.current = bins;
      if (binDebounceRef.current) clearTimeout(binDebounceRef.current);
      setSaveStatus("idle");
      binDebounceRef.current = setTimeout(async () => {
        binDebounceRef.current = null;
        if (isSavingRef.current) return;
        await persist(current.id, { binLocations: bins });
      }, DEBOUNCE_MS);
    },
    [persist],
  );

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (kwDebounceRef.current) clearTimeout(kwDebounceRef.current);
      if (descDebounceRef.current) clearTimeout(descDebounceRef.current);
      if (tradeSizeDebounceRef.current) clearTimeout(tradeSizeDebounceRef.current);
      if (binDebounceRef.current) clearTimeout(binDebounceRef.current);
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

  const handleTradeSizeChange = (next: string) => {
    setTradeSize(next);
    triggerTradeSizeSave(next);
  };

  const handleBinsChange = (next: string[]) => {
    setBinLocations(next);
    triggerBinsSave(next);
  };

  const BIN_PATTERN = /^\d{2}-\d{2}-\d{3}$/;

  const addBin = () => {
    const trimmed = newBin.trim().toUpperCase();
    if (!trimmed) return;
    if (!BIN_PATTERN.test(trimmed)) {
      setBinError("Format must be ##-##-### (e.g. 01-02-003)");
      return;
    }
    if (binLocations.map(b => b.toUpperCase()).includes(trimmed)) {
      setNewBin("");
      setBinError(null);
      return;
    }
    setBinError(null);
    setNewBin("");
    handleBinsChange([...binLocations, trimmed]);
  };

  const removeBin = (bin: string) => {
    handleBinsChange(binLocations.filter(b => b !== bin));
  };

  const addKeyword = () => {
    const trimmed = newKeyword.trim().toLowerCase();
    if (!trimmed || keywords.includes(trimmed)) {
      setNewKeyword("");
      kwInputRef.current?.focus();
      return;
    }
    const next = [...keywords, trimmed];
    setNewKeyword("");
    handleKeywordsChange(next);
    kwInputRef.current?.focus();
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
    if (kwDebounceRef.current) { clearTimeout(kwDebounceRef.current); kwDebounceRef.current = null; }
    if (descDebounceRef.current) { clearTimeout(descDebounceRef.current); descDebounceRef.current = null; }
    if (tradeSizeDebounceRef.current) { clearTimeout(tradeSizeDebounceRef.current); tradeSizeDebounceRef.current = null; }
    if (binDebounceRef.current) { clearTimeout(binDebounceRef.current); binDebounceRef.current = null; }

    if (current) {
      const latestKws = latestKeywordsRef.current;
      const latestDesc = latestDescriptionRef.current;
      const latestTs = latestTradeSizeRef.current;
      const latestBins = latestBinsRef.current;
      const kwsDirty = JSON.stringify(latestKws) !== JSON.stringify(lastSavedKeywordsRef.current);
      const descDirty = latestDesc !== lastSavedDescriptionRef.current;
      const tsDirty = latestTs !== lastSavedTradeSizeRef.current;
      const binsDirty = JSON.stringify(latestBins) !== JSON.stringify(lastSavedBinsRef.current);

      if (kwsDirty || descDirty || tsDirty || binsDirty) {
        const payload: { keywords?: string[]; description?: string; tradeSize?: string | null; binLocations?: string[] } = {};
        if (kwsDirty) payload.keywords = [...latestKws];
        if (descDirty) payload.description = latestDesc;
        if (tsDirty) payload.tradeSize = latestTs.trim() === "" ? null : latestTs.trim();
        if (binsDirty) payload.binLocations = [...latestBins];

        if (!isSavingRef.current) {
          isSavingRef.current = true;
          updateMutation
            .mutateAsync({ id: current.id, data: payload })
            .then(() => {
              if (payload.keywords !== undefined) { lastSavedKeywordsRef.current = payload.keywords; onKeywordsChanged?.(current.id, payload.keywords); }
              if (payload.description !== undefined) { lastSavedDescriptionRef.current = payload.description; onDescriptionChanged?.(current.id, payload.description); }
              if (payload.tradeSize !== undefined) { const ts = payload.tradeSize ?? null; lastSavedTradeSizeRef.current = ts ?? ""; onTradeSizeChanged?.(current.id, ts); }
              if (payload.binLocations !== undefined) { lastSavedBinsRef.current = payload.binLocations; }
              queryClient.invalidateQueries({ queryKey: ["searchInventory"] });
            })
            .catch((err) => { console.warn("KeywordEditor: background save on close failed:", err); })
            .finally(() => { isSavingRef.current = false; });
        } else {
          const queued: { id: number; keywords?: string[]; description?: string; tradeSize?: string | null; binLocations?: string[] } = { id: current.id };
          if (payload.keywords !== undefined) queued.keywords = payload.keywords;
          if (payload.description !== undefined) queued.description = payload.description;
          if (payload.tradeSize !== undefined) queued.tradeSize = payload.tradeSize;
          if (payload.binLocations !== undefined) queued.binLocations = payload.binLocations;
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
            <ErrorBanner message={suggestError} />
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

          {/* ── Trade Size ────────────────────────────────────────────── */}
          <Text style={[styles.sectionLabel, { color: colors.mutedForeground, marginTop: 24 }]}>
            TRADE SIZE
          </Text>
          <Text style={[styles.subHint, { color: colors.mutedForeground }]}>
            Groups this part with others of the same product in different sizes.
          </Text>
          <TextInput
            value={tradeSize}
            onChangeText={handleTradeSizeChange}
            placeholder={`e.g. 1/2", 3/4", 1"…`}
            placeholderTextColor={colors.mutedForeground}
            style={[
              styles.tradeSizeInput,
              { backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground },
            ]}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="done"
          />

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
              ref={kwInputRef}
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

          {/* ── Bin Locations (admin only) ──────────────────────────── */}
          {isAdmin ? (
            <>
              <Text style={[styles.sectionLabel, { color: colors.mutedForeground, marginTop: 24 }]}>
                BIN LOCATIONS ({binLocations.length})
              </Text>
              <Text style={[styles.subHint, { color: colors.mutedForeground }]}>
                Tap a bin to remove it. Format: ##-##-### (e.g. 01-02-003)
              </Text>
              <View style={styles.kwRow}>
                {binLocations.map((bin) => (
                  <Pressable
                    key={bin}
                    onPress={() => removeBin(bin)}
                    style={[styles.kwChip, { backgroundColor: colors.accent, borderColor: colors.warning + "55" }]}
                  >
                    <Text style={[styles.kwText, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>{bin}</Text>
                    <Text style={[styles.kwRemove, { color: colors.mutedForeground }]}>✕</Text>
                  </Pressable>
                ))}
              </View>
              {binLocations.length === 0 ? (
                <Text style={[styles.emptyHint, { color: colors.mutedForeground }]}>
                  No bins assigned.
                </Text>
              ) : null}
              <Text style={[styles.sectionLabel, { color: colors.mutedForeground, marginTop: 16 }]}>
                ADD BIN
              </Text>
              <View style={styles.addRow}>
                <TextInput
                  value={newBin}
                  onChangeText={(t) => { setNewBin(t); if (binError) setBinError(null); }}
                  placeholder="e.g. 01-02-003"
                  placeholderTextColor={colors.mutedForeground}
                  style={[
                    styles.addInput,
                    {
                      flex: 1,
                      backgroundColor: colors.muted,
                      borderColor: binError ? colors.destructive : colors.border,
                      color: colors.foreground,
                    },
                  ]}
                  onSubmitEditing={addBin}
                  returnKeyType="done"
                  autoCorrect={false}
                  autoCapitalize="characters"
                />
                <Pressable
                  onPress={addBin}
                  style={[styles.addBtn, { backgroundColor: colors.primary }]}
                >
                  <Text style={[styles.addBtnText, { color: colors.primaryForeground }]}>+ Add</Text>
                </Pressable>
              </View>
              {binError ? (
                <Text style={[styles.binError, { color: colors.destructive }]}>{binError}</Text>
              ) : null}
            </>
          ) : null}
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
  tradeSizeInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
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
  binError: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 6, lineHeight: 18 },
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
