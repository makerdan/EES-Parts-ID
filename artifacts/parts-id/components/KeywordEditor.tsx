import { useQueryClient } from "@tanstack/react-query";
import type { InventoryItem } from "@workspace/api-client-react";
import { useUpdateItemKeywords } from "@workspace/api-client-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { DismissKeyboard } from "@/components/DismissKeyboard";
import { KeyboardDoneInput } from "@/components/KeyboardDoneInput";
import { useApp } from "@/contexts/AppContext";
import { useColors } from "@/hooks/useColors";
import { arraysEqual } from "@/utils/arraysEqual";
import { drainSave } from "@/utils/drainSave";

interface KeywordEditorProps {
  item: InventoryItem | null;
  onClose: () => void;
  /** Called after keywords are saved so parent can update local Fuse index */
  onKeywordsChanged?: (id: number, keywords: Array<string>) => void;
}

const DEBOUNCE_MS = 900;

type ItemSaveState = {
  latest: Array<string>;
  lastSaved: Array<string>;
  saving: boolean;
};

export function KeywordEditor({ item, onClose, onKeywordsChanged }: KeywordEditorProps) {
  "use no memo";
  const colors = useColors();
  const queryClient = useQueryClient();
  const { showToast } = useApp();
  const [keywords, setKeywords] = useState<Array<string>>(item?.aiKeywords ?? []);
  const [newKeyword, setNewKeyword] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const updateMutation = useUpdateItemKeywords();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks the live Promise returned by performSaveForId, keyed by item id.
  // handleClose awaits this to ensure it waits for an already-running drain
  // rather than just the no-op early return when s.saving is true.
  const inFlightByIdRef = useRef<Record<number, Promise<void>>>({});
  // Prevents re-entrant or concurrent close attempts from all three close
  // paths (footer Done, header ✕, Modal onRequestClose).
  const closingRef = useRef(false);
  const [closing, setClosing] = useState(false);

  // Per-item save state, keyed by item.id. This isolates the in-flight
  // drain loop from any other item the user might open or close: closing
  // item A while a save is in flight, then quickly opening item B, will
  // NOT cause B's keywords to be written to A's id (or vice-versa).
  const stateByIdRef = useRef<Record<number, ItemSaveState>>({});
  const ensureState = useCallback((id: number, kws: Array<string>): ItemSaveState => {
    let s = stateByIdRef.current[id];
    if (!s) {
      s = { latest: kws, lastSaved: kws, saving: false };
      stateByIdRef.current[id] = s;
    }
    return s;
  }, []); // stateByIdRef is a stable ref — no reactive deps
  // Keep item in a ref so callbacks always see the latest value without stale closure issues
  const itemRef = useRef(item);
  useEffect(() => { itemRef.current = item; }, [item]);

  // Sync display keywords when a *new* item is opened. Per-item save state
  // lives in `stateByIdRef`, so opening a different item never disturbs an
  // in-flight save for the previous item.
  useEffect(() => {
    const it = itemRef.current;
    if (!it) return;
    const kws = it.aiKeywords ?? [];
    const s = ensureState(it.id, kws);
    // If no save is running and there are no pending edits, refresh from
    // the latest server value; otherwise preserve the user's pending state.
    if (!s.saving && arraysEqual(s.latest, s.lastSaved)) {
      s.latest = kws;
      s.lastSaved = kws;
    }
    setKeywords(s.latest);
    setSaveStatus(s.saving ? "saving" : "idle");
  }, [item?.id, ensureState]);

  // Drains pending edits in a loop for a *specific* item id. After each
  // save, if that item's `latest` has moved on (because the user kept
  // typing while we were saving), it immediately saves again. This
  // guarantees the last edit always lands without dropping intermediate
  // state. See utils/drainSave.ts. Pinning to `id` (not itemRef) means
  // mid-loop item switches cannot cross-contaminate writes.
  //
  // The live drain Promise is stored in `inFlightByIdRef[id]` for the
  // duration of the drain so handleClose can await it. It is stored here
  // (not at call sites) so that a no-op early return (when s.saving is true)
  // never overwrites the real running promise with a resolved one.
  //
  // A deferred-promise pattern is used so that `inFlightByIdRef[id]` is
  // assigned synchronously *before* any async work begins. This prevents the
  // finally block from deleting the ref before the outer assignment can
  // execute (which would happen if drainSave's first await resolved
  // synchronously, e.g. in tests with mocked mutations).
  const performSaveForId = useCallback((id: number): Promise<void> => {
    const s = stateByIdRef.current[id];
    // If a drain is already running, return the real in-flight promise so
    // callers (including handleClose) can await the actual work — not just a
    // resolved no-op.
    if (!s || s.saving) return inFlightByIdRef.current[id] ?? Promise.resolve();
    if (arraysEqual(s.latest, s.lastSaved)) return Promise.resolve();

    if (itemRef.current?.id === id) setSaveStatus("saving");
    s.saving = true;

    // Create and register the deferred promise synchronously, before the IIFE
    // begins executing. This guarantees inFlightByIdRef[id] is set to the
    // real promise before any async boundary — so a fast-resolving drain
    // cannot reach `finally` (and delete the ref) before it is stored.
    let settleDrain: () => void = () => { /* set by Promise ctor below */ };
    const drainPromise = new Promise<void>(resolve => { settleDrain = resolve; });
    inFlightByIdRef.current[id] = drainPromise;

    void (async () => {
      try {
        await drainSave<Array<string>>({
          getLatest: () => s.latest,
          getLastSaved: () => s.lastSaved,
          setLastSaved: v => {
            s.lastSaved = v;
            onKeywordsChanged?.(id, v);
          },
          save: async kws => {
            await updateMutation.mutateAsync({ id, data: { keywords: kws } });
          },
          equal: arraysEqual,
          isRunningRef: { current: false }, // outer `s.saving` already gates re-entry
        });
        await queryClient.invalidateQueries({ queryKey: ["searchInventory"] });
        if (itemRef.current?.id === id) {
          setSaveStatus("saved");
          setTimeout(() => {
            if (itemRef.current?.id === id) setSaveStatus("idle");
          }, 1800);
        }
      } catch (err) {
        console.warn("KeywordEditor: save failed:", err);
        s.latest = s.lastSaved;
        if (itemRef.current?.id === id) {
          setKeywords(s.lastSaved);
          setSaveStatus("error");
        }
        showToast("Save failed — changes reverted.", "error");
      } finally {
        s.saving = false;
        // Only clear our own promise — do not clobber a newer drain's ref.
        if (inFlightByIdRef.current[id] === drainPromise) delete inFlightByIdRef.current[id];
        settleDrain();
      }
    })();

    return drainPromise;
  }, [updateMutation, queryClient, onKeywordsChanged, showToast]);

  // Manual retry — re-runs the drain loop for the currently open item.
  // Used by the Retry button that appears when saveStatus === "error".
  const retrySave = useCallback(() => {
    const id = itemRef.current?.id;
    if (id == null) return;
    void performSaveForId(id);
  }, [performSaveForId]);

  // Auto-save with debounce whenever keywords change. Captures the *current*
  // item id so the eventual save always targets the item that was being
  // edited when the debounce was scheduled — never a different item the
  // user may have opened in the meantime.
  const triggerSave = useCallback(
    (kws: Array<string>) => {
      const current = itemRef.current;
      if (!current) return;
      const id = current.id;
      const s = ensureState(id, current.aiKeywords ?? []);
      s.latest = kws;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      setSaveStatus("idle");
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void performSaveForId(id);
      }, DEBOUNCE_MS);
    },
    [performSaveForId, ensureState],
  );

  // Cancel any pending debounce on unmount.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleKeywordsChange = (next: Array<string>) => {
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
    Alert.alert(
      "Remove Keyword",
      `Remove keyword "${kw}"?`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: () => handleKeywordsChange(keywords.filter((k) => k !== kw)) },
      ],
    );
  };

  const handleClose = async () => {
    // Guard against re-entry: footer Done, header ✕, and onRequestClose all
    // share this handler — a second tap while the close flush is in progress
    // must be a no-op.
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);

    // Cancel any pending debounce so it does not fire after we close.
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    const id = itemRef.current?.id;
    if (id != null) {
      // performSaveForId returns the real in-flight promise when s.saving is
      // true (so we wait for the running drain to settle), or starts and
      // returns a new flush when there are pending edits, or resolves
      // immediately when nothing is pending. A single await covers all cases.
      await performSaveForId(id);
    }

    onClose();
    // closingRef / setClosing not reset — the Modal unmounts after onClose().
  };

  // All hooks declared — now safe to gate rendering on item
  if (!item) return null;

  const statusColor =
    saveStatus === "saving"
      ? colors.warning
      : saveStatus === "saved"
      ? colors.success
      : saveStatus === "error"
      ? colors.destructive
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
        <DismissKeyboard>
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
              {saveStatus === "error" && (
                <Pressable
                  onPress={retrySave}
                  accessibilityRole="button"
                  accessibilityLabel="Retry saving keywords"
                  style={[styles.retryBtn, { borderColor: colors.destructive }]}
                >
                  <Text style={[styles.retryText, { color: colors.destructive }]}>Retry</Text>
                </Pressable>
              )}
            </View>
            <Text style={[styles.sub, { color: colors.mutedForeground }]} numberOfLines={1}>
              {item.vendor} · {item.catalog}
            </Text>
          </View>
          <Pressable
            onPress={handleClose}
            disabled={closing}
            style={[styles.closeBtn, { backgroundColor: colors.muted, opacity: closing ? 0.4 : 1 }]}
            accessibilityLabel="Close keyword editor"
            accessibilityRole="button"
          >
            <Text style={{ color: colors.foreground, fontSize: 14 }}>✕</Text>
          </Pressable>
        </View>

        <ScrollView style={{ flex: 1, padding: 16 }} keyboardShouldPersistTaps="handled">
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
            <KeyboardDoneInput
              value={newKeyword}
              onChangeText={setNewKeyword}
              placeholder="Type keyword and press Add…"
              placeholderTextColor={colors.mutedForeground}
              maxLength={60}
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
            disabled={saveStatus === "saving" || closing}
            style={[styles.doneBtn, { backgroundColor: saveStatus === "saving" || closing ? colors.muted : colors.primary }]}
          >
            {saveStatus === "saving" || closing ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <ActivityIndicator size="small" color={colors.mutedForeground} />
                <Text style={[styles.doneBtnText, { color: colors.mutedForeground }]}>Saving…</Text>
              </View>
            ) : (
              <Text style={[styles.doneBtnText, { color: colors.primaryForeground }]}>Done</Text>
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
  retryBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
  },
  retryText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
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
