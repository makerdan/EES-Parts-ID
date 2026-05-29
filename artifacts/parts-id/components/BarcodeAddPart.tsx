import React, { useState, useRef, useCallback, useEffect } from "react";
import {
  ActivityIndicator,
  Dimensions,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect } from "expo-router";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import * as Haptics from "expo-haptics";
import { Audio } from "expo-av";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/contexts/AppContext";
import {
  useUpdateItemBarcodes,
  useListInventory,
  getListInventoryQueryKey,
} from "@workspace/api-client-react";
import type { InventoryItem } from "@workspace/api-client-react";
import { upsertItemInBarcodeCache } from "@/utils/offlineBarcode";
import { resolveShelfAssign } from "@/utils/barcodeResolver";
import { useQueryClient } from "@tanstack/react-query";
import { CatalogPickerModal } from "@/components/CatalogPickerModal";

interface AssignmentEntry {
  barcode: string;
  item: InventoryItem;
}

type BulkQueueStatus = "pending" | "assigned" | "skipped";

interface BulkQueueEntry {
  barcode: string;
  status: BulkQueueStatus;
  skippedAt?: number;
}

type ShelfSession = {
  shelfPrefix: string;
  assignments: AssignmentEntry[];
  bulkQueue: BulkQueueEntry[];
  bulkMode: boolean;
};

const SHELF_SESSION_KEY = "parts_id_shelf_session_v1";

// ── Shelf prefix auto-formatter ────────────────────────────────────────────
// For all-numeric input, formats as XX-XX-XXX (up to 7 digits).
// Non-numeric (or mixed) input is passed through unchanged.
function formatShelfPrefix(raw: string): string {
  const stripped = raw.replace(/-/g, "");
  if (!/^\d*$/.test(stripped)) return raw;
  let result = stripped.slice(0, 2);
  if (stripped.length > 2) result += "-" + stripped.slice(2, 4);
  if (stripped.length > 4) result += "-" + stripped.slice(4, 7);
  return result;
}

// ── Sound helper ───────────────────────────────────────────────────────────
let chimeSound: Audio.Sound | null = null;

async function loadChime(): Promise<void> {
  try {
    if (chimeSound) return;
    const { sound } = await Audio.Sound.createAsync(
      require("../assets/sounds/scan-chime.wav"),
      { shouldPlay: false, volume: 0.7 },
    );
    chimeSound = sound;
  } catch {
    chimeSound = null;
  }
}

async function playChime(): Promise<void> {
  try {
    if (!chimeSound) await loadChime();
    if (!chimeSound) return;
    await chimeSound.setPositionAsync(0);
    await chimeSound.playAsync();
  } catch {
    // Non-fatal
  }
}

// ── Session persistence ────────────────────────────────────────────────────
async function saveShelfSession(session: ShelfSession): Promise<void> {
  try {
    await AsyncStorage.setItem(SHELF_SESSION_KEY, JSON.stringify(session));
  } catch { /* non-fatal */ }
}

