import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQueryClient } from "@tanstack/react-query";
import type { InventoryItem } from "@workspace/api-client-react";
import {
  useListInventory,
  useUpdateItemBarcodes,
} from "@workspace/api-client-react";
import { type AudioPlayer,createAudioPlayer } from "expo-audio";
import { type BarcodeScanningResult,CameraView, useCameraPermissions } from "expo-camera";
import * as FileSystem from "expo-file-system/legacy";
import * as Haptics from "expo-haptics";
import { useFocusEffect } from "expo-router";
import React, { useCallback, useEffect,useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";

import { CatalogPickerModal } from "@/components/CatalogPickerModal";
import { KeyboardDoneInput } from "@/components/KeyboardDoneInput";
import { PartDetailsEditor } from "@/components/PartDetailsEditor";
import { PartPhotoPicker } from "@/components/PartPhotoPicker";
import { useApp } from "@/contexts/AppContext";
import { useColors } from "@/hooks/useColors";
import { API_BASE } from "@/utils/apiBase";
import { resolveShelfAssign } from "@/utils/barcodeResolver";
import { invalidateListCache } from "@/utils/editItemCache";
import { upsertItemInBarcodeCache } from "@/utils/offlineBarcode";

interface AssignmentEntry {
  barcode: string;
  item: InventoryItem;
}

type BulkQueueStatus = "pending" | "assigned" | "skipped" | "error";

interface BulkQueueEntry {
  barcode: string;
  status: BulkQueueStatus;
  skippedAt?: number;
  errorMsg?: string;
}

type ShelfSession = {
  shelfPrefix: string;
  assignments: Array<AssignmentEntry>;
  bulkQueue: Array<BulkQueueEntry>;
  bulkMode: boolean;
};

const SHELF_SESSION_KEY = "parts_id_shelf_session_v1";

/** Key owned by BulkShelfAssign — used only to detect an in-progress cross-flow session. */
const BULK_SHELF_ASSIGN_SESSION_KEY = "parts_id_bulk_shelf_session_v1";

// ── BulkShelfAssign cross-flow session validators ──────────────────────────
// Full nested validation mirrors BulkShelfAssign's own BulkSession shape so
// malformed or stale blobs — including those with corrupt nested entries —
// never produce a false cross-flow warning.

const BULK_ROW_SYNC_STATUSES: ReadonlySet<string> = new Set(["pending", "synced", "error"]);

function isValidCrossFlowInventoryItem(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const e = entry as Record<string, unknown>;
  return typeof e.id === "number" && typeof e.catalog === "string" && typeof e.vendor === "string";
}

function isValidCrossFlowItemRowState(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const e = entry as Record<string, unknown>;
  return (
    (e.assignedBarcode === null || typeof e.assignedBarcode === "string") &&
    (e.syncStatus === null || (typeof e.syncStatus === "string" && BULK_ROW_SYNC_STATUSES.has(e.syncStatus))) &&
    (e.conflictBarcode === null || typeof e.conflictBarcode === "string") &&
    (e.conflictOwner === null || typeof e.conflictOwner === "string") &&
    typeof e.flash === "boolean"
  );
}

/**
 * Full shape validation for a BulkShelfAssign session blob.
 * Validates outer structure, every shelfItems inventory entry, and every
 * itemRowStates row-state value so malformed nested data is rejected.
 */
function isActiveBulkShelfAssignSession(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (
    typeof v.shelfPrefix !== "string" || v.shelfPrefix.length === 0 ||
    !Array.isArray(v.shelfItems) ||
    typeof v.itemRowStates !== "object" || v.itemRowStates === null || Array.isArray(v.itemRowStates) ||
    (v.targetItemId !== null && typeof v.targetItemId !== "number")
  ) return false;
  if (!(v.shelfItems as Array<unknown>).every(isValidCrossFlowInventoryItem)) return false;
  if (!Object.values(v.itemRowStates as Record<string, unknown>).every(isValidCrossFlowItemRowState)) return false;
  return true;
}
function formatShelfPrefix(raw: string): string {
  const stripped = raw.replace(/-/g, "");
  if (!/^\d*$/.test(stripped)) return raw;
  let result = stripped.slice(0, 2);
  if (stripped.length > 2) result += "-" + stripped.slice(2, 4);
  if (stripped.length > 4) result += "-" + stripped.slice(4, 7);
  return result;
}

// ── Sound helper ───────────────────────────────────────────────────────────
// expo-audio (SDK 52+) replaces expo-av: players are created synchronously
// via createAudioPlayer() and expose play()/seekTo() directly.
let chimePlayer: AudioPlayer | null = null;

function loadChime(): void {
  if (chimePlayer) return;
  try {
    chimePlayer = createAudioPlayer(require("../assets/sounds/scan-chime.wav"));
    chimePlayer.volume = 0.7;
  } catch {
    chimePlayer = null;
  }
}

async function playChime(): Promise<void> {
  try {
    if (!chimePlayer) loadChime();
    if (!chimePlayer) return;
    chimePlayer.seekTo(0);
    chimePlayer.play();
  } catch {
    // Non-fatal
  }
}

// ── Session persistence ────────────────────────────────────────────────────
// Writes go through a serial promise-chain queue so a clear can never be
// overtaken by an in-flight save that was enqueued before it.
const BULK_QUEUE_STATUSES: ReadonlySet<string> = new Set(["pending", "assigned", "skipped", "error"]);

function isValidAssignmentEntry(entry: unknown): entry is AssignmentEntry {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.barcode === 'string' &&
    typeof e.item === 'object' && e.item !== null &&
    typeof (e.item as Record<string, unknown>).id === 'number'
  );
}

function isValidBulkQueueEntry(entry: unknown): entry is BulkQueueEntry {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.barcode === 'string' &&
    typeof e.status === 'string' && BULK_QUEUE_STATUSES.has(e.status) &&
    (e.skippedAt === undefined || (typeof e.skippedAt === 'number' && Number.isFinite(e.skippedAt))) &&
    (e.errorMsg === undefined || typeof e.errorMsg === 'string')
  );
}

function isValidShelfSession(value: unknown): value is ShelfSession {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.shelfPrefix === 'string' &&
    Array.isArray(v.assignments) && v.assignments.every(isValidAssignmentEntry) &&
    Array.isArray(v.bulkQueue) && v.bulkQueue.every(isValidBulkQueueEntry) &&
    typeof v.bulkMode === 'boolean'
  );
}


interface BarcodeAddPartProps {
  scrollY?: number;
}

