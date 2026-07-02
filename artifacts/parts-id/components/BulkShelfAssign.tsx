import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQueryClient } from "@tanstack/react-query";
import type { InventoryItem } from "@workspace/api-client-react";
import {
  listInventory,
  useListInventory,
  useUpdateItemBarcodes,
} from "@workspace/api-client-react";
import { type BarcodeScanningResult,CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import React, { useCallback, useEffect, useMemo,useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Image,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { DismissKeyboard } from "@/components/DismissKeyboard";
import { KeyboardDoneInput } from "@/components/KeyboardDoneInput";
import { useApp } from "@/contexts/AppContext";
import { useColors } from "@/hooks/useColors";
import { resolveShelfAssign } from "@/utils/barcodeResolver";
import { invalidateListIfNew, undoBarcodeAndInvalidate } from "@/utils/listEditorHandlers";
import { upsertItemInBarcodeCache } from "@/utils/offlineBarcode";

const BULK_SESSION_KEY = "parts_id_bulk_shelf_session_v1";
/**
 * Minimum milliseconds between auto-assign attempts. Prevents the same
 * barcode frame from triggering multiple assignments while the camera
 * continues streaming after a successful scan.
 */
const SCAN_COOLDOWN_MS = 2000;

function formatShelfPrefix(raw: string): string {
  const stripped = raw.replace(/-/g, "");
  if (!/^\d*$/.test(stripped)) return raw;
  let result = stripped.slice(0, 2);
  if (stripped.length > 2) result += "-" + stripped.slice(2, 4);
  if (stripped.length > 4) result += "-" + stripped.slice(4, 7);
  return result;
}

/** Fetch every page of inventory until all items are collected.
 *  Pass binPrefix to restrict to a shelf; omit it for the full catalog. */
async function fetchAllInventory(binPrefix?: string): Promise<Array<InventoryItem>> {
  const pageSize = 500;
  let page = 1;
  const all: Array<InventoryItem> = [];
  while (true) {
    const result = await listInventory({ page, limit: pageSize, binPrefix });
    all.push(...(result.items ?? []));
    if (all.length >= (result.total ?? 0)) break;
    page++;
  }
  return all;
}

type SyncStatus = "pending" | "synced" | "error";

type ItemRowState = {
  assignedBarcode: string | null;
  syncStatus: SyncStatus | null;
  conflictBarcode: string | null;
  conflictOwner: string | null;
  flash: boolean;
};

/**
 * Persisted session. shelfItems is stored in full so the session can be
 * restored offline without a network round-trip.
 */
type BulkSession = {
  shelfPrefix: string;
  /** Complete snapshot of shelf items loaded at session start. */
  shelfItems: Array<InventoryItem>;
  itemRowStates: Record<number, ItemRowState>;
  targetItemId: number | null;
};

async function saveBulkSession(session: BulkSession): Promise<void> {
  try {
    await AsyncStorage.setItem(BULK_SESSION_KEY, JSON.stringify(session));
  } catch {}
}

async function loadBulkSession(): Promise<BulkSession | null> {
  try {
    const raw = await AsyncStorage.getItem(BULK_SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as BulkSession;
  } catch {
    return null;
  }
}

async function clearBulkSession(): Promise<void> {
  try {
    await AsyncStorage.removeItem(BULK_SESSION_KEY);
  } catch {}
}

interface BulkShelfAssignProps {
  visible: boolean;
  onClose: () => void;
}

export function BulkShelfAssign({ visible, onClose }: BulkShelfAssignProps) {
  "use no memo";
  const colors = useColors();
  const { showToast } = useApp();
  const queryClient = useQueryClient();
  const updateBarcodesMutation = useUpdateItemBarcodes();
  const [permission, requestPermission] = useCameraPermissions();

  const [step, setStep] = useState<"input" | "session" | "done">("input");
  const [shelfPrefix, setShelfPrefix] = useState("");
  const [targetItemId, setTargetItemId] = useState<number | null>(null);
  const [itemRowStates, setItemRowStates] = useState<Record<number, ItemRowState>>({});

  /** Items loaded for the current session shelf (complete, multi-page fetch). */
  const [shelfItems, setShelfItems] = useState<Array<InventoryItem>>([]);
  /**
   * All inventory items — used for conflict detection. Populated by
   * fetchAllInventory and refreshed in the background after resume.
   */
  const allItemsRef = useRef<Array<InventoryItem>>([]);

  const [loadingItems, setLoadingItems] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cameraStarted, setCameraStarted] = useState(false);
  const cameraViewSizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });

  /** Ref holding the id of the item currently being assigned, to block concurrent assignments. */
  const assigningRef = useRef<number | null>(null);
  const [assigningId, setAssigningId] = useState<number | null>(null);
  const [undoingId, setUndoingId] = useState<number | null>(null);

  /**
   * Tracks the last committed barcode value + timestamp to enforce the
   * SCAN_COOLDOWN_MS window and suppress duplicate detections.
   */
  const lastScanRef = useRef<{ code: string; ts: number } | null>(null);

  const [filterUnassigned, setFilterUnassigned] = useState(false);

  const [resumeSession, setResumeSession] = useState<BulkSession | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);

  const doneAnimScale = useRef(new Animated.Value(0)).current;
  const doneAnimOpacity = useRef(new Animated.Value(0)).current;

  // Used only for the shelf prefix autocomplete chips (lower limit is fine here)
  const { data: suggestPage } = useListInventory({ limit: 500 });
  const suggestAllItems = useMemo(() => suggestPage?.items ?? [], [suggestPage]);

  const allBinLocations = useMemo(() => {
    const set = new Set<string>();
    // Seed from the cached 500-item suggestion page
    for (const item of suggestAllItems) {
      for (const bin of item.binLocations ?? []) {
        if (bin.trim()) set.add(bin.trim());
      }
    }
    // Merge in bins from the fully-loaded shelf items so locations beyond
    // position 500 in the catalog are represented in the autocomplete chips.
    for (const item of shelfItems) {
      for (const bin of item.binLocations ?? []) {
        if (bin.trim()) set.add(bin.trim());
      }
    }
    return Array.from(set).sort();
  }, [suggestAllItems, shelfItems]);

  const assignedCount = useMemo(() => {
    return shelfItems.filter(item => {
      const row = itemRowStates[item.id];
      if (row?.assignedBarcode) return true;
      return Array.isArray(item.barcodes) && item.barcodes.length > 0;
    }).length;
  }, [shelfItems, itemRowStates]);

  const unassignedItems = useMemo(() => {
    return shelfItems.filter(item => {
      const row = itemRowStates[item.id];
      if (row?.assignedBarcode) return false;
      return !Array.isArray(item.barcodes) || item.barcodes.length === 0;
    });
  }, [shelfItems, itemRowStates]);

  const conflictItems = useMemo(() => {
    return shelfItems.filter(item => !!itemRowStates[item.id]?.conflictBarcode);
  }, [shelfItems, itemRowStates]);

  const filteredShelfItems = useMemo(() => {
    if (!filterUnassigned) return shelfItems;
    return shelfItems.filter(item => {
      const row = itemRowStates[item.id];
      if (row?.assignedBarcode) return false;
      return !Array.isArray(item.barcodes) || item.barcodes.length === 0;
    });
  }, [shelfItems, itemRowStates, filterUnassigned]);

  // Server-side count for the shelf prefix preview — uses limit:1 so only
  // the total field matters; the actual items are not loaded here.
  const previewBinPrefix = shelfPrefix.trim() || undefined;
  const { data: previewCountPage } = useListInventory(
    { binPrefix: previewBinPrefix, limit: 1 },
  );

  // Snapshot stats for the input step — total comes from the server-side count
  // so it is accurate regardless of catalog size. withBarcode is derived from the
  // cached 500-item suggestion page and is labelled as approximate in the UI.
  const inputPreviewStats = useMemo(() => {
    if (!shelfPrefix.trim()) return null;
    const prefix = shelfPrefix.trim().toUpperCase();
    const withBarcode = suggestAllItems
      .filter(item => item.binLocations?.some(b => b.toUpperCase().startsWith(prefix)))
      .filter(i => Array.isArray(i.barcodes) && i.barcodes.length > 0).length;
    return {
      total: previewCountPage?.total ?? null,
      withBarcode,
    };
  }, [shelfPrefix, suggestAllItems, previewCountPage]);

  useEffect(() => {
    if (!visible) {
      setCameraStarted(false);
      return;
    }
    loadBulkSession().then(session => {
      if (session?.shelfPrefix) {
        setResumeSession(session);
      }
      setSessionChecked(true);
    });
  }, [visible]);

  // Persist session whenever key state changes (only during active session)
  useEffect(() => {
    if (step !== "session" || !shelfPrefix) return;
    saveBulkSession({ shelfPrefix, shelfItems, itemRowStates, targetItemId });
  }, [step, shelfPrefix, shelfItems, itemRowStates, targetItemId]);

  // Detect completion: all items assigned → transition to "done"
  useEffect(() => {
    if (step !== "session") return;
    if (shelfItems.length === 0) return;
    if (assignedCount < shelfItems.length) return;
    // Every item is assigned — show summary
    clearBulkSession();
    setCameraStarted(false);
    doneAnimScale.setValue(0);
    doneAnimOpacity.setValue(0);
    setStep("done");
    Animated.parallel([
      Animated.spring(doneAnimScale, { toValue: 1, useNativeDriver: true, bounciness: 14 }),
      Animated.timing(doneAnimOpacity, { toValue: 1, useNativeDriver: true, duration: 280 }),
    ]).start();
    try {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignedCount, shelfItems.length, step]);

  /**
   * Resume a saved session. Restores the full item list immediately from
   * persisted data (no network needed), then refreshes allItemsRef in
   * the background so conflict detection uses up-to-date catalogue data.
   */
  const applyResume = useCallback((session: BulkSession) => {
    setShelfPrefix(session.shelfPrefix);
    setShelfItems(session.shelfItems);
    setItemRowStates(session.itemRowStates);
    setTargetItemId(session.targetItemId);
    setResumeSession(null);
    setCameraStarted(false);
    setLoadError(null);
    lastScanRef.current = null;
    setStep("session");
    // Refresh allItemsRef in background — does not block the session start
    fetchAllInventory().then(all => { allItemsRef.current = all; }).catch(() => {});
  }, []);

  const startFresh = useCallback(() => {
    setResumeSession(null);
    clearBulkSession();
  }, []);

  const handleLoadItems = useCallback(async () => {
    if (!shelfPrefix.trim()) return;
    setLoadError(null);
    setLoadingItems(true);
    setItemRowStates({});
    setTargetItemId(null);
    setCameraStarted(false);
    lastScanRef.current = null;
    clearBulkSession();
    try {
      const prefix = shelfPrefix.trim().toUpperCase();
      // Fetch only the shelf's items (server-side filtered). This is fast
      // because the server returns just the matching rows, not the full catalog.
      const matching = await fetchAllInventory(prefix);
      setShelfItems(matching);
      setStep("session");
      // Refresh the full catalog in the background for conflict detection.
      // This mirrors the resume path and does not block entering the session.
      fetchAllInventory().then(all => { allItemsRef.current = all; }).catch(() => {});
    } catch {
      setLoadError("Could not load items — check your connection and try again.");
    } finally {
      setLoadingItems(false);
    }
  }, [shelfPrefix]);

  const handleClose = useCallback(() => {
    setStep("input");
    setShelfPrefix("");
    setItemRowStates({});
    setTargetItemId(null);
    setCameraStarted(false);
    setResumeSession(null);
    setSessionChecked(false);
    setShelfItems([]);
    setLoadError(null);
    lastScanRef.current = null;
    doneAnimScale.setValue(0);
    doneAnimOpacity.setValue(0);
    onClose();
  }, [onClose, doneAnimScale, doneAnimOpacity]);

  /**
   * Perform the remote assignment for a (barcode, item) pair.
   * Updates itemRowStates with pending → synced / error and
   * invalidates the inventory query cache on success.
   */
  const performAssign = useCallback(async (barcode: string, item: InventoryItem) => {
    assigningRef.current = item.id;
    setAssigningId(item.id);
    try {
      const result = await resolveShelfAssign(
        barcode,
        item,
        (id, barcodes) => updateBarcodesMutation.mutateAsync({ id, data: { barcodes } }),
        upsertItemInBarcodeCache,
      );
      await invalidateListIfNew({ queryClient, wasNew: result.wasNew });
      setItemRowStates(prev => ({
        ...prev,
        [item.id]: {
          assignedBarcode: barcode,
          syncStatus: "synced",
          conflictBarcode: null,
          conflictOwner: null,
          flash: true,
        },
      }));
      try {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch {}
      setTimeout(() => {
        setItemRowStates(prev => {
          const existing = prev[item.id];
          if (!existing) return prev;
          return { ...prev, [item.id]: { ...existing, flash: false } };
        });
      }, 800);
      setTargetItemId(null);
    } catch {
      setItemRowStates(prev => ({
        ...prev,
        [item.id]: {
          assignedBarcode: null,
          syncStatus: "error",
          conflictBarcode: null,
          conflictOwner: null,
          flash: false,
        },
      }));
      showToast("Assignment failed — please try again", "error");
    } finally {
      assigningRef.current = null;
      setAssigningId(null);
    }
  }, [updateBarcodesMutation, queryClient, showToast]);

  /**
   * Undo a barcode assignment made during this session.
   * Removes the barcode from the item on the remote API and offline cache,
   * then resets the row back to "Unassigned" so a new barcode can be scanned.
   */
  const handleUndoAssignment = useCallback(async (item: InventoryItem, barcode: string) => {
    setUndoingId(item.id);
    try {
      const liveItem = allItemsRef.current.find(i => i.id === item.id);
      const currentBarcodes = (liveItem ?? item).barcodes ?? [];
      const updated = await undoBarcodeAndInvalidate({
        queryClient,
        mutateAsync: updateBarcodesMutation.mutateAsync,
        itemId: item.id,
        currentBarcodes,
        revokedBarcode: barcode,
      });
      await upsertItemInBarcodeCache(updated);
      setItemRowStates(prev => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
      showToast("Barcode assignment undone", "info");
    } catch {
      showToast("Could not undo — please try again", "error");
    } finally {
      setUndoingId(null);
    }
  }, [updateBarcodesMutation, queryClient, showToast]);

  /**
   * Camera barcode detection handler.
   *
   * On each detected barcode frame the handler:
   *   1. Validates the barcode is within the viewfinder zone.
   *   2. Ignores the frame if the same code was committed within the cooldown window.
   *   3. Ignores the frame if an assignment is already in flight.
   *   4. Runs validation (dedup, conflict) and immediately starts the assignment.
   *
   * No manual "Scan" button press is needed — the assignment fires automatically
   * on detection, matching the continuous shelf-sweep workflow.
   */
  const handleBarcodeScanned = useCallback(
    (result: BarcodeScanningResult) => {
      // Viewfinder zone check
      const { width: cw, height: ch } = cameraViewSizeRef.current;
      if (cw > 0 && ch > 0) {
        const VF_W = 200, VF_H = 100, MARGIN = 20;
        const vfL = (cw - VF_W) / 2 - MARGIN, vfT = (ch - VF_H) / 2 - MARGIN;
        const vfR = vfL + VF_W + MARGIN * 2, vfB = vfT + VF_H + MARGIN * 2;
        const pts = result.cornerPoints;
        let cx: number, cy: number;
        if (pts && pts.length >= 2) {
          cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
          cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
        } else {
          const b = result.bounds;
          if (b && (b.size.width > 0 || b.size.height > 0)) {
            cx = b.origin.x + b.size.width / 2;
            cy = b.origin.y + b.size.height / 2;
          } else {
            cx = cw / 2; cy = ch / 2;
          }
        }
        if (cx < vfL || cx > vfR || cy < vfT || cy > vfB) return;
      }

      const code = result.data;
      const now = Date.now();

      // Cooldown: ignore this frame if the same code was just committed
      const last = lastScanRef.current;
      if (last && last.code === code && now - last.ts < SCAN_COOLDOWN_MS) return;

      // Ignore if an assignment is already in flight
      if (assigningRef.current !== null) return;

      // — Validate —

      // Deduplicate: already assigned this session
      const alreadyInSession = Object.values(itemRowStates).some(
        row => row.assignedBarcode === code
      );
      if (alreadyInSession) return;

      // Determine effective target
      const effectiveTarget = targetItemId
        ? shelfItems.find(i => i.id === targetItemId)
        : unassignedItems[0];

      if (!effectiveTarget) {
        showToast("All items already assigned", "info");
        return;
      }

      // Item is already done (pre-existing barcode or session assignment)
      const existingRow = itemRowStates[effectiveTarget.id];
      const alreadyHasBarcode =
        !!existingRow?.assignedBarcode ||
        (Array.isArray(effectiveTarget.barcodes) && effectiveTarget.barcodes.length > 0);
      if (alreadyHasBarcode) {
        showToast("Item already has a barcode — tap another item to target it", "info");
        return;
      }

      // Conflict check: barcode owned by an item NOT on this shelf
      const conflictItem = allItemsRef.current.find(
        item => Array.isArray(item.barcodes) && item.barcodes.includes(code)
      );
      const conflictIsOnThisShelf = conflictItem
        ? shelfItems.some(i => i.id === conflictItem.id)
        : false;

      if (conflictItem && !conflictIsOnThisShelf) {
        // Always write inline row-level conflict, regardless of auto/manual target
        setItemRowStates(prev => ({
          ...prev,
          [effectiveTarget.id]: {
            assignedBarcode: null,
            syncStatus: null,
            conflictBarcode: code,
            conflictOwner: `${conflictItem.catalog} (${conflictItem.vendor})`,
            flash: false,
          },
        }));
        showToast(`Barcode owned by ${conflictItem.catalog} — row flagged`, "error");
        // Still consume the cooldown so a new barcode is expected
        lastScanRef.current = { code, ts: now };
        return;
      }

      // Barcode already belongs to this shelf item
      if (conflictItem && conflictIsOnThisShelf) {
        if ((conflictItem.barcodes ?? []).includes(code)) {
          lastScanRef.current = { code, ts: now };
          return;
        }
      }

      // — Commit —
      lastScanRef.current = { code, ts: now };

      try {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      } catch {}

      setItemRowStates(prev => ({
        ...prev,
        [effectiveTarget.id]: {
          assignedBarcode: null,
          syncStatus: "pending",
          conflictBarcode: null,
          conflictOwner: null,
          flash: false,
        },
      }));

      void performAssign(code, effectiveTarget);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [itemRowStates, shelfItems, unassignedItems, targetItemId, performAssign, showToast],
  );

  if (!visible) return null;

  const prefixSuggestions = shelfPrefix.trim()
    ? allBinLocations
        .filter(b => b.toUpperCase().startsWith(shelfPrefix.trim().toUpperCase()))
        .slice(0, 8)
    : allBinLocations.slice(0, 8);

  const progressPct =
    shelfItems.length > 0 ? Math.round((assignedCount / shelfItems.length) * 100) : 0;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <SafeAreaView style={[bsStyles.safe, { backgroundColor: colors.background }]}>
        <DismissKeyboard>
        {/* Header */}
        <View style={[bsStyles.header, { borderBottomColor: colors.border }]}>
          <Text style={[bsStyles.headerTitle, { color: colors.foreground }]}>
            {step === "session" ? `Bulk Assign — ${shelfPrefix}` : step === "done" ? `Done — ${shelfPrefix}` : "Bulk Assign by Shelf"}
          </Text>
          <Pressable onPress={handleClose} hitSlop={10}>
            <Text style={{ color: colors.primary, fontSize: 15, fontFamily: "Inter_500Medium" }}>
              Close
            </Text>
          </Pressable>
        </View>

        {/* ── Done summary step ────────────────────────────────────────────── */}
        {step === "done" ? (
          <Animated.View style={[bsStyles.doneSummary, { opacity: doneAnimOpacity }]}>
            <Animated.View
              style={[
                bsStyles.doneIconCircle,
                {
                  backgroundColor: colors.success + "22",
                  borderColor: colors.success + "55",
                  transform: [{ scale: doneAnimScale }],
                },
              ]}
            >
              <Text style={bsStyles.doneCheckmark}>✓</Text>
            </Animated.View>

            <Text style={[bsStyles.doneTitle, { color: colors.foreground }]}>
              Shelf Complete
            </Text>
            <Text style={[bsStyles.doneSubtitle, { color: colors.mutedForeground }]}>
              All items on shelf {shelfPrefix} have been processed.
            </Text>

            <View
              style={[
                bsStyles.doneStat,
                { backgroundColor: colors.card, borderColor: colors.border },
              ]}
            >
              <View style={bsStyles.doneStatRow}>
                <Text style={[bsStyles.doneStatLabel, { color: colors.mutedForeground }]}>
                  Shelf
                </Text>
                <Text style={[bsStyles.doneStatValue, { color: colors.foreground }]}>
                  {shelfPrefix}
                </Text>
              </View>
              <View style={[bsStyles.doneStatDivider, { backgroundColor: colors.border }]} />
              <View style={bsStyles.doneStatRow}>
                <Text style={[bsStyles.doneStatLabel, { color: colors.mutedForeground }]}>
                  Total items
                </Text>
                <Text style={[bsStyles.doneStatValue, { color: colors.foreground }]}>
                  {shelfItems.length}
                </Text>
              </View>
              <View style={[bsStyles.doneStatDivider, { backgroundColor: colors.border }]} />
              <View style={bsStyles.doneStatRow}>
                <Text style={[bsStyles.doneStatLabel, { color: colors.mutedForeground }]}>
                  Assigned
                </Text>
                <Text style={[bsStyles.doneStatValue, { color: colors.success }]}>
                  {assignedCount}
                </Text>
              </View>
              {conflictItems.length > 0 ? (
                <>
                  <View style={[bsStyles.doneStatDivider, { backgroundColor: colors.border }]} />
                  <View style={bsStyles.doneStatRow}>
                    <Text style={[bsStyles.doneStatLabel, { color: colors.mutedForeground }]}>
                      Conflicts flagged
                    </Text>
                    <Text style={[bsStyles.doneStatValue, { color: colors.destructive }]}>
                      {conflictItems.length}
                    </Text>
                  </View>
                </>
              ) : null}
            </View>

            {conflictItems.length > 0 ? (
              <View
                style={[
                  bsStyles.doneConflictList,
                  {
                    backgroundColor: colors.destructive + "0c",
                    borderColor: colors.destructive + "33",
                  },
                ]}
              >
                <Text style={[bsStyles.doneConflictHeading, { color: colors.destructive }]}>
                  ⚠ Items with barcode conflicts
                </Text>
                {conflictItems.map(item => (
                  <Text
                    key={item.id}
                    style={[bsStyles.doneConflictItem, { color: colors.foreground }]}
                    numberOfLines={1}
                  >
                    · {item.catalog}{item.vendor ? ` — ${item.vendor}` : ""}
                  </Text>
                ))}
              </View>
            ) : null}

            <Pressable
              onPress={handleClose}
              style={[bsStyles.doneDoneBtn, { backgroundColor: colors.primary }]}
            >
              <Text style={[bsStyles.doneDoneBtnText, { color: colors.primaryForeground }]}>
                Done
              </Text>
            </Pressable>
          </Animated.View>
        ) : null}

        {/* ── Input step ───────────────────────────────────────────────────── */}
        {step === "input" ? (
          <ScrollView contentContainerStyle={bsStyles.inputScroll} keyboardShouldPersistTaps="handled">
            {sessionChecked && resumeSession ? (
              <View
                style={[
                  bsStyles.resumeBanner,
                  { backgroundColor: colors.primary + "18", borderColor: colors.primary + "44" },
                ]}
              >
                <Text style={[bsStyles.resumeTitle, { color: colors.foreground }]}>
                  Resume session: {resumeSession.shelfPrefix}
                </Text>
                <Text style={[bsStyles.resumeSub, { color: colors.mutedForeground }]}>
                  {Object.values(resumeSession.itemRowStates).filter(r => r.assignedBarcode).length}{" "}
                  assigned · {resumeSession.shelfItems.length} total items
                </Text>
                <View style={bsStyles.resumeBtns}>
                  <Pressable
                    onPress={() => applyResume(resumeSession)}
                    style={[bsStyles.resumeBtn, { backgroundColor: colors.primary }]}
                  >
                    <Text style={[bsStyles.resumeBtnText, { color: colors.primaryForeground }]}>
                      Resume
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={startFresh}
                    style={[
                      bsStyles.resumeBtn,
                      { backgroundColor: colors.muted, borderWidth: 1, borderColor: colors.border },
                    ]}
                  >
                    <Text style={[bsStyles.resumeBtnText, { color: colors.foreground }]}>
                      Start fresh
                    </Text>
                  </Pressable>
                </View>
              </View>
            ) : null}

            <View style={bsStyles.inputSection}>
              <Text style={[bsStyles.inputLabel, { color: colors.foreground }]}>
                Enter shelf prefix
              </Text>
              <Text style={[bsStyles.inputHint, { color: colors.mutedForeground }]}>
                All items binned to this shelf will be loaded for assignment.
              </Text>

              <KeyboardDoneInput
                style={[
                  bsStyles.input,
                  {
                    borderColor: colors.border,
                    backgroundColor: colors.muted,
                    color: colors.foreground,
                  },
                ]}
                placeholder="e.g. 16-37 or A-01"
                placeholderTextColor={colors.mutedForeground}
                value={shelfPrefix}
                onChangeText={raw => setShelfPrefix(formatShelfPrefix(raw))}
                autoCapitalize="characters"
                autoCorrect={false}
              />

              {inputPreviewStats && inputPreviewStats.total !== null && shelfPrefix.trim().length > 0 ? (
                <View
                  style={[
                    bsStyles.previewCard,
                    { backgroundColor: colors.card, borderColor: colors.border },
                  ]}
                >
                  <Text style={[bsStyles.previewCount, { color: colors.foreground }]}>
                    <Text style={{ fontFamily: "Inter_700Bold" }}>{inputPreviewStats.total}</Text>
                    <Text style={{ color: colors.mutedForeground }}> items on this shelf · </Text>
                    <Text style={{ fontFamily: "Inter_700Bold" }}>
                      {inputPreviewStats.withBarcode}
                    </Text>
                    <Text style={{ color: colors.mutedForeground }}> already have barcodes</Text>
                  </Text>
                </View>
              ) : null}

              {loadError ? (
                <View
                  style={[
                    bsStyles.errorRow,
                    {
                      backgroundColor: colors.destructive + "14",
                      borderColor: colors.destructive + "33",
                    },
                  ]}
                >
                  <Text style={[bsStyles.errorText, { color: colors.destructive }]}>
                    {loadError}
                  </Text>
                </View>
              ) : null}

              {prefixSuggestions.length > 0 ? (
                <View style={bsStyles.chips}>
                  {prefixSuggestions.map(bin => (
                    <Pressable
                      key={bin}
                      onPress={() => setShelfPrefix(bin)}
                      style={[
                        bsStyles.chip,
                        { backgroundColor: colors.accent, borderColor: colors.border },
                      ]}
                    >
                      <Text style={[bsStyles.chipText, { color: colors.foreground }]}>{bin}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}

              <Pressable
                onPress={() => { void handleLoadItems(); }}
                disabled={!shelfPrefix.trim() || loadingItems}
                style={[
                  bsStyles.loadBtn,
                  {
                    backgroundColor:
                      shelfPrefix.trim() && !loadingItems ? colors.primary : colors.muted,
                  },
                ]}
              >
                {loadingItems ? (
                  <ActivityIndicator color={colors.primaryForeground} size="small" />
                ) : (
                  <Text
                    style={[
                      bsStyles.loadBtnText,
                      {
                        color: shelfPrefix.trim()
                          ? colors.primaryForeground
                          : colors.mutedForeground,
                      },
                    ]}
                  >
                    Load Items
                  </Text>
                )}
              </Pressable>
            </View>
          </ScrollView>
        ) : step === "session" ? (
          /* ── Session step ─────────────────────────────────────────────── */
          <View style={bsStyles.sessionRoot}>
            {/* Progress bar */}
            <View style={[bsStyles.progressBarTrack, { backgroundColor: colors.border }]}>
              <View
                style={[
                  bsStyles.progressBarFill,
                  {
                    backgroundColor: progressPct === 100 ? colors.success : colors.primary,
                    width: `${progressPct}%` as any,
                  },
                ]}
              />
            </View>

            {/* Progress label + target indicator */}
            <View
              style={[
                bsStyles.progressLabelRow,
                { paddingHorizontal: 14, paddingTop: 6, paddingBottom: 4 },
              ]}
            >
              <Text style={[bsStyles.progressLabel, { color: colors.foreground }]}>
                <Text style={{ fontFamily: "Inter_700Bold" }}>{assignedCount}</Text>
                <Text style={{ color: colors.mutedForeground }}> / {shelfItems.length} assigned</Text>
              </Text>
              {targetItemId ? (
                <Pressable onPress={() => setTargetItemId(null)}>
                  <Text style={[bsStyles.targetLabel, { color: colors.primary }]}>
                    ⊙ {shelfItems.find(i => i.id === targetItemId)?.catalog ?? "—"}  ✕
                  </Text>
                </Pressable>
              ) : (
                <Text style={[bsStyles.targetLabel, { color: colors.mutedForeground }]}>
                  Auto → next unassigned
                </Text>
              )}
            </View>

            {/* Filter toggle */}
            <View style={[bsStyles.filterRow, { paddingHorizontal: 14, paddingBottom: 6 }]}>
              <Pressable
                onPress={() => setFilterUnassigned(prev => !prev)}
                style={[
                  bsStyles.filterToggle,
                  {
                    backgroundColor: filterUnassigned ? colors.primary : colors.muted,
                    borderColor: filterUnassigned ? colors.primary : colors.border,
                  },
                ]}
              >
                <Text
                  style={[
                    bsStyles.filterToggleText,
                    { color: filterUnassigned ? colors.primaryForeground : colors.mutedForeground },
                  ]}
                >
                  {filterUnassigned ? "⊘ Unassigned only" : "Show unassigned only"}
                </Text>
              </Pressable>
              {filterUnassigned ? (
                <Text style={[bsStyles.filterCount, { color: colors.mutedForeground }]}>
                  {filteredShelfItems.length} remaining
                </Text>
              ) : null}
            </View>

            {/* Item list */}
            <ScrollView style={bsStyles.itemList} contentContainerStyle={{ paddingBottom: 8 }} keyboardShouldPersistTaps="handled">
              {filteredShelfItems.map(item => {
                const row = itemRowStates[item.id];
                const hasExistingBarcode =
                  Array.isArray(item.barcodes) && item.barcodes.length > 0;
                const assignedBarcode = row?.assignedBarcode ?? null;
                const isDone = !!assignedBarcode || hasExistingBarcode;
                const isTargeted = targetItemId === item.id;
                const syncStatus = row?.syncStatus ?? null;
                const isConflict = !!row?.conflictBarcode;
                const isUndoing = undoingId === item.id;
                const isPendingSync = syncStatus === "pending" || assigningId === item.id || isUndoing;
                const isError = syncStatus === "error";
                const flash = row?.flash ?? false;

                let borderColor = colors.border;
                if (flash) borderColor = colors.success;
                else if (isTargeted) borderColor = colors.primary;
                else if (isConflict) borderColor = colors.destructive + "88";
                else if (isError) borderColor = colors.destructive + "66";

                let rowBg = colors.card;
                if (flash) rowBg = colors.success + "18";
                else if (isTargeted) rowBg = colors.primary + "10";
                else if (isConflict) rowBg = colors.destructive + "0c";

                const displayBarcodes = assignedBarcode
                  ? [assignedBarcode]
                  : hasExistingBarcode
                  ? item.barcodes
                  : [];

                return (
                  <Pressable
                    key={item.id}
                    onPress={() => {
                      if (isDone || isPendingSync) return;
                      setTargetItemId(prev => (prev === item.id ? null : item.id));
                    }}
                    style={[bsStyles.itemRow, { backgroundColor: rowBg, borderColor }]}
                  >
                    {item.imageUrl ? (
                      <Image
                        source={{ uri: item.imageUrl }}
                        style={bsStyles.thumbnail}
                        resizeMode="contain"
                      />
                    ) : (
                      <View
                        style={[
                          bsStyles.thumbnail,
                          {
                            backgroundColor: colors.muted,
                            alignItems: "center",
                            justifyContent: "center",
                          },
                        ]}
                      >
                        <Text style={{ fontSize: 16 }}>📦</Text>
                      </View>
                    )}

                    <View style={bsStyles.itemInfo}>
                      <Text
                        style={[bsStyles.itemCatalog, { color: colors.foreground }]}
                        numberOfLines={1}
                      >
                        {item.catalog}
                      </Text>
                      <Text
                        style={[bsStyles.itemVendor, { color: colors.mutedForeground }]}
                        numberOfLines={1}
                      >
                        {item.vendor}
                      </Text>
                      {item.binLocations && item.binLocations.length > 0 ? (
                        <Text
                          style={[bsStyles.itemBin, { color: colors.primary }]}
                          numberOfLines={1}
                        >
                          {item.binLocations.join(", ")}
                        </Text>
                      ) : null}
                      {displayBarcodes.length > 0 ? (
                        <Text
                          style={[bsStyles.itemBarcode, { color: colors.mutedForeground }]}
                          numberOfLines={1}
                        >
                          {displayBarcodes[0]}
                        </Text>
                      ) : null}
                      {isConflict ? (
                        <Text
                          style={[bsStyles.conflictText, { color: colors.destructive }]}
                          numberOfLines={2}
                        >
                          ⚠ Barcode in use by {row?.conflictOwner}
                        </Text>
                      ) : null}
                      {isError ? (
                        <Text style={[bsStyles.conflictText, { color: colors.destructive }]}>
                          ✕ Sync failed — aim camera again
                        </Text>
                      ) : null}
                    </View>

                    <View style={bsStyles.itemRight}>
                      {isPendingSync ? (
                        <ActivityIndicator size="small" color={colors.primary} />
                      ) : isDone ? (
                        <>
                          {assignedBarcode ? (
                            <Pressable
                              onPress={() => { void handleUndoAssignment(item, assignedBarcode); }}
                              style={[bsStyles.undoBtn, { backgroundColor: colors.destructive + "15", borderColor: colors.destructive + "33" }]}
                              hitSlop={4}
                            >
                              <Text style={[bsStyles.undoBtnText, { color: colors.destructive }]}>Undo</Text>
                            </Pressable>
                          ) : null}
                          <View style={[bsStyles.badge, { backgroundColor: colors.success + "22" }]}>
                            <Text style={[bsStyles.badgeText, { color: colors.success }]}>
                              ✓ Assigned
                            </Text>
                          </View>
                        </>
                      ) : isConflict ? (
                        <View
                          style={[bsStyles.badge, { backgroundColor: colors.destructive + "18" }]}
                        >
                          <Text style={[bsStyles.badgeText, { color: colors.destructive }]}>
                            Conflict
                          </Text>
                        </View>
                      ) : isTargeted ? (
                        <View style={[bsStyles.badge, { backgroundColor: colors.primary + "22" }]}>
                          <Text style={[bsStyles.badgeText, { color: colors.primary }]}>
                            ⊙ Target
                          </Text>
                        </View>
                      ) : (
                        <View style={[bsStyles.badge, { backgroundColor: colors.muted }]}>
                          <Text style={[bsStyles.badgeText, { color: colors.mutedForeground }]}>
                            Unassigned
                          </Text>
                        </View>
                      )}
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>

            {/* Camera strip */}
            <View style={[bsStyles.cameraSection, { borderTopColor: colors.border }]}>
              {!permission ? (
                <View style={bsStyles.cameraPermBox}>
                  <ActivityIndicator color={colors.primary} />
                </View>
              ) : !permission.granted ? (
                <View style={bsStyles.cameraPermBox}>
                  <Text style={[bsStyles.permText, { color: colors.foreground }]}>
                    Camera access required to scan barcodes.
                  </Text>
                  <Pressable
                    onPress={requestPermission}
                    style={[bsStyles.permBtn, { backgroundColor: colors.primary }]}
                  >
                    <Text style={[bsStyles.permBtnText, { color: colors.primaryForeground }]}>
                      Enable Camera
                    </Text>
                  </Pressable>
                </View>
              ) : !cameraStarted ? (
                <View style={bsStyles.cameraStartOverlay}>
                  <Pressable
                    onPress={() => {
                      lastScanRef.current = null;
                      setCameraStarted(true);
                    }}
                    style={[bsStyles.cameraStartBtn, { backgroundColor: colors.primary }]}
                  >
                    <Text style={[bsStyles.cameraStartBtnText, { color: colors.primaryForeground }]}>
                      📷 Start Camera
                    </Text>
                  </Pressable>
                  <Text style={[bsStyles.cameraStartHint, { color: colors.mutedForeground }]}>
                    Barcodes assign automatically on detection
                  </Text>
                </View>
              ) : (
                <>
                  <View
                    style={bsStyles.cameraWrapper}
                    onLayout={e => {
                      cameraViewSizeRef.current = e.nativeEvent.layout;
                    }}
                  >
                    <CameraView
                      style={StyleSheet.absoluteFill}
                      facing="back"
                      barcodeScannerSettings={{
                        barcodeTypes: [
                          "qr",
                          "ean13",
                          "ean8",
                          "code128",
                          "code39",
                          "pdf417",
                          "upc_a",
                          "upc_e",
                          "aztec",
                          "datamatrix",
                          "itf14",
                        ],
                      }}
                      onBarcodeScanned={handleBarcodeScanned}
                    />
                    <View
                      style={[bsStyles.viewfinderOverlay, { pointerEvents: "none" }]}
                    >
                      <View
                        style={[
                          bsStyles.viewfinderFrame,
                          {
                            borderColor:
                              assigningId !== null ? colors.success : colors.primary,
                          },
                        ]}
                      />
                    </View>
                    <View
                      style={[
                        bsStyles.scanStatusBar,
                        {
                          backgroundColor:
                            assigningId !== null
                              ? colors.primary + "cc"
                              : "rgba(0,0,0,0.45)",
                        },
                      ]}
                    >
                      {assigningId !== null ? (
                        <ActivityIndicator color="#fff" size="small" style={{ marginRight: 6 }} />
                      ) : null}
                      <Text style={bsStyles.scanStatusText}>
                        {assigningId !== null ? "Assigning…" : "Aim at a barcode to assign"}
                      </Text>
                    </View>
                    <Pressable
                      onPress={() => {
                        setCameraStarted(false);
                        lastScanRef.current = null;
                      }}
                      style={[bsStyles.cameraStopBtn, { backgroundColor: "rgba(0,0,0,0.55)" }]}
                      hitSlop={8}
                    >
                      <Text style={bsStyles.cameraStopText}>■ Stop</Text>
                    </Pressable>
                  </View>

                  <View style={[bsStyles.autoAssignBadge, { backgroundColor: colors.success + "18", borderColor: colors.success + "44" }]}>
                    <Text style={[bsStyles.autoAssignText, { color: colors.success }]}>
                      ⚡ Auto-assign on detect
                    </Text>
                    {targetItemId ? (
                      <Pressable onPress={() => setTargetItemId(null)} hitSlop={8}>
                        <Text style={[bsStyles.clearTargetText, { color: colors.primary }]}>
                          Clear target
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                </>
              )}
            </View>
          </View>
        ) : null}
        </DismissKeyboard>
      </SafeAreaView>
    </Modal>
  );
}

const bsStyles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  headerTitle: { fontSize: 17, fontFamily: "Inter_600SemiBold" },
  inputScroll: { padding: 16, gap: 0 },
  resumeBanner: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 14,
    gap: 4,
    marginBottom: 16,
  },
  resumeTitle: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  resumeSub: { fontSize: 12, fontFamily: "Inter_400Regular" },
  resumeBtns: { flexDirection: "row", gap: 8, marginTop: 10 },
  resumeBtn: { flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: "center" },
  resumeBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  inputSection: { gap: 10 },
  inputLabel: { fontSize: 15, fontFamily: "Inter_700Bold" },
  inputHint: { fontSize: 13, fontFamily: "Inter_400Regular", lineHeight: 18 },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  previewCard: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 2,
  },
  previewCount: { fontSize: 13, fontFamily: "Inter_400Regular" },
  previewNote: { fontSize: 11, fontFamily: "Inter_400Regular" },
  errorRow: { borderRadius: 8, borderWidth: 1, padding: 10 },
  errorText: { fontSize: 13, fontFamily: "Inter_500Medium", lineHeight: 18 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, borderWidth: 1 },
  chipText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  loadBtn: {
    paddingVertical: 13,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 48,
    marginTop: 4,
  },
  loadBtnText: { fontSize: 15, fontFamily: "Inter_700Bold" },
  sessionRoot: { flex: 1 },
  progressBarTrack: { height: 5, width: "100%" },
  progressBarFill: { height: 5, minWidth: 2 },
  progressLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  progressLabel: { fontSize: 13, fontFamily: "Inter_400Regular" },
  targetLabel: { fontSize: 12, fontFamily: "Inter_500Medium" },
  itemList: { flex: 1 },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 12,
    marginBottom: 8,
    borderRadius: 10,
    borderWidth: 1,
    padding: 10,
    gap: 10,
  },
  thumbnail: { width: 44, height: 44, borderRadius: 6 },
  itemInfo: { flex: 1, gap: 2 },
  itemCatalog: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  itemVendor: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  itemBin: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  itemBarcode: { fontSize: 10, fontFamily: "Inter_400Regular" },
  conflictText: { fontSize: 11, fontFamily: "Inter_500Medium", lineHeight: 15, marginTop: 2 },
  itemRight: { alignItems: "flex-end", gap: 4 },
  badge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  badgeText: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  undoBtn: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, borderWidth: 1 },
  undoBtnText: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  cameraSection: { borderTopWidth: 1 },
  cameraPermBox: { paddingHorizontal: 16, paddingVertical: 16, alignItems: "center", gap: 10 },
  permText: { fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center" },
  permBtn: { paddingHorizontal: 20, paddingVertical: 9, borderRadius: 8 },
  permBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  cameraStartOverlay: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    alignItems: "center",
    gap: 8,
  },
  cameraStartBtn: { paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10 },
  cameraStartBtnText: { fontSize: 15, fontFamily: "Inter_700Bold" },
  cameraStartHint: { fontSize: 12, fontFamily: "Inter_400Regular" },
  cameraWrapper: { height: 140, position: "relative", overflow: "hidden" },
  viewfinderOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  viewfinderFrame: { width: 200, height: 80, borderWidth: 2, borderRadius: 10 },
  scanStatusBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    paddingVertical: 6,
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
  },
  scanStatusText: { color: "#fff", fontSize: 13, fontFamily: "Inter_500Medium" },
  cameraStopBtn: {
    position: "absolute",
    top: 8,
    right: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
  },
  cameraStopText: { color: "#fff", fontSize: 12, fontFamily: "Inter_500Medium" },
  autoAssignBadge: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginHorizontal: 12,
    marginTop: 8,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
  },
  autoAssignText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  clearTargetText: { fontSize: 12, fontFamily: "Inter_500Medium" },
  doneSummary: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    paddingBottom: 32,
    gap: 16,
  },
  doneIconCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  doneCheckmark: { fontSize: 40, color: "#22c55e" },
  doneTitle: { fontSize: 22, fontFamily: "Inter_700Bold", textAlign: "center" },
  doneSubtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 4,
  },
  doneStat: {
    width: "100%",
    borderRadius: 12,
    borderWidth: 1,
    overflow: "hidden",
  },
  doneStatRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  doneStatDivider: { height: 1, marginHorizontal: 16 },
  doneStatLabel: { fontSize: 14, fontFamily: "Inter_400Regular" },
  doneStatValue: { fontSize: 14, fontFamily: "Inter_700Bold" },
  doneConflictList: {
    width: "100%",
    borderRadius: 10,
    borderWidth: 1,
    padding: 12,
    gap: 4,
  },
  doneConflictHeading: { fontSize: 13, fontFamily: "Inter_600SemiBold", marginBottom: 4 },
  doneConflictItem: { fontSize: 13, fontFamily: "Inter_400Regular", lineHeight: 18 },
  doneDoneBtn: {
    width: "100%",
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
    marginTop: 4,
  },
  doneDoneBtnText: { fontSize: 16, fontFamily: "Inter_700Bold" },
  filterRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  filterToggle: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  filterToggleText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  filterCount: { fontSize: 12, fontFamily: "Inter_400Regular" },
});