async function loadShelfSession(): Promise<ShelfSession | null> {
  try {
    const raw = await AsyncStorage.getItem(SHELF_SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as ShelfSession;
  } catch {
    return null;
  }
}

async function clearShelfSession(): Promise<void> {
  try {
    await AsyncStorage.removeItem(SHELF_SESSION_KEY);
  } catch { /* non-fatal */ }
}

interface BarcodeAddPartProps {
  scrollY?: number;
}

export function BarcodeAddPart({ scrollY = 0 }: BarcodeAddPartProps) {
  "use no memo";
  const colors = useColors();
  const { isAdmin, settings, showToast } = useApp();
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
  const [assignments, setAssignments] = useState<AssignmentEntry[]>([]);

  // Bulk scan mode
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkQueue, setBulkQueue] = useState<BulkQueueEntry[]>([]);

  // Session resume banner
  const [resumeSession, setResumeSession] = useState<ShelfSession | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);

  const updateBarcodesMutation = useUpdateItemBarcodes();
  const { data: inventoryPage } = useListInventory({ limit: 500 });

  const allItems = React.useMemo(() => inventoryPage?.items ?? [], [inventoryPage]);

  // Keep a ref to allItems so undo callbacks always see the latest inventory
  // without being forced into the dependency array (which would re-create the
  // callback on every inventory poll).
  const allItemsRef = useRef<typeof allItems>(allItems);
  useEffect(() => { allItemsRef.current = allItems; }, [allItems]);

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
    loadChime().catch(() => {});
  }, []);

  // Check for a saved session on mount
  useEffect(() => {
    loadShelfSession().then(session => {
      if (session && session.shelfPrefix) {
        setResumeSession(session);
      }
      setSessionChecked(true);
    });
  }, []);

  // Persist session whenever it changes
  useEffect(() => {
    if (!shelfMode) return;
    saveShelfSession({ shelfPrefix, assignments, bulkQueue, bulkMode });
  }, [shelfMode, shelfPrefix, assignments, bulkQueue, bulkMode]);

  const clearPendingScan = useCallback(() => {
    pendingCommitRef.current = null;
    pendingCodeRef.current = null;
    setPendingCode(null);
  }, []);

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
      setAssignPicker(false);
      setScanError(null);
      try {
        const existing = item.barcodes ?? [];
        if (!existing.includes(scannedCode)) {
          const updated = await updateBarcodesMutation.mutateAsync({
            id: item.id,
            data: { barcodes: [...existing, scannedCode] },
          });
          const listKeyPrefix = getListInventoryQueryKey()[0];
          await queryClient.invalidateQueries({
            predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === listKeyPrefix,
          });
          await upsertItemInBarcodeCache(updated);
        }
        await triggerScanFeedback(settings.scanSound);
        setLastAssigned({ barcode: scannedCode, item });
        setScannedCode(null);
      } catch {
        setScanError("Could not assign barcode. Please try again.");
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
          const listKeyPrefix = getListInventoryQueryKey()[0];
          await queryClient.invalidateQueries({
            predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === listKeyPrefix,
          });
        }
        await triggerScanFeedback(settings.scanSound);
        // Only log undoable entries for genuinely new assignments to avoid
        // silently deleting pre-existing barcodes via Undo on no-op scans.
        if (result.wasNew) {
          setAssignments((prev) => [{ barcode: code, item: result.updatedItem }, ...prev]);
        }
        setShelfScannedCode(null);
        // Mark as assigned in bulk queue (keeps it visible with its status)
        setBulkQueue(prev =>
          prev.map(e => e.barcode === code ? { ...e, status: "assigned" as BulkQueueStatus } : e)
        );
      } catch {
        setScanError("Could not assign barcode. Please try again.");
        setShelfScannedCode(null);
      }
    },
    [shelfScannedCode, updateBarcodesMutation, queryClient, triggerScanFeedback, settings.scanSound],
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
        const listKeyPrefix = getListInventoryQueryKey()[0];
        await queryClient.invalidateQueries({
          predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === listKeyPrefix,
        });
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
    clearShelfSession();
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
    clearShelfSession();
  };

  const isCameraActive = !assignPicker && !shelfAssignPicker;
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
        <Pressable
          onPress={() => setCameraBypass(true)}
          style={[apStyles.permBtn, { backgroundColor: "transparent", borderWidth: 1, borderColor: colors.border, marginTop: 4 }]}
        >
          <Text style={[apStyles.permBtnText, { color: colors.mutedForeground }]}>Skip camera (dev only)</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View>
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
              onPress={() => { setResumeSession(null); clearShelfSession(); }}
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
          <TextInput
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
                <View style={[apStyles.statsBar, { backgroundColor: colors.border }]}>
                  <View style={[apStyles.statsBarFill, {
                    backgroundColor: colors.success,
                    width: `${Math.round((shelfStats.withBarcode / shelfStats.total) * 100)}%` as any,
                  }]} />
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
                <View style={[apStyles.statsBar, { backgroundColor: colors.border }]}>
                  <View style={[apStyles.statsBarFill, {
                    backgroundColor: colors.success,
                    width: `${Math.round((shelfStats.withBarcode / shelfStats.total) * 100)}%` as any,
                  }]} />
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
                  onBarcodeScanned={isCameraActive ? handleBarcodeScanned : undefined}
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
            const statusColor = isAssigned ? colors.success : colors.primary;
            const statusLabel = isAssigned ? "Assigned" : "Pending";
            return (
              <View
                key={entry.barcode}
                style={[apStyles.logRow, {
                  backgroundColor: colors.card,
                  borderColor: isAssigned ? colors.success + "44" : colors.border,
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
          <Text style={[apStyles.errorText, { color: colors.destructive }]}>{scanError}</Text>
          <Pressable onPress={() => setScanError(null)} hitSlop={8}>
            <Text style={{ color: colors.destructive, fontSize: 14 }}>✕</Text>
          </Pressable>
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
  errorText: { fontSize: 13, fontFamily: "Inter_500Medium", flex: 1 },
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
});
