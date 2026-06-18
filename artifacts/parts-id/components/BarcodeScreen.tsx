import React, { useState, useRef, useCallback } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { useColors } from "@/hooks/useColors";
import { useApp, type PinnedPart } from "@/contexts/AppContext";
import { PartDetailsEditor } from "@/components/PartDetailsEditor";
import { parseBin } from "@/lib/aisleHierarchy";
import {
  lookupByBarcode,
  useUpdateItemBarcodes,
} from "@workspace/api-client-react";
import { invalidateListCache } from "@/utils/editItemCache";
import { CatalogPickerModal } from "@/components/CatalogPickerModal";
import type { InventoryItem } from "@workspace/api-client-react";
import { lookupByBarcodeOffline, upsertItemInBarcodeCache, getFuseCacheSyncedAt, FUSE_SYNC_MAX_AGE_MS } from "@/utils/offlineBarcode";
import { resolveBarcodeCode } from "@/utils/barcodeResolver";
import { ResultCard } from "@/components/ResultCard";
import { useQueryClient } from "@tanstack/react-query";
import { useScanHistory } from "@/hooks/useScanHistory";
import type { ScanEntry } from "@/utils/scanHistory";
import { groupScansByDate } from "@/utils/scanHistory";
import { router } from "expo-router";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatStaleCacheWarning(syncedAt: number | null): string {
  if (syncedAt == null) return "Data may be outdated — sync time unknown";
  const diffMs = Date.now() - syncedAt;
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (days < 1) return "Data may be outdated — last synced today";
  if (days === 1) return "Data may be outdated — last synced 1 day ago";
  return `Data may be outdated — last synced ${days} days ago`;
}