export function BarcodeAddPart({ scrollY = 0 }: BarcodeAddPartProps) {
  "use no memo";
  const colors = useColors();
  const { isAdmin, adminToken, settings, showToast } = useApp();
  const queryClient = useQueryClient();

  const [permission, requestPermission] = useCameraPermissions();
  const [cameraBypass, setCameraBypass] = useState(false);
  const [cameraStarted, setCameraStarted] = useState(false);
  const cameraViewSizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });
  const cameraWrapperRef = useRef<View>(null);

  useFocusEffect(
    useCallback(() => {
      return () => {
        setCameraStarted(false);
      };
    }, []),
  );

  // Reset camera when the camera section scrolls off-screen
  useEffect(() => {
    if (!cameraStarted) return;
    const wrapper = cameraWrapperRef.current;
    if (!wrapper) return;
    wrapper.measure((_x, _y, _w, h, _pageX, pageY) => {
      const windowHeight = Dimensions.get("window").height;
      const isOffScreen = pageY + h < 0 || pageY > windowHeight;
      if (isOffScreen) {
        setCameraStarted(false);
      }
    });
  }, [cameraStarted, scrollY]);

  // Normal assign state
  const [scannedCode, setScannedCode] = useState<string | null>(null);
  const [assignPicker, setAssignPicker] = useState(false);
  const [lastAssigned, setLastAssigned] = useState<AssignmentEntry | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [conflictItem, setConflictItem] = useState<InventoryItem | null>(null);
  const [detailsItem, setDetailsItem] = useState<InventoryItem | null>(null);

  // Optional photo capture after assignment
  const [pendingPhotoItem, setPendingPhotoItem] = useState<InventoryItem | null>(null);
  const [pendingPhotoUri, setPendingPhotoUri] = useState<string | null>(null);
  const [pendingPhotoUri2, setPendingPhotoUri2] = useState<string | null>(null);
  const [photoUploading, setPhotoUploading] = useState(false);

  // Pending barcode — set when camera detects a barcode, cleared on commit or reset
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const pendingCodeRef = useRef<string | null>(null);
  const pendingCommitRef = useRef<(() => void) | null>(null);

  // Shelf mode state
  const [shelfMode, setShelfMode] = useState(false);
  const [shelfPrefix, setShelfPrefix] = useState("");
  const [shelfStep, setShelfStep] = useState<"pickshelf" | "scanning">("pickshelf");
  const [shelfScannedCode, setShelfScannedCode] = useState<string | null>(null);
  const [shelfAssignPicker, setShelfAssignPicker] = useState(false);
  const [assignments, setAssignments] = useState<Array<AssignmentEntry>>([]);

  // Bulk scan mode
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkQueue, setBulkQueue] = useState<Array<BulkQueueEntry>>([]);

  // Session resume banner
  const [resumeSession, setResumeSession] = useState<ShelfSession | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  /** True when BulkShelfAssign has an active session that would be silently orphaned. */
  const [otherFlowActive, setOtherFlowActive] = useState(false);
  /** True once the admin has dismissed the cross-flow warning for this mount. */
  const [crossFlowDismissed, setCrossFlowDismissed] = useState(false);

  const updateBarcodesMutation = useUpdateItemBarcodes();
  const { data: inventoryPage } = useListInventory({ limit: 500 });

  const allItems = React.useMemo(() => inventoryPage?.items ?? [], [inventoryPage]);

  // Keep a ref to allItems so undo callbacks always see the latest inventory
  // without being forced into the dependency array (which would re-create the
  // callback on every inventory poll).
  const allItemsRef = useRef<typeof allItems>(allItems);
  useEffect(() => { allItemsRef.current = allItems; }, [allItems]);

  // Serial write queue — ensures a clear can never be overtaken by an
  // in-flight save that was enqueued before it (F-036).
  const sessionWriteQueueRef = useRef<Promise<void>>(Promise.resolve());

  const allBinLocations = React.useMemo(() => {
    const set = new Set<string>();
    for (const item of allItems) {
      for (const bin of item.binLocations ?? []) {
        if (bin.trim()) set.add(bin.trim());
      }
    }
    return Array.from(set).sort();
  }, [allItems]);

  // Shelf completion stats
  const shelfStats = React.useMemo(() => {
    if (!shelfPrefix.trim()) return null;
    const prefix = shelfPrefix.trim().toUpperCase();
    const matching = allItems.filter(item =>
      item.binLocations?.some(b => b.toUpperCase().startsWith(prefix))
    );
    const withBarcode = matching.filter(item =>
      Array.isArray(item.barcodes) && item.barcodes.length > 0
    );
    return { total: matching.length, withBarcode: withBarcode.length };
  }, [shelfPrefix, allItems]);

  // Load chime on mount
  useEffect(() => {
    loadChime(); // synchronous; errors handled internally
  }, []);

  // Check for a saved session on mount; also cross-check for an active BulkShelfAssign session.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [rawSession, otherRaw] = await Promise.all([
          AsyncStorage.getItem(SHELF_SESSION_KEY).catch(() => null),
          AsyncStorage.getItem(BULK_SHELF_ASSIGN_SESSION_KEY).catch(() => null),
        ]);
        if (cancelled) return;

        // Detect when a session blob exists but is invalid/corrupt (F-050)
        if (rawSession) {
          let session: ShelfSession | null = null;
          try {
            const parsed: unknown = JSON.parse(rawSession);
            session = isValidShelfSession(parsed) ? parsed : null;
          } catch {
            session = null;
          }
          if (session?.shelfPrefix) {
            setResumeSession(session);
          } else if (session === null) {
            // Raw data existed but could not be parsed — surface to user (F-050)
            showToast("Previous session could not be restored.", "error");
          }
        }

        // Show cross-flow warning when the other flow has a valid, non-empty session.
        try {
          const other = otherRaw ? (JSON.parse(otherRaw) as unknown) : null;
          setOtherFlowActive(isActiveBulkShelfAssignSession(other));
        } catch {
          setOtherFlowActive(false);
        }
      } catch {
        // ignore unexpected errors — session state defaults to empty
      } finally {
        if (!cancelled) setSessionChecked(true);
      }
    })();
    return () => { cancelled = true; };
  }, [showToast]);

  // Enqueue a session write through the serial queue so saves cannot
  // overtake a clear that was issued after them (F-036).
  const enqueueSessionWrite = useCallback((action: () => Promise<void>) => {
    sessionWriteQueueRef.current = sessionWriteQueueRef.current
      .then(action)
      .catch(() => {
        showToast("Could not save session — progress may be lost if you restart the app.", "error");
      });
  }, [showToast]);

  // Enqueue a session clear through the same queue.
  // Clear failures surface a toast so the user knows stale session data may
  // reappear on the next launch (F-036).
  const enqueueSessionClear = useCallback(() => {
    sessionWriteQueueRef.current = sessionWriteQueueRef.current
      .then(() => AsyncStorage.removeItem(SHELF_SESSION_KEY))
      .catch(() => {
        showToast("Could not clear session — stale session data may reappear on the next launch.", "error");
      });
  }, [showToast]);

  // Persist session whenever it changes — queued so clears always win (F-036).
  useEffect(() => {
    if (!shelfMode) return;
    const snapshot = { shelfPrefix, assignments, bulkQueue, bulkMode };
    enqueueSessionWrite(() => AsyncStorage.setItem(SHELF_SESSION_KEY, JSON.stringify(snapshot)));
  }, [shelfMode, shelfPrefix, assignments, bulkQueue, bulkMode, enqueueSessionWrite]);

  const clearPendingScan = useCallback(() => {
    pendingCommitRef.current = null;
    pendingCodeRef.current = null;
    setPendingCode(null);
  }, []);

  const uploadPartPhoto = useCallback(async (itemId: number, uri: string, slot: 1 | 2 = 1) => {
    const base64 = await FileSystem.readAsStringAsync(uri, { encoding: "base64" });
    const res = await fetch(`${API_BASE}/inventory/${itemId}/photo`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ imageBase64: base64, mimeType: "image/jpeg", slot }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }
  }, [adminToken]);

  const handlePhotoSkip = useCallback(() => {
    setPendingPhotoItem(null);
    setPendingPhotoUri(null);
    setPendingPhotoUri2(null);
  }, []);

  const handlePhotoUpload = useCallback(async () => {
    if (!pendingPhotoItem) return;
    if (pendingPhotoUri || pendingPhotoUri2) {
      setPhotoUploading(true);
      const uploads: Array<Promise<void>> = [];
      if (pendingPhotoUri) uploads.push(uploadPartPhoto(pendingPhotoItem.id, pendingPhotoUri, 1));
      if (pendingPhotoUri2) uploads.push(uploadPartPhoto(pendingPhotoItem.id, pendingPhotoUri2, 2));
      const results = await Promise.allSettled(uploads);
      setPhotoUploading(false);
      if (results.some(r => r.status === "rejected")) {
        Alert.alert(
          "Photo upload failed",
          "The part was saved but one or more photos could not be uploaded. Check your connection and try again.",
          [{ text: "OK" }]
        );
        return;
      }
    }
    setPendingPhotoItem(null);
    setPendingPhotoUri(null);
    setPendingPhotoUri2(null);
  }, [pendingPhotoItem, pendingPhotoUri, pendingPhotoUri2, uploadPartPhoto]);

  const triggerScanFeedback = useCallback(async (soundEnabled: boolean) => {
    try {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch { /* non-fatal */ }
    if (soundEnabled) {
      await playChime();
    }
  }, []);

  const handleBarcodeScanned = useCallback(
    (result: BarcodeScanningResult) => {
      // Reject scans that originate outside the viewfinder square
      const { width: cw, height: ch } = cameraViewSizeRef.current;
      if (cw > 0 && ch > 0) {
        const VF_W = 200, VF_H = 100, MARGIN = 20;
        const vfL = (cw - VF_W) / 2 - MARGIN, vfT = (ch - VF_H) / 2 - MARGIN;
        const vfR = vfL + VF_W + MARGIN * 2,   vfB = vfT + VF_H + MARGIN * 2;
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

      // Same barcode already pending — no update needed
      if (pendingCodeRef.current === code) return;

      // New or different barcode in frame — update pending
      pendingCodeRef.current = code;
      setPendingCode(code);

      const doCommit = () => {
        pendingCommitRef.current = null;
        pendingCodeRef.current = null;
        setPendingCode(null);

        if (shelfMode && shelfStep === "scanning") {
          if (bulkMode) {
            // In bulk mode, add to queue without opening picker
            setBulkQueue(prev => prev.some(e => e.barcode === code) ? prev : [...prev, { barcode: code, status: "pending" as BulkQueueStatus }]);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
          } else {
            setShelfScannedCode(code);
            setShelfAssignPicker(true);
          }
          return;
        }

        setScannedCode(code);
        setAssignPicker(true);
      };
      pendingCommitRef.current = doCommit;
    },
    [shelfMode, shelfStep, bulkMode],
  );

  const captureNow = useCallback(() => {
    const commit = pendingCommitRef.current;
    if (!commit) return;
    // Trigger haptic feedback on button press
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    commit();
  }, []);

  const handleAssign = useCallback(
    async (item: InventoryItem) => {
      if (!scannedCode) return;
      const code = scannedCode;
      setAssignPicker(false);
      setScanError(null);
      try {
        const existing = item.barcodes ?? [];
        if (!existing.includes(code)) {
          const updated = await updateBarcodesMutation.mutateAsync({
            id: item.id,
            data: { barcodes: [...existing, code] },
          });
          await invalidateListCache({ queryClient });
          await upsertItemInBarcodeCache(updated);
        }
        await triggerScanFeedback(settings.scanSound);
        setLastAssigned({ barcode: code, item });
        setScannedCode(null);
        setPendingPhotoItem(item);
        setPendingPhotoUri(null);
      } catch (err) {
        const status = err instanceof Error && "status" in err
          ? (err as { status: number }).status
          : null;
        const isConflict = status === 409 ||
          (err instanceof Error && (err.message.includes("409") || err.message.toLowerCase().includes("conflict")));
        if (isConflict) {
          const conflicting = allItemsRef.current.find(
            i => i.id !== item.id && (i.barcodes ?? []).includes(code),
          );
          if (conflicting) {
            setConflictItem(conflicting);
            setScanError(
              `This barcode is already assigned to "${conflicting.catalog}" (${conflicting.vendor}). Unlink it there first.`,
            );
          } else {
            setConflictItem(null);
            setScanError(
              "This barcode is already assigned to another item. Unlink it there first.",
            );
          }
        } else {
          setConflictItem(null);
          setScanError("Could not assign barcode. Please try again.");
        }
      }
    },
    [scannedCode, updateBarcodesMutation, queryClient, triggerScanFeedback, settings.scanSound],
  );

  const handleShelfAssign = useCallback(
    async (item: InventoryItem) => {
      const code = shelfScannedCode;
      if (!code) return;
      setShelfAssignPicker(false);
      setScanError(null);
      try {
        const result = await resolveShelfAssign(
          code,
          item,
          (id, barcodes) => updateBarcodesMutation.mutateAsync({ id, data: { barcodes } }),
          upsertItemInBarcodeCache,
        );
        if (result.wasNew) {
          await invalidateListCache({ queryClient });
        }
        await triggerScanFeedback(settings.scanSound);
        // Only log undoable entries for genuinely new assignments to avoid
        // silently deleting pre-existing barcodes via Undo on no-op scans.
        if (result.wasNew) {
          setAssignments((prev) => [{ barcode: code, item: result.updatedItem }, ...prev]);
        }
        setShelfScannedCode(null);
        setPendingPhotoItem(result.wasNew ? result.updatedItem : item);
        setPendingPhotoUri(null);
        // Mark as assigned in bulk queue (keeps it visible with its status)
        setBulkQueue(prev =>
          prev.map(e => e.barcode === code ? { ...e, status: "assigned" as BulkQueueStatus } : e)
        );
      } catch (err) {
        const errorMsg =
          err instanceof Error ? err.message : "Could not assign barcode. Please try again.";
        if (bulkMode && code) {
          // Bulk mode: mark the queue item as failed so it shows an inline Retry row
          setBulkQueue(prev =>
            prev.some(e => e.barcode === code)
              ? prev.map(e =>
                  e.barcode === code
                    ? { ...e, status: "error" as BulkQueueStatus, errorMsg }
                    : e,
                )
              : [...prev, { barcode: code, status: "error" as BulkQueueStatus, errorMsg }],
          );
          showToast("Assignment failed — tap Retry on the item to try again.", "error");
        } else {
          // Non-bulk: surface the error inline and retain shelfScannedCode so the
          // admin can tap "Retry assignment" without re-scanning.
          setScanError("Could not assign barcode. Please try again.");
          // Do NOT clear shelfScannedCode — it is used by the Retry button below.
        }
      }
    },
    [bulkMode, shelfScannedCode, updateBarcodesMutation, queryClient, triggerScanFeedback, settings.scanSound, showToast],
  );

  const handleUndoAssignment = useCallback(
    async (entry: AssignmentEntry, index: number) => {
      try {
        // Use the freshest known barcodes from the query cache to avoid
        // clobbering barcodes added by other sessions since this assignment.
        const liveItem = allItemsRef.current.find(i => i.id === entry.item.id);
        const currentBarcodes = (liveItem ?? entry.item).barcodes ?? [];
        const newBarcodes = currentBarcodes.filter(b => b !== entry.barcode);
        const updated = await updateBarcodesMutation.mutateAsync({
          id: entry.item.id,
          data: { barcodes: newBarcodes },
        });
        await invalidateListCache({ queryClient });
        await upsertItemInBarcodeCache(updated);
        setAssignments(prev => prev.filter((_, i) => i !== index));
        showToast("Barcode assignment undone", "info");
      } catch {
        showToast("Could not undo assignment. Please try again.", "error");
      }
    },
    [updateBarcodesMutation, queryClient, showToast],
  );

  const assignNextFromQueue = useCallback(() => {
    const next = bulkQueue.find(e => e.status === "pending");
    if (!next) return;
    setShelfScannedCode(next.barcode);
    setShelfAssignPicker(true);
  }, [bulkQueue]);

  const skipQueueItem = useCallback((barcode: string) => {
    setBulkQueue(prev =>
      prev.map(e => e.barcode === barcode ? { ...e, status: "skipped" as BulkQueueStatus, skippedAt: Date.now() } : e)
    );
  }, []);

  const retryQueueItem = useCallback((barcode: string) => {
    setBulkQueue(prev => {
      const entry = prev.find(e => e.barcode === barcode);
      if (!entry) return prev;
      const without = prev.filter(e => e.barcode !== barcode);
      return [{ barcode: entry.barcode, status: "pending" as BulkQueueStatus }, ...without];
    });
  }, []);

  const clearSkippedItems = useCallback(() => {
    setBulkQueue(prev => prev.filter(e => e.status !== "skipped"));
  }, []);

  const applyResumeSession = useCallback((session: ShelfSession) => {
    setShelfMode(true);
    setShelfPrefix(session.shelfPrefix);
    setShelfStep("scanning");
    setAssignments(session.assignments);
    setBulkQueue(session.bulkQueue);
    setBulkMode(session.bulkMode);
    setResumeSession(null);
    clearPendingScan();
  }, [clearPendingScan]);

  const startShelfMode = () => {
    setShelfMode(true);
    setShelfStep("pickshelf");
    setShelfPrefix("");
    setAssignments([]);
    setBulkQueue([]);
    setBulkMode(false);
    setScannedCode(null);
    setLastAssigned(null);
    setResumeSession(null);
    clearPendingScan();
    enqueueSessionClear();
  };

  const exitShelfMode = () => {
    setShelfMode(false);
    setShelfStep("pickshelf");
    setShelfPrefix("");
    setShelfScannedCode(null);
    setShelfAssignPicker(false);
    setAssignments([]);
    setBulkQueue([]);
    setBulkMode(false);
    clearPendingScan();
    enqueueSessionClear();
  };

  const isCameraActive = !assignPicker && !shelfAssignPicker && !pendingPhotoItem;
  const canCapture = !!pendingCode && isCameraActive && cameraStarted;

  if (!permission) {
    return (
      <View style={[apStyles.permBox, { backgroundColor: colors.muted, borderColor: colors.border }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!permission.granted && !cameraBypass) {
    return (
      <View style={[apStyles.permBox, { backgroundColor: colors.muted, borderColor: colors.border }]}>
        <Text style={[apStyles.permText, { color: colors.foreground }]}>
          Camera access is required to scan barcodes.
        </Text>
        <Pressable
          onPress={requestPermission}
          style={[apStyles.permBtn, { backgroundColor: colors.primary }]}
        >
          <Text style={[apStyles.permBtnText, { color: colors.primaryForeground }]}>Enable Camera</Text>
        </Pressable>
        {__DEV__ ? (
          <Pressable
            onPress={() => setCameraBypass(true)}
            style={[apStyles.permBtn, { backgroundColor: "transparent", borderWidth: 1, borderColor: colors.border, marginTop: 4 }]}
          >
            <Text style={[apStyles.permBtnText, { color: colors.mutedForeground }]}>Skip camera (dev only)</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <View>
      {/* Cross-flow warning banner */}
      {sessionChecked && otherFlowActive && !crossFlowDismissed ? (
        <View style={[apStyles.resumeBanner, { backgroundColor: colors.warning + "18", borderColor: colors.warning + "44" }]}>
          <View style={apStyles.resumeBannerRow}>
            <Text style={[apStyles.resumeTitle, { color: colors.foreground, flex: 1 }]}>
              ℹ️ In-progress session in another flow
            </Text>
            <Pressable
              onPress={() => setCrossFlowDismissed(true)}
              hitSlop={8}
              accessibilityLabel="Dismiss cross-flow session warning"
              style={apStyles.crossFlowDismissBtn}
            >
              <Text style={[apStyles.crossFlowDismissBtnText, { color: colors.mutedForeground }]}>✕</Text>
            </Pressable>
          </View>
          <Text style={[apStyles.resumeSub, { color: colors.mutedForeground }]}>
            You have an in-progress shelf session in Bulk Assign by Shelf — open it to continue.
          </Text>
        </View>
      ) : null}

      {/* Resume session banner */}
      {sessionChecked && resumeSession && !shelfMode ? (
        <View style={[apStyles.resumeBanner, { backgroundColor: colors.primary + "18", borderColor: colors.primary + "44" }]}>
          <Text style={[apStyles.resumeTitle, { color: colors.foreground }]}>
            Resume shelf session: {resumeSession.shelfPrefix}
          </Text>
          <Text style={[apStyles.resumeSub, { color: colors.mutedForeground }]}>
            {resumeSession.assignments.length} assigned · {resumeSession.bulkQueue.filter(e => e.status === "pending").length} pending in queue
          </Text>
          <View style={apStyles.resumeBtns}>
            <Pressable
              onPress={() => applyResumeSession(resumeSession)}
              style={[apStyles.resumeBtn, { backgroundColor: colors.primary }]}
            >
              <Text style={[apStyles.resumeBtnText, { color: colors.primaryForeground }]}>Resume session</Text>
            </Pressable>
            <Pressable
              onPress={() => { setResumeSession(null); enqueueSessionClear(); }}
              style={[apStyles.resumeBtn, { backgroundColor: colors.muted, borderWidth: 1, borderColor: colors.border }]}
            >
              <Text style={[apStyles.resumeBtnText, { color: colors.foreground }]}>Start fresh</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {/* Section header */}
      <View style={apStyles.sectionHeader}>
        <Text style={[apStyles.sectionTitle, { color: colors.foreground }]}>
          {shelfMode
            ? shelfStep === "pickshelf"
              ? "Add by Shelf — Pick Shelf"
              : `Add by Shelf — ${shelfPrefix}`
            : "Scan to Assign Barcode"}
        </Text>
        <Text style={[apStyles.sectionSub, { color: colors.mutedForeground }]}>
          {shelfMode
            ? shelfStep === "pickshelf"
              ? "Enter a shelf prefix to scan barcodes on that shelf"
              : "Scan barcodes; each will be assigned to an item on this shelf"
            : "Scan any barcode and assign it to a catalog item"}
        </Text>
      </View>

      {/* Admin-only controls */}
      {isAdmin && !shelfMode ? (
        <View style={apStyles.shelfBtnRow}>
          <Pressable
            onPress={startShelfMode}
            style={[apStyles.shelfBtn, { backgroundColor: colors.accent, borderColor: colors.border }]}
          >
            <Text style={[apStyles.shelfBtnText, { color: colors.foreground }]}>+ Add by Shelf</Text>
          </Pressable>
        </View>
      ) : null}

      {shelfMode ? (
        <View style={apStyles.shelfBtnRow}>
          <Pressable
            onPress={exitShelfMode}
            style={[apStyles.shelfBtn, { backgroundColor: colors.destructive + "22", borderColor: colors.destructive + "44" }]}
          >
            <Text style={[apStyles.shelfBtnText, { color: colors.destructive }]}>✕ Exit Shelf Mode</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Shelf step 1: pick shelf prefix */}
      {shelfMode && shelfStep === "pickshelf" ? (
        <View style={{ paddingHorizontal: 16, gap: 10 }}>
          <KeyboardDoneInput
            style={[apStyles.shelfInput, { borderColor: colors.border, backgroundColor: colors.muted, color: colors.foreground }]}
            placeholder="Prefix: e.g. 16-37-80 or A-01"
            placeholderTextColor={colors.mutedForeground}
            value={shelfPrefix}
            onChangeText={(raw) => setShelfPrefix(formatShelfPrefix(raw))}
            autoCapitalize="characters"
            autoCorrect={false}
            keyboardType="default"
          />

          {/* Shelf completion stats */}
          {shelfStats && shelfPrefix.trim().length > 0 ? (
            <View style={[apStyles.statsRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[apStyles.statsText, { color: colors.foreground }]}>
                <Text style={{ fontFamily: "Inter_700Bold" }}>{shelfStats.withBarcode}</Text>
                <Text style={{ color: colors.mutedForeground }}> / {shelfStats.total} items have barcodes</Text>
              </Text>
              {shelfStats.total > 0 ? (
                <View style={[apStyles.statsBar, { backgroundColor: colors.border, flexDirection: "row" }]}>
                  <View style={[apStyles.statsBarFill, {
                    backgroundColor: colors.success,
                    flex: shelfStats.withBarcode,
                  }]} />
                  <View style={{ flex: shelfStats.total - shelfStats.withBarcode }} />
                </View>
              ) : null}
            </View>
          ) : null}

          {allBinLocations.filter(b => !shelfPrefix || b.toUpperCase().startsWith(shelfPrefix.toUpperCase())).slice(0, 6).map(bin => (
            <Pressable
              key={bin}
              onPress={() => setShelfPrefix(bin)}
              style={[apStyles.binChip, { backgroundColor: colors.accent, borderColor: colors.border }]}
            >
              <Text style={[apStyles.binChipText, { color: colors.foreground }]}>{bin}</Text>
            </Pressable>
          ))}
          <Pressable
            onPress={() => { if (shelfPrefix.trim()) setShelfStep("scanning"); }}
            disabled={!shelfPrefix.trim()}
            style={[apStyles.startBtn, { backgroundColor: shelfPrefix.trim() ? colors.primary : colors.muted }]}
          >
            <Text style={[apStyles.startBtnText, { color: shelfPrefix.trim() ? colors.primaryForeground : colors.mutedForeground }]}>
              Start Scanning
            </Text>
          </Pressable>
        </View>
      ) : null}

      {/* Scanning step: Bulk mode toggle + stats */}
      {shelfMode && shelfStep === "scanning" ? (
        <View style={{ paddingHorizontal: 16, paddingBottom: 8, gap: 8 }}>
          {/* Progress stats */}
          {shelfStats ? (
            <View style={[apStyles.statsRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[apStyles.statsText, { color: colors.foreground }]}>
                <Text style={{ fontFamily: "Inter_700Bold" }}>{shelfStats.withBarcode}</Text>
                <Text style={{ color: colors.mutedForeground }}> / {shelfStats.total} items have barcodes</Text>
              </Text>
              {shelfStats.total > 0 ? (
                <View style={[apStyles.statsBar, { backgroundColor: colors.border, flexDirection: "row" }]}>
                  <View style={[apStyles.statsBarFill, {
                    backgroundColor: colors.success,
                    flex: shelfStats.withBarcode,
                  }]} />
                  <View style={{ flex: shelfStats.total - shelfStats.withBarcode }} />
                </View>
              ) : null}
            </View>
          ) : null}

          {/* Bulk mode toggle */}
          <View style={[apStyles.bulkToggleRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={[apStyles.bulkToggleLabel, { color: colors.foreground }]}>Bulk Scan mode</Text>
              <Text style={[apStyles.bulkToggleHint, { color: colors.mutedForeground }]}>
                Queue scans; assign one at a time. Camera stays live.
              </Text>
            </View>
            <Switch
              value={bulkMode}
              onValueChange={setBulkMode}
              trackColor={{ false: colors.border, true: colors.primary }}
              thumbColor={bulkMode ? colors.primaryForeground : colors.mutedForeground}
            />
          </View>
        </View>
      ) : null}

      {/* Camera viewfinder */}
      {(!shelfMode || shelfStep === "scanning") ? (
        <View ref={cameraWrapperRef} style={apStyles.cameraWrapper} onLayout={(e) => { cameraViewSizeRef.current = e.nativeEvent.layout; }}>
          {!cameraStarted ? (
            <>
              <View style={[apStyles.camera, { backgroundColor: "#111" }]} />
              <View style={[StyleSheet.absoluteFillObject, { alignItems: "center", justifyContent: "center" }]}>
                <Pressable
                  onPress={() => setCameraStarted(true)}
                  style={[apStyles.cameraStartBtn, { backgroundColor: colors.primary }]}
                >
                  <Text style={[apStyles.cameraStartBtnText, { color: colors.primaryForeground }]}>Start</Text>
                </Pressable>
              </View>
            </>
          ) : (
            <>
              {!cameraBypass ? (
                <CameraView
                  style={apStyles.camera}
                  facing="back"
                  barcodeScannerSettings={{ barcodeTypes: ["qr", "ean13", "ean8", "upc_a", "upc_e", "code128", "code39", "code93", "codabar", "itf14", "datamatrix", "pdf417", "aztec"] }}
                  {...(isCameraActive ? { onBarcodeScanned: handleBarcodeScanned } : {})}
                />
              ) : (
                <View style={[apStyles.camera, { backgroundColor: colors.muted, alignItems: "center", justifyContent: "center" }]}>
                  <Text style={{ color: colors.mutedForeground, fontSize: 13, fontFamily: "Inter_400Regular" }}>📷 Camera bypassed (dev)</Text>
                </View>
              )}
              <View style={apStyles.viewfinderOverlay}>
                <View style={[apStyles.viewfinderFrame, { borderColor: canCapture ? colors.success : colors.primary }]} />
              </View>
              {canCapture ? (
                <View style={[apStyles.scanStatus, { backgroundColor: colors.success + "cc" }]}>
                  <Text style={apStyles.scanStatusText}>Barcode detected</Text>
                </View>
              ) : null}
              {shelfMode && shelfStep === "scanning" && bulkMode ? (
                <View style={[apStyles.bulkModeBadge, { backgroundColor: colors.primary }]}>
                  <Text style={[apStyles.bulkModeBadgeText, { color: colors.primaryForeground }]}>BULK</Text>
                </View>
              ) : null}
              <Pressable
                onPress={() => { clearPendingScan(); setCameraStarted(false); }}
                style={[apStyles.cameraStopBtn, { backgroundColor: "rgba(0,0,0,0.55)" }]}
                hitSlop={8}
              >
                <Text style={apStyles.cameraStopBtnText}>■ Stop</Text>
              </Pressable>
            </>
          )}
        </View>
      ) : null}

      {/* Scan button */}
      {(!shelfMode || shelfStep === "scanning") && isCameraActive && cameraStarted ? (
        <View style={apStyles.scanBtnRow}>
          <Pressable
            onPress={captureNow}
            disabled={!canCapture}
            style={[
              apStyles.scanBtn,
              { backgroundColor: canCapture ? colors.primary : colors.muted, borderColor: canCapture ? colors.primary : colors.border },
            ]}
          >
            <Text style={[apStyles.scanBtnText, { color: canCapture ? colors.primaryForeground : colors.mutedForeground }]}>
              {canCapture ? "⬤  Scan" : "Scan"}
            </Text>
          </Pressable>
          {canCapture ? (
            <Text style={[apStyles.scanBtnHint, { color: colors.mutedForeground }]}>
              {pendingCode}
            </Text>
          ) : (
            <Text style={[apStyles.scanBtnHint, { color: colors.mutedForeground }]}>
              Aim camera at a barcode, then tap Scan
            </Text>
          )}
        </View>
      ) : null}

      {/* Bulk queue list — pending and assigned only */}
      {shelfMode && shelfStep === "scanning" && bulkQueue.some(e => e.status !== "skipped") ? (
        <View style={{ paddingHorizontal: 16, paddingTop: 10 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <Text style={[apStyles.completedLabel, { color: colors.mutedForeground }]}>
              QUEUE ({bulkQueue.filter(e => e.status === "pending").length} pending)
            </Text>
            <Pressable
              onPress={assignNextFromQueue}
              disabled={!bulkQueue.some(e => e.status === "pending")}
              style={[apStyles.assignNextBtn, {
                backgroundColor: bulkQueue.some(e => e.status === "pending") ? colors.primary : colors.muted,
              }]}
            >
              <Text style={[apStyles.assignNextBtnText, {
                color: bulkQueue.some(e => e.status === "pending") ? colors.primaryForeground : colors.mutedForeground,
              }]}>
                Assign next
              </Text>
            </Pressable>
          </View>
          {bulkQueue.filter(e => e.status !== "skipped").map((entry) => {
            const isPending = entry.status === "pending";
            const isAssigned = entry.status === "assigned";
            const isError = entry.status === "error";
            const statusColor = isAssigned
              ? colors.success
              : isError
                ? colors.destructive
                : colors.primary;
            const statusLabel = isAssigned ? "Assigned" : isError ? "Failed" : "Pending";
            return (
              <View
                key={entry.barcode}
                style={[apStyles.logRow, {
                  backgroundColor: isError ? colors.destructive + "0d" : colors.card,
                  borderColor: isAssigned
                    ? colors.success + "44"
                    : isError
                      ? colors.destructive + "55"
                      : colors.border,
                }]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[apStyles.logBarcode, { color: colors.foreground, fontFamily: "Inter_500Medium", fontSize: 13 }]}>
                    {entry.barcode}
                  </Text>
                  <Text style={[apStyles.logVendor, { color: statusColor }]}>{statusLabel}</Text>
                </View>
                {isPending ? (
                  <>
                    <Pressable
                      onPress={() => {
                        setShelfScannedCode(entry.barcode);
                        setShelfAssignPicker(true);
                      }}
                      style={[apStyles.undoBtn, { backgroundColor: colors.primary + "18", borderColor: colors.primary + "44" }]}
                    >
                      <Text style={[apStyles.undoBtnText, { color: colors.primary }]}>Assign</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => skipQueueItem(entry.barcode)}
                      style={[apStyles.undoBtn, { backgroundColor: colors.muted, borderColor: colors.border, marginLeft: 4 }]}
                    >
                      <Text style={[apStyles.undoBtnText, { color: colors.mutedForeground }]}>Skip</Text>
                    </Pressable>
                  </>
                ) : isError ? (
                  <Pressable
                    onPress={() => {
                      setShelfScannedCode(entry.barcode);
                      setShelfAssignPicker(true);
                    }}
                    style={[apStyles.undoBtn, { backgroundColor: colors.destructive + "18", borderColor: colors.destructive + "44" }]}
                  >
                    <Text style={[apStyles.undoBtnText, { color: colors.destructive }]}>Retry</Text>
                  </Pressable>
                ) : (
                  <View style={[apStyles.logBadge, { backgroundColor: colors.success + "22" }]}>
                    <Text style={[apStyles.logBadgeText, { color: colors.success, fontSize: 11 }]}>✓</Text>
                  </View>
                )}
              </View>
            );
          })}
        </View>
      ) : null}

      {/* Error */}
      {scanError ? (
        <View style={[apStyles.errorBanner, { backgroundColor: colors.destructive + "14", borderColor: colors.destructive + "44" }]}>
          <View style={{ flex: 1, gap: 6 }}>
            <Text style={[apStyles.errorText, { color: colors.destructive }]}>{scanError}</Text>
            {conflictItem ? (
              <Pressable
                onPress={() => { setScanError(null); setDetailsItem(conflictItem); }}
                style={[apStyles.conflictViewBtn, { borderColor: colors.destructive + "55" }]}
              >
                <Text style={[apStyles.conflictViewBtnText, { color: colors.destructive }]}>
                  View {conflictItem.catalog} →
                </Text>
              </Pressable>
            ) : null}
            {/* Non-bulk shelf failure: offer a Retry button since the barcode was retained */}
            {shelfMode && shelfScannedCode && !conflictItem ? (
              <Pressable
                onPress={() => { setScanError(null); setShelfAssignPicker(true); }}
                style={[apStyles.conflictViewBtn, { borderColor: colors.destructive + "55" }]}
              >
                <Text style={[apStyles.conflictViewBtnText, { color: colors.destructive }]}>
                  Retry assignment →
                </Text>
              </Pressable>
            ) : null}
          </View>
          <Pressable
            onPress={() => {
              setScanError(null);
              setConflictItem(null);
              // Also clear the retained shelf code on manual dismiss
              if (shelfMode && !conflictItem) setShelfScannedCode(null);
            }}
            hitSlop={8}
          >
            <Text style={{ color: colors.destructive, fontSize: 14 }}>✕</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Optional photo step — shown after any assignment */}
      {pendingPhotoItem ? (
        <View style={[apStyles.photoStepCard, { backgroundColor: colors.card, borderColor: colors.primary + "44" }]}>
          <View style={apStyles.photoStepHeader}>
            <View style={{ flex: 1 }}>
              <Text style={[apStyles.photoStepTitle, { color: colors.foreground }]}>
                Photo for {pendingPhotoItem.catalog}
              </Text>
              <Text style={[apStyles.photoStepSub, { color: colors.mutedForeground }]}>
                Optional — snap a reference image or skip
              </Text>
            </View>
            <Pressable onPress={handlePhotoSkip} hitSlop={8}>
              <Text style={{ color: colors.mutedForeground, fontSize: 16 }}>✕</Text>
            </Pressable>
          </View>
          <PartPhotoPicker value={pendingPhotoUri} onChange={setPendingPhotoUri} slot={1} label="Box / Label" />
          <PartPhotoPicker value={pendingPhotoUri2} onChange={setPendingPhotoUri2} slot={2} label="Detail / Wire Frame" />
          <View style={apStyles.photoStepActions}>
            <Pressable
              onPress={handlePhotoSkip}
              style={[apStyles.photoSkipBtn, { borderColor: colors.border, backgroundColor: colors.muted }]}
            >
              <Text style={[apStyles.photoSkipBtnText, { color: colors.foreground }]}>Skip</Text>
            </Pressable>
            <Pressable
              onPress={handlePhotoUpload}
              disabled={(!pendingPhotoUri && !pendingPhotoUri2) || photoUploading}
              style={[apStyles.photoUploadBtn, { backgroundColor: (pendingPhotoUri || pendingPhotoUri2) && !photoUploading ? colors.primary : colors.muted, borderColor: (pendingPhotoUri || pendingPhotoUri2) && !photoUploading ? colors.primary : colors.border }]}
            >
              {photoUploading ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : (
                <Text style={[apStyles.photoUploadBtnText, { color: (pendingPhotoUri || pendingPhotoUri2) ? colors.primaryForeground : colors.mutedForeground }]}>
                  Upload Photo
                </Text>
              )}
            </Pressable>
          </View>
        </View>
      ) : null}

      {/* Last assigned (normal mode) */}
      {!shelfMode && lastAssigned ? (
        <View style={[apStyles.lastAssignedCard, { backgroundColor: colors.success + "15", borderColor: colors.success + "44" }]}>
          <Text style={[apStyles.lastAssignedLabel, { color: colors.success }]}>✓ Assigned</Text>
          <Text style={[apStyles.lastAssignedCatalog, { color: colors.foreground }]}>
            {lastAssigned.item.catalog}
            <Text style={{ color: colors.mutedForeground }}> · {lastAssigned.item.vendor}</Text>
          </Text>
          <Text style={[apStyles.lastAssignedBarcode, { color: colors.mutedForeground }]}>{lastAssigned.barcode}</Text>
        </View>
      ) : null}

      {/* Shelf assignments log */}
      {shelfMode && shelfStep === "scanning" && assignments.length > 0 ? (
        <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
          <Text style={[apStyles.completedLabel, { color: colors.mutedForeground }]}>
            COMPLETED ({assignments.length})
          </Text>
          {assignments.map((a, i) => (
            <View
              key={`${a.barcode}-${i}`}
              style={[apStyles.logRow, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <View style={{ flex: 1 }}>
                <Text style={[apStyles.logCatalog, { color: colors.foreground }]}>
                  {a.item.catalog}
                  <Text style={[apStyles.logVendor, { color: colors.mutedForeground }]}> · {a.item.vendor}</Text>
                </Text>
                <Text style={[apStyles.logBarcode, { color: colors.mutedForeground }]}>{a.barcode}</Text>
              </View>
              <Pressable
                onPress={() => handleUndoAssignment(a, i)}
                style={[apStyles.undoBtn, { backgroundColor: colors.destructive + "15", borderColor: colors.destructive + "33" }]}
              >
                <Text style={[apStyles.undoBtnText, { color: colors.destructive }]}>Undo</Text>
              </Pressable>
              <View style={[apStyles.logBadge, { backgroundColor: colors.success + "22" }]}>
                <Text style={[apStyles.logBadgeText, { color: colors.success }]}>✓</Text>
              </View>
            </View>
          ))}
        </View>
      ) : null}

      {/* Skipped barcodes section */}
      {shelfMode && shelfStep === "scanning" && bulkQueue.some(e => e.status === "skipped") ? (
        <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <Text style={[apStyles.completedLabel, { color: colors.mutedForeground }]}>
              SKIPPED ({bulkQueue.filter(e => e.status === "skipped").length})
            </Text>
            <Pressable
              onPress={clearSkippedItems}
              style={[apStyles.clearSkippedBtn, { borderColor: colors.border }]}
            >
              <Text style={[apStyles.clearSkippedBtnText, { color: colors.mutedForeground }]}>Clear skipped</Text>
            </Pressable>
          </View>
          {bulkQueue.filter(e => e.status === "skipped").map((entry) => {
            const timeLabel = entry.skippedAt
              ? new Date(entry.skippedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
              : "";
            return (
              <View
                key={entry.barcode}
                style={[apStyles.logRow, {
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                  opacity: 0.85,
                }]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[apStyles.logBarcode, { color: colors.foreground, fontFamily: "Inter_500Medium", fontSize: 13 }]}>
                    {entry.barcode}
                  </Text>
                  <Text style={[apStyles.logVendor, { color: colors.mutedForeground }]}>
                    {timeLabel ? `Skipped at ${timeLabel}` : "Skipped"}
                  </Text>
                </View>
                <Pressable
                  onPress={() => retryQueueItem(entry.barcode)}
                  style={[apStyles.undoBtn, { backgroundColor: colors.primary + "18", borderColor: colors.primary + "44" }]}
                >
                  <Text style={[apStyles.undoBtnText, { color: colors.primary }]}>Retry</Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      ) : null}

      {/* Assign picker modals */}
      <CatalogPickerModal
        visible={assignPicker}
        barcodeCode={scannedCode ?? ""}
        onAssign={handleAssign}
        onCancel={() => {
          setAssignPicker(false);
          setScannedCode(null);
          clearPendingScan();
        }}
      />

      <CatalogPickerModal
        visible={shelfAssignPicker}
        barcodeCode={shelfScannedCode ?? ""}
        shelfPrefix={shelfPrefix}
        onAssign={handleShelfAssign}
        onCancel={() => {
          setShelfAssignPicker(false);
          setShelfScannedCode(null);
          clearPendingScan();
        }}
      />

      <PartDetailsEditor
        item={detailsItem}
        adminToken={adminToken}
        onClose={() => setDetailsItem(null)}
      />
    </View>
  );
}

const apStyles = StyleSheet.create({
  permBox: {
    margin: 16,
    borderRadius: 12,
    borderWidth: 1,
    padding: 24,
    alignItems: "center",
    gap: 12,
  },
  permText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 20,
  },
  permBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
  },
  permBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  resumeBanner: {
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 10,
    borderWidth: 1,
    padding: 14,
    gap: 4,
  },
  resumeBannerRow: { flexDirection: "row", alignItems: "flex-start" },
  crossFlowDismissBtn: { marginLeft: 8, padding: 2 },
  crossFlowDismissBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  resumeTitle: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  resumeSub: { fontSize: 12, fontFamily: "Inter_400Regular" },
  resumeBtns: { flexDirection: "row", gap: 8, marginTop: 10 },
  resumeBtn: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 8,
    alignItems: "center",
  },
  resumeBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  sectionHeader: {
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 8,
    gap: 2,
  },
  sectionTitle: { fontSize: 15, fontFamily: "Inter_700Bold" },
  sectionSub: { fontSize: 12, fontFamily: "Inter_400Regular", lineHeight: 17 },
  shelfBtnRow: {
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  shelfBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    alignSelf: "flex-start",
  },
  shelfBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  shelfInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  statsRow: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
  },
  statsText: { fontSize: 13, fontFamily: "Inter_400Regular" },
  statsBar: {
    height: 4,
    borderRadius: 2,
    overflow: "hidden",
  },
  statsBarFill: {
    height: "100%",
    borderRadius: 2,
    minWidth: 2,
  },
  bulkToggleRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
  },
  bulkToggleLabel: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  bulkToggleHint: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 2 },
  binChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    alignSelf: "flex-start",
  },
  binChipText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  startBtn: {
    paddingVertical: 11,
    borderRadius: 8,
    alignItems: "center",
    marginTop: 4,
  },
  startBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  cameraWrapper: {
    marginHorizontal: 16,
    marginTop: 8,
    borderRadius: 16,
    overflow: "hidden",
    height: 220,
    position: "relative",
  },
  camera: { flex: 1, width: "100%", height: "100%" },
  viewfinderOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  viewfinderFrame: {
    width: 200,
    height: 100,
    borderWidth: 2,
    borderRadius: 8,
    opacity: 0.8,
  },
  scanStatus: {
    position: "absolute",
    bottom: 10,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
  },
  scanStatusText: { color: "#fff", fontSize: 13, fontFamily: "Inter_500Medium" },
  scanBtnRow: {
    marginHorizontal: 16,
    marginTop: 10,
    alignItems: "center",
    gap: 5,
  },
  scanBtn: {
    width: "100%",
    paddingVertical: 13,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  scanBtnText: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.3,
  },
  scanBtnHint: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
  },
  bulkModeBadge: {
    position: "absolute",
    top: 10,
    right: 10,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  bulkModeBadgeText: { fontSize: 11, fontFamily: "Inter_700Bold", letterSpacing: 1 },
  cameraStopBtn: {
    position: "absolute",
    top: 10,
    left: 10,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
  },
  cameraStopBtnText: { fontSize: 11, fontFamily: "Inter_700Bold", color: "#fff", letterSpacing: 0.5 },
  cameraStartBtn: {
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 10,
  },
  cameraStartBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  assignNextBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  assignNextBtnText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  errorBanner: {
    marginHorizontal: 16,
    marginTop: 10,
    borderRadius: 8,
    borderWidth: 1,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  errorText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  conflictViewBtn: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    alignSelf: "flex-start",
  },
  conflictViewBtnText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  lastAssignedCard: {
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 10,
    borderWidth: 1,
    padding: 12,
    gap: 2,
  },
  lastAssignedLabel: { fontSize: 11, fontFamily: "Inter_700Bold", letterSpacing: 0.5, textTransform: "uppercase" },
  lastAssignedCatalog: { fontSize: 14, fontFamily: "Inter_600SemiBold", marginTop: 2 },
  lastAssignedBarcode: { fontSize: 11, fontFamily: "Inter_400Regular" },
  completedLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  logRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 8,
    borderWidth: 1,
    padding: 10,
    marginBottom: 6,
    gap: 8,
  },
  logCatalog: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  logVendor: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 1 },
  logBarcode: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 2 },
  logBadge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  logBadgeText: { fontSize: 13, fontFamily: "Inter_700Bold" },
  undoBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
  },
  undoBtnText: { fontSize: 12, fontFamily: "Inter_500Medium" },
  clearSkippedBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
  },
  clearSkippedBtnText: { fontSize: 12, fontFamily: "Inter_500Medium" },
  photoStepCard: {
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 10,
    borderWidth: 1,
    padding: 14,
    gap: 12,
  },
  photoStepHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  photoStepTitle: { fontSize: 13, fontFamily: "Inter_700Bold" },
  photoStepSub: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 2 },
  photoStepActions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  photoSkipBtn: {
    flex: 1,
    borderRadius: 8,
    borderWidth: 1,
    paddingVertical: 10,
    alignItems: "center",
  },
  photoSkipBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  photoUploadBtn: {
    flex: 2,
    borderRadius: 8,
    borderWidth: 1,
    paddingVertical: 10,
    alignItems: "center",
  },
  photoUploadBtnText: { fontSize: 13, fontFamily: "Inter_700Bold" },
});