function formatRelativeTime(isoString: string): string {
  const ts = new Date(isoString).getTime();
  if (isNaN(ts)) return "";
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

type ScanPhase = "idle" | "looking" | "found" | "notfound" | "offline_miss";

// ── Main Barcode Screen ────────────────────────────────────────────────────────
interface BarcodeScreenProps {
  /** When provided (modal mode) a "Close" button appears in the header. */
  onClose?: () => void;
}

export default function BarcodeScreen({ onClose }: BarcodeScreenProps = {}) {
  "use no memo";
  const colors = useColors();
  const { isAdmin, textFontScale, adminToken, setPinnedParts, showToast } = useApp();
  const queryClient = useQueryClient();

  const [permission, requestPermission] = useCameraPermissions();
  const [cameraBypass, setCameraBypass] = useState(false);
  const cameraViewSizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });

  // ── Scan state ───────────────────────────────────────────────────────────────
  const [scanPhase, setScanPhase] = useState<ScanPhase>("idle");
  const [scannedCode, setScannedCode] = useState<string | null>(null);
  const [matchedItem, setMatchedItem] = useState<InventoryItem | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [isOfflineMatch, setIsOfflineMatch] = useState(false);
  const [fuseSyncedAt, setFuseSyncedAt] = useState<number | null>(null);
  const [showAssignPicker, setShowAssignPicker] = useState(false);
  const [historyPreviewItem, setHistoryPreviewItem] = useState<InventoryItem | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [detailsItem, setDetailsItem] = useState<InventoryItem | null>(null);

  // Pending barcode — set when camera detects a barcode, cleared on commit or reset
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const pendingCodeRef = useRef<string | null>(null);
  const pendingCommitRef = useRef<(() => Promise<void>) | null>(null);

  const handleShowOnMap = useCallback((item: InventoryItem) => {
    const bins = item.binLocations ?? [];
    if (bins.length === 0) {
      showToast("No bin location assigned — add a bin to this item first.");
      return;
    }
    const newPins: Array<PinnedPart> = [];
    let firstParsed: ReturnType<typeof parseBin> | null = null;
    for (const bin of bins) {
      const parsed = parseBin(bin);
      if (parsed) {
        if (!firstParsed) firstParsed = parsed;
        newPins.push({ binCode: bin, label: item.catalog, aisleNum: parsed.aisle });
      }
    }
    if (!firstParsed) {
      showToast(`No map zone found for "${bins[0]}" — bin format not recognised.`);
      return;
    }
    setPinnedParts(newPins);
    setDetailsItem(null);
    if (onClose) onClose();
    router.navigate("/(tabs)/map");
  }, [showToast, setPinnedParts, onClose]);

  const updateBarcodesMutation = useUpdateItemBarcodes();
  const { history, addEntry, clear: clearHistory } = useScanHistory();

  const scanGroups = React.useMemo(() => groupScansByDate(history), [history]);

  const toggleGroup = useCallback((dateKey: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(dateKey)) {
        next.delete(dateKey);
      } else {
        next.add(dateKey);
      }
      return next;
    });
  }, []);

  // ── Pending scan helpers ──────────────────────────────────────────────────────
  const clearPendingScan = useCallback(() => {
    pendingCommitRef.current = null;
    pendingCodeRef.current = null;
    setPendingCode(null);
  }, []);

  // ── Scan handler ─────────────────────────────────────────────────────────────
  const handleBarcodeScanned = useCallback(
    (result: BarcodeScanningResult) => {
      const code = result.data;

      // Reject scans that originate outside the viewfinder square
      const { width: cw, height: ch } = cameraViewSizeRef.current;
      if (cw > 0 && ch > 0) {
        const VF_W = 200, VF_H = 120, MARGIN = 20;
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

      // Already processing a scan — ignore new detections
      if (scanPhase !== "idle") return;

      // Same barcode already pending — no update needed
      if (pendingCodeRef.current === code) return;

      // New or different barcode in frame — update pending
      pendingCodeRef.current = code;
      setPendingCode(code);

      const doCommit = async () => {
        pendingCommitRef.current = null;
        pendingCodeRef.current = null;
        setPendingCode(null);

        if (code === scannedCode) return;

        setScannedCode(code);
        setScanPhase("looking");
        setScanError(null);
        setMatchedItem(null);
        setIsOfflineMatch(false);

        const resolution = await resolveBarcodeCode(code);
        if (resolution.phase === "found") {
          setMatchedItem(resolution.item);
          setScanPhase("found");
          if (!resolution.isOffline) {
            addEntry({
              barcode: code,
              found: true,
              itemId: resolution.item.id,
              catalog: resolution.item.catalog,
              vendor: resolution.item.vendor,
              timestamp: new Date().toISOString(),
            });
          } else {
            setIsOfflineMatch(true);
            getFuseCacheSyncedAt().then(setFuseSyncedAt).catch(() => setFuseSyncedAt(null));
          }
        } else if (resolution.phase === "notfound") {
          setScanPhase("notfound");
          addEntry({ barcode: code, found: false, timestamp: new Date().toISOString() });
        } else if (resolution.phase === "offline_miss") {
          setScanPhase("offline_miss");
        } else {
          setScanError(resolution.message);
          setScanPhase("idle");
        }
      };
      pendingCommitRef.current = doCommit;
    },
    [scannedCode, addEntry, scanPhase],
  );

  const captureNow = useCallback(() => {
    const commit = pendingCommitRef.current;
    if (!commit) return;
    void commit();
  }, []);

  const handleRecentTap = useCallback(async (entry: ScanEntry) => {
    if (!entry.found) return;
    const offlineItem = await lookupByBarcodeOffline(entry.barcode);
    if (offlineItem) {
      setHistoryPreviewItem(offlineItem);
      return;
    }
    try {
      const item = await lookupByBarcode(encodeURIComponent(entry.barcode));
      setHistoryPreviewItem(item);
    } catch {
      // Item may have been deleted or is unreachable — nothing to show
    }
  }, []);

  const resetScan = () => {
    clearPendingScan();
    setScannedCode(null);
    setMatchedItem(null);
    setScanPhase("idle");
    setScanError(null);
    setIsOfflineMatch(false);
    setFuseSyncedAt(null);
  };

  // ── Assign barcode to unrecognised scan ──────────────────────────────────────
  const handleAssign = useCallback(
    async (item: InventoryItem) => {
      if (!scannedCode) return;
      setShowAssignPicker(false);
      try {
        const existing = item.barcodes ?? [];
        if (!existing.includes(scannedCode)) {
          const updated = await updateBarcodesMutation.mutateAsync({
            id: item.id,
            data: { barcodes: [...existing, scannedCode] },
          });
          await invalidateListCache({ queryClient });
          await upsertItemInBarcodeCache(updated);
          setMatchedItem(updated);
        }
        setScanPhase("found");
        setMatchedItem((prev) => prev ?? item);
      } catch {
        setScanError("Could not assign barcode. Please try again.");
      }
    },
    [scannedCode, updateBarcodesMutation, queryClient],
  );

  // ── Permission gate ──────────────────────────────────────────────────────────
  if (!permission) {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (!permission.granted && !cameraBypass) {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>Barcode</Text>
          <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>Scan barcodes to look up parts</Text>
        </View>
        <View style={styles.center}>
          <Text style={[styles.permText, { color: colors.foreground }]}>Camera access is required for barcode scanning.</Text>
          <Pressable
            onPress={requestPermission}
            style={[styles.permBtn, { backgroundColor: colors.primary }]}
          >
            <Text style={[styles.permBtnText, { color: colors.primaryForeground }]}>Allow Camera Access</Text>
          </Pressable>
          <Pressable
            onPress={() => setCameraBypass(true)}
            style={[styles.permBtn, { backgroundColor: "transparent", borderWidth: 1, borderColor: colors.border, marginTop: 8 }]}
          >
            <Text style={[styles.permBtnText, { color: colors.mutedForeground }]}>Skip camera (dev only)</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const isCameraActive = !showAssignPicker;
  const canCapture = scanPhase === "idle" && !!pendingCode;

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      {/* Header */}
      {onClose ? (
        <View style={[styles.backBar, { borderBottomColor: colors.border }]}>
          <Pressable onPress={onClose} style={styles.backBtn} hitSlop={8}>
            <Text style={[styles.backBtnText, { color: colors.primary }]}>‹ Back to Photo ID</Text>
          </Pressable>
        </View>
      ) : null}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>Barcode</Text>
          <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>Scan a barcode to look up parts</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 120 }} keyboardShouldPersistTaps="handled">
        {/* ── Camera viewfinder ──────────────────────────────────────────────── */}
        <View style={styles.cameraWrapper} onLayout={(e) => { cameraViewSizeRef.current = e.nativeEvent.layout; }}>
            {isCameraActive && !cameraBypass ? (
              <CameraView
                style={styles.camera}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ["qr", "ean13", "ean8", "code128", "code39", "pdf417", "upc_a", "upc_e", "aztec", "datamatrix", "itf14"] }}
                onBarcodeScanned={handleBarcodeScanned}
              />
            ) : (
              <View style={[styles.camera, { backgroundColor: colors.muted, alignItems: "center", justifyContent: "center" }]}>
                <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>
                  {cameraBypass ? "📷 Camera bypassed (dev)" : "Camera paused"}
                </Text>
              </View>
            )}

            {/* Viewfinder overlay */}
            <View style={[styles.viewfinderOverlay, { pointerEvents: "none" }]}>
              <View style={[styles.viewfinderFrame, { borderColor: canCapture ? colors.success : colors.primary }]} />
            </View>

            {/* Scanning status indicator */}
            {scanPhase === "looking" ? (
              <View style={[styles.scanStatus, { backgroundColor: colors.primary + "cc" }]}>
                <ActivityIndicator color="#fff" size="small" />
                <Text style={styles.scanStatusText}>Looking up…</Text>
              </View>
            ) : canCapture ? (
              <View style={[styles.scanStatus, { backgroundColor: colors.success + "cc" }]}>
                <Text style={styles.scanStatusText}>Barcode detected — tap Scan</Text>
              </View>
            ) : scanPhase === "idle" ? (
              <View style={[styles.scanStatus, { backgroundColor: "rgba(0,0,0,0.53)" }]}>
                <Text style={styles.scanStatusText}>Aim camera at a barcode</Text>
              </View>
            ) : null}
          </View>

        {/* ── Scan button ────────────────────────────────────────────────────── */}
        {scanPhase === "idle" ? (
          <View style={styles.scanBtnRow}>
            <Pressable
              onPress={captureNow}
              disabled={!canCapture}
              style={[
                styles.scanBtn,
                { backgroundColor: canCapture ? colors.primary : colors.muted, borderColor: canCapture ? colors.primary : colors.border },
              ]}
            >
              <Text style={[styles.scanBtnText, { color: canCapture ? colors.primaryForeground : colors.mutedForeground }]}>
                {canCapture ? "⬤  Scan" : "Scan"}
              </Text>
            </Pressable>
            {canCapture ? (
              <Text style={[styles.scanBtnHint, { color: colors.mutedForeground }]}>
                {pendingCode}
              </Text>
            ) : null}
          </View>
        ) : null}

        {/* ── Admin Action Log ────────────────────────────────────────────────── */}
        {isAdmin && history.some((e) => !!e.adminAction) ? (
          <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
            <Text style={[styles.sectionLabel, { color: colors.mutedForeground, marginBottom: 8 }]}>
              ADMIN ACTION LOG
            </Text>
            {history
              .filter((e) => !!e.adminAction)
              .map((entry, idx) => (
                <Pressable
                  key={`admin-${entry.barcode}-${idx}`}
                  onPress={() => handleRecentTap(entry)}
                  style={({ pressed }) => [
                    styles.recentRow,
                    {
                      backgroundColor: pressed ? colors.muted : colors.card,
                      borderColor: entry.adminAction === "created" ? colors.primary + "55" : colors.success + "55",
                    },
                  ]}
                >
                  <View style={[
                    styles.adminActionIcon,
                    { backgroundColor: entry.adminAction === "created" ? colors.primary + "18" : colors.success + "18" },
                  ]}>
                    <Text style={{ fontSize: 14, color: entry.adminAction === "created" ? colors.primary : colors.success }}>
                      {entry.adminAction === "created" ? "+" : "⇢"}
                    </Text>
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    {entry.catalog ? (
                      <Text style={[styles.recentCatalog, { color: colors.foreground }]}>
                        {entry.catalog}
                        {entry.vendor ? (
                          <Text style={[styles.recentVendor, { color: colors.mutedForeground }]}> · {entry.vendor}</Text>
                        ) : null}
                      </Text>
                    ) : null}
                    <Text style={[styles.recentBarcode, { color: colors.mutedForeground }]}>{entry.barcode}</Text>
                  </View>
                  <View style={{ alignItems: "flex-end", gap: 4 }}>
                    <Text style={[styles.recentTime, { color: colors.mutedForeground }]}>{formatRelativeTime(entry.timestamp)}</Text>
                    <View style={[
                      styles.recentBadge,
                      { backgroundColor: entry.adminAction === "created" ? colors.primary + "18" : colors.success + "18" },
                    ]}>
                      <Text style={[
                        styles.recentBadgeText,
                        { color: entry.adminAction === "created" ? colors.primary : colors.success },
                      ]}>
                        {entry.adminAction}
                      </Text>
                    </View>
                  </View>
                  <Text style={[styles.recentChevron, { color: colors.mutedForeground }]}>›</Text>
                </Pressable>
              ))}
          </View>
        ) : null}

        {/* ── Recents ────────────────────────────────────────────────────────── */}
        {history.length > 0 ? (
          <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
            <View style={styles.recentsHeader}>
              <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>RECENT SCANS</Text>
              <Pressable onPress={clearHistory} style={[styles.clearBtn, { borderColor: colors.border }]}>
                <Text style={[styles.clearBtnText, { color: colors.mutedForeground }]}>Clear history</Text>
              </Pressable>
            </View>
            {scanGroups.map((group) => {
              const isCollapsed = collapsedGroups.has(group.dateKey);
              return (
                <View key={group.dateKey}>
                  {/* Date group header */}
                  <Pressable
                    onPress={() => toggleGroup(group.dateKey)}
                    style={[styles.groupHeader, { borderColor: colors.border }]}
                  >
                    <Text style={[styles.groupLabel, { color: colors.mutedForeground }]}>
                      {group.label.toUpperCase()}
                    </Text>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <Text style={[styles.groupCount, { color: colors.mutedForeground }]}>
                        {group.entries.length}
                      </Text>
                      <Text style={[styles.groupChevron, { color: colors.mutedForeground }]}>
                        {isCollapsed ? "›" : "⌄"}
                      </Text>
                    </View>
                  </Pressable>

                  {/* Group entries */}
                  {!isCollapsed && group.entries.map((entry, idx) => (
                    <Pressable
                      key={`${entry.barcode}-${idx}`}
                      onPress={() => handleRecentTap(entry)}
                      disabled={!entry.found}
                      style={({ pressed }) => [
                        styles.recentRow,
                        {
                          backgroundColor: pressed && entry.found ? colors.muted : colors.card,
                          borderColor: colors.border,
                        },
                      ]}
                    >
                      <View style={{ flex: 1, gap: 2 }}>
                        {entry.found && entry.catalog ? (
                          <Text style={[styles.recentCatalog, { color: colors.foreground }]}>
                            {entry.catalog}
                            {entry.vendor ? (
                              <Text style={[styles.recentVendor, { color: colors.mutedForeground }]}> · {entry.vendor}</Text>
                            ) : null}
                          </Text>
                        ) : (
                          <Text style={[styles.recentCatalog, { color: colors.mutedForeground }]}>Unassigned</Text>
                        )}
                        <Text style={[styles.recentBarcode, { color: colors.mutedForeground }]}>{entry.barcode}</Text>
                      </View>
                      <View style={{ alignItems: "flex-end", gap: 4 }}>
                        <Text style={[styles.recentTime, { color: colors.mutedForeground }]}>{formatRelativeTime(entry.timestamp)}</Text>
                        {entry.adminAction ? (
                          <View style={[styles.recentBadge, {
                            backgroundColor: entry.adminAction === "created" ? colors.primary + "18" : colors.success + "18",
                          }]}>
                            <Text style={[styles.recentBadgeText, {
                              color: entry.adminAction === "created" ? colors.primary : colors.success,
                            }]}>
                              {entry.adminAction}
                            </Text>
                          </View>
                        ) : (
                          <View style={[styles.recentBadge, { backgroundColor: entry.found ? colors.success + "22" : colors.muted }]}>
                            <Text style={[styles.recentBadgeText, { color: entry.found ? colors.success : colors.mutedForeground }]}>
                              {entry.found ? "found" : "unassigned"}
                            </Text>
                          </View>
                        )}
                      </View>
                      {entry.found ? (
                        <Text style={[styles.recentChevron, { color: colors.mutedForeground }]}>›</Text>
                      ) : null}
                    </Pressable>
                  ))}
                </View>
              );
            })}
          </View>
        ) : null}

        {/* ── Error banner ───────────────────────────────────────────────────── */}
        {scanError ? (
          <View style={[styles.errorBanner, { backgroundColor: colors.destructive + "15", borderColor: colors.destructive + "44" }]}>
            <Text style={[styles.errorText, { color: colors.destructive }]}>⚠ {scanError}</Text>
            <Pressable onPress={() => setScanError(null)}>
              <Text style={{ color: colors.destructive, fontSize: 14 }}>✕</Text>
            </Pressable>
          </View>
        ) : null}

        {/* ── Offline + no cache hit ─────────────────────────────────────────── */}
        {scanPhase === "offline_miss" ? (
          <View style={[styles.offlineMissCard, { backgroundColor: colors.warning + "18", borderColor: colors.warning + "55" }]}>
            <View style={styles.offlineMissHeader}>
              <Text style={[styles.offlineMissIcon, { color: colors.warning }]}>⚡</Text>
              <Text style={[styles.offlineMissTitle, { color: colors.warning }]}>No connection — barcode not cached</Text>
            </View>
            <Text style={[styles.offlineMissBody, { color: colors.foreground }]}>
              This barcode isn{"'"}t in your local cache. Connect to the network and the next scan will look it up and save it for offline use.
            </Text>
            {scannedCode ? (
              <Text style={[styles.offlineMissCode, { color: colors.mutedForeground }]}>
                Code: {scannedCode}
              </Text>
            ) : null}
            <Pressable onPress={resetScan} style={[styles.offlineMissBtn, { borderColor: colors.warning + "88" }]}>
              <Text style={[styles.offlineMissBtnText, { color: colors.warning }]}>↩ Scan Again</Text>
            </Pressable>
          </View>
        ) : null}

        {/* ── Found result ──────────────────────────────────────────────────── */}
        {scanPhase === "found" && matchedItem ? (
          <View style={{ padding: 16 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>SCAN RESULT</Text>
                {isOfflineMatch ? (
                  <View style={[styles.offlineBadge, { backgroundColor: colors.warning + "22" }]}>
                    <Text style={[styles.offlineBadgeText, { color: colors.warning }]}>OFFLINE</Text>
                  </View>
                ) : null}
              </View>
              <Pressable onPress={resetScan} style={[styles.rescanBtn, { borderColor: colors.border }]}>
                <Text style={[styles.rescanText, { color: colors.foreground }]}>↩ Scan Again</Text>
              </Pressable>
            </View>
            <Text style={[styles.scannedCode, { color: colors.mutedForeground }]}>
              Code: {scannedCode}
            </Text>
            <ResultCard
              result={{ item: matchedItem, confidence: 1.0, matchReason: isOfflineMatch ? "offline match" : "barcode match", seriesBase: null, seriesLabel: null, variants: [] }}
              onEditItem={isAdmin ? (item) => setDetailsItem(item) : undefined}
              rank={0}
              fontScale={textFontScale}
            />
            {isOfflineMatch && (fuseSyncedAt == null || Date.now() - fuseSyncedAt > FUSE_SYNC_MAX_AGE_MS) ? (
              <View style={[styles.staleCacheNote, { backgroundColor: colors.warning + "15", borderColor: colors.warning + "44" }]}>
                <Text style={[styles.staleCacheNoteText, { color: colors.warning }]}>
                  ⚠ {formatStaleCacheWarning(fuseSyncedAt)}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {/* ── Not found ─────────────────────────────────────────────────────── */}
        {scanPhase === "notfound" && scannedCode ? (
          <View style={{ padding: 16 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>NOT FOUND</Text>
              <Pressable onPress={resetScan} style={[styles.rescanBtn, { borderColor: colors.border }]}>
                <Text style={[styles.rescanText, { color: colors.foreground }]}>↩ Scan Again</Text>
              </Pressable>
            </View>
            <View style={[styles.notFoundCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.notFoundTitle, { color: colors.foreground }]}>No item found</Text>
              <Text style={[styles.scannedCode, { color: colors.mutedForeground }]}>
                Code: {scannedCode}
              </Text>
              <Text style={[styles.notFoundDesc, { color: colors.mutedForeground }]}>
                This barcode isn't assigned to any catalog item yet.
              </Text>
              {isAdmin ? (
                <Pressable
                  onPress={() => setShowAssignPicker(true)}
                  style={[styles.assignBtn, { backgroundColor: colors.primary }]}
                >
                  <Text style={[styles.assignBtnText, { color: colors.primaryForeground }]}>
                    Assign to Item
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        ) : null}

      </ScrollView>

      {/* ── Assign picker modal (not-found → assign to item) ─────────────────── */}
      <CatalogPickerModal
        visible={showAssignPicker}
        barcodeCode={scannedCode ?? ""}
        onAssign={handleAssign}
        onCancel={() => setShowAssignPicker(false)}
      />

      {/* ── History item preview modal ────────────────────────────────────────── */}
      <Modal
        visible={!!historyPreviewItem}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setHistoryPreviewItem(null)}
      >
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
          <View style={[styles.previewHeader, { borderBottomColor: colors.border }]}>
            <Text style={[styles.previewTitle, { color: colors.foreground }]}>Part Detail</Text>
            <Pressable onPress={() => setHistoryPreviewItem(null)} hitSlop={10}>
              <Text style={{ color: colors.primary, fontSize: 15, fontFamily: "Inter_500Medium" }}>Done</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
            {historyPreviewItem ? (
              <ResultCard
                result={{
                  item: historyPreviewItem,
                  confidence: 1.0,
                  matchReason: "scan history",
                  seriesBase: null,
                  seriesLabel: null,
                  variants: [],
                }}
                onEditItem={isAdmin ? (item) => { setHistoryPreviewItem(null); setDetailsItem(item); } : undefined}
                rank={0}
                fontScale={textFontScale}
              />
            ) : null}
          </ScrollView>
        </SafeAreaView>
      </Modal>

      <PartDetailsEditor
        item={detailsItem}
        adminToken={adminToken}
        onClose={() => setDetailsItem(null)}
        onShowOnMap={handleShowOnMap}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  header: { paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, flexDirection: "row", alignItems: "center", gap: 10 },
  headerTitle: { fontSize: 20, fontFamily: "Inter_700Bold" },
  headerSub: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  permText: { fontSize: 15, fontFamily: "Inter_400Regular", textAlign: "center", marginBottom: 20, lineHeight: 22 },
  permBtn: { paddingHorizontal: 24, paddingVertical: 14, borderRadius: 10 },
  permBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  backBar: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 0,
  },
  backBtn: {
    alignSelf: "flex-start",
    paddingVertical: 4,
    paddingHorizontal: 2,
  },
  backBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  shelfBtn: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
  },
  shelfBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  sectionLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  cameraWrapper: {
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 16,
    overflow: "hidden",
    height: 280,
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
    height: 120,
    borderWidth: 2,
    borderRadius: 8,
    opacity: 0.8,
  },
  scanStatus: {
    position: "absolute",
    bottom: 12,
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
    marginTop: 12,
    alignItems: "center",
    gap: 6,
  },
  scanBtn: {
    width: "100%",
    paddingVertical: 15,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  scanBtnText: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.3,
  },
  scanBtnHint: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    letterSpacing: 0.2,
  },
  errorBanner: {
    margin: 16,
    borderRadius: 8,
    borderWidth: 1,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  errorText: { fontSize: 13, fontFamily: "Inter_500Medium", flex: 1 },
  scannedCode: { fontSize: 12, fontFamily: "Inter_400Regular", marginBottom: 8 },
  rescanBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
  },
  rescanText: { fontSize: 12, fontFamily: "Inter_500Medium" },
  offlineBadge: { paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4 },
  offlineBadgeText: { fontSize: 9, fontFamily: "Inter_700Bold", letterSpacing: 0.5 },
  offlineMissCard: {
    margin: 16,
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    gap: 10,
  },
  offlineMissHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  offlineMissIcon: { fontSize: 18 },
  offlineMissTitle: { fontSize: 14, fontFamily: "Inter_700Bold", flex: 1 },
  offlineMissBody: { fontSize: 13, fontFamily: "Inter_400Regular", lineHeight: 19 },
  offlineMissCode: { fontSize: 11, fontFamily: "SpaceMono_400Regular" },
  offlineMissBtn: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginTop: 2,
  },
  offlineMissBtnText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  notFoundCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    gap: 6,
  },
  notFoundTitle: { fontSize: 16, fontFamily: "Inter_700Bold" },
  notFoundDesc: { fontSize: 13, fontFamily: "Inter_400Regular", lineHeight: 19 },
  assignBtn: {
    marginTop: 8,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
  },
  assignBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  recentsHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  clearBtn: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, borderWidth: 1 },
  clearBtnText: { fontSize: 12, fontFamily: "Inter_500Medium" },
  recentRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 10,
    borderWidth: 1,
    padding: 10,
    marginBottom: 6,
    gap: 10,
  },
  adminActionIcon: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  recentCatalog: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  recentVendor: { fontSize: 13, fontFamily: "Inter_400Regular" },
  recentBarcode: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 1 },
  recentTime: { fontSize: 11, fontFamily: "Inter_400Regular" },
  recentBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5 },
  recentBadgeText: { fontSize: 10, fontFamily: "Inter_600SemiBold" },
  recentChevron: { fontSize: 20, fontFamily: "Inter_400Regular", lineHeight: 24 },
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 6,
    paddingHorizontal: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    marginBottom: 6,
    marginTop: 4,
  },
  groupLabel: { fontSize: 11, fontFamily: "Inter_600SemiBold", letterSpacing: 0.6 },
  groupCount: { fontSize: 11, fontFamily: "Inter_400Regular" },
  groupChevron: { fontSize: 16, fontFamily: "Inter_400Regular", lineHeight: 20 },
  previewHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  previewTitle: { fontSize: 17, fontFamily: "Inter_600SemiBold" },
  staleCacheNote: {
    marginTop: 8,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  staleCacheNoteText: { fontSize: 12, fontFamily: "Inter_500Medium" },
});
