import React, { useState, useRef, useCallback, useEffect } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/contexts/AppContext";
import {
  lookupByBarcode,
  useUpdateItemBarcodes,
  useSearchInventory,
  useUpsertInventoryBatch,
  useListInventory,
  getListInventoryQueryKey,
} from "@workspace/api-client-react";
import type { InventoryItem } from "@workspace/api-client-react";
import { lookupByBarcodeOffline, upsertItemInBarcodeCache, getFuseCacheSyncedAt, FUSE_SYNC_MAX_AGE_MS } from "@/utils/offlineBarcode";
import { resolveBarcodeCode, resolveShelfAssign } from "@/utils/barcodeResolver";
import { ResultCard } from "@/components/ResultCard";
import { BarcodeEditor } from "@/components/BarcodeEditor";
import { PartDetailsEditor } from "@/components/PartDetailsEditor";
import { useQueryClient } from "@tanstack/react-query";
import { useScanHistory } from "@/hooks/useScanHistory";
import type { ScanEntry } from "@/utils/scanHistory";
import { groupScansByDate } from "@/utils/scanHistory";

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

interface AssignmentEntry {
  barcode: string;
  item: InventoryItem;
  timestamp: Date;
}

// ── Catalog search picker (used in "assign" flow and "Add by Shelf") ──────────
function CatalogPickerModal({
  visible,
  barcodeCode,
  shelfPrefix,
  onAssign,
  onCancel,
}: {
  visible: boolean;
  barcodeCode: string;
  shelfPrefix?: string;
  onAssign: (item: InventoryItem) => void;
  onCancel: () => void;
}) {
  const colors = useColors();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  // Inline "new item" form state
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newVendor, setNewVendor] = useState("");
  const [newBinLocation, setNewBinLocation] = useState("");
  const [vendorError, setVendorError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchMutation = useSearchInventory();
  const createMutation = useUpsertInventoryBatch();
  const lookupMutation = useSearchInventory();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedQuery(query), 350);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  useEffect(() => {
    if (!visible) {
      setQuery(""); setDebouncedQuery(""); setCreateError(null);
      setShowCreateForm(false); setNewVendor(""); setNewBinLocation(""); setVendorError(null);
      return;
    }
  }, [visible]);

  useEffect(() => {
    if (!visible || !debouncedQuery.trim()) return;
    searchMutation.mutate({ data: { keywords: debouncedQuery, confidenceThreshold: 20 } });
  }, [debouncedQuery, visible]);

  const handleOpenCreateForm = useCallback(() => {
    setShowCreateForm(true);
    setNewVendor("");
    setNewBinLocation("");
    setVendorError(null);
    setCreateError(null);
  }, []);

  const handleCancelCreateForm = useCallback(() => {
    setShowCreateForm(false);
    setVendorError(null);
    setCreateError(null);
  }, []);

  const handleConfirmCreate = useCallback(async () => {
    const catalogCode = query.trim();
    const vendorCode = newVendor.trim();
    if (!catalogCode) return;
    if (!vendorCode) { setVendorError("Vendor code is required"); return; }
    setVendorError(null);
    setCreateError(null);
    const bins = newBinLocation.trim() ? [newBinLocation.trim()] : [];
    try {
      await createMutation.mutateAsync({
        data: { items: [{ catalog: catalogCode, vendor: vendorCode, binLocations: bins }] },
      });
      queryClient.invalidateQueries({ queryKey: getListInventoryQueryKey() });
      // Look up the just-created item to get its full record (including id)
      const result = await lookupMutation.mutateAsync({
        data: { keywords: catalogCode, catalog: catalogCode, confidenceThreshold: 0 },
      });
      const created = result.results.find(
        (r) => r.item.catalog.toLowerCase() === catalogCode.toLowerCase(),
      );
      if (created) {
        onAssign(created.item);
      } else {
        setCreateError("Item created but could not be retrieved. Search for it manually.");
      }
    } catch {
      setCreateError("Failed to create item. Please try again.");
    }
  }, [query, newVendor, newBinLocation, createMutation, lookupMutation, queryClient, onAssign]);

  const isCreating = createMutation.isPending || lookupMutation.isPending;

  const prefix = shelfPrefix?.trim().toLowerCase() ?? "";
  const allResults = searchMutation.data?.results ?? [];
  // When a shelf prefix is set, pre-filter to items whose bin locations match
  // that shelf, while keeping the full list as a fallback if nothing matches.
  const shelfFiltered = prefix
    ? allResults.filter(r =>
        r.item.binLocations.some(b => b.toLowerCase().startsWith(prefix))
      )
    : allResults;
  const results = shelfFiltered.length > 0 ? shelfFiltered : allResults;
  const isFiltered = prefix && shelfFiltered.length > 0;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onCancel}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={[pickerStyles.container, { backgroundColor: colors.background }]}
      >
        <View style={[pickerStyles.header, { borderBottomColor: colors.border }]}>
          <View style={{ flex: 1 }}>
            <Text style={[pickerStyles.title, { color: colors.foreground }]}>Assign Barcode</Text>
            <Text style={[pickerStyles.sub, { color: colors.mutedForeground }]} numberOfLines={1}>
              Code: {barcodeCode}
            </Text>
            {isFiltered ? (
              <Text style={[pickerStyles.sub, { color: colors.primary, marginTop: 2 }]} numberOfLines={1}>
                Filtered to shelf: {shelfPrefix}
              </Text>
            ) : null}
          </View>
          <Pressable onPress={onCancel} style={[pickerStyles.closeBtn, { backgroundColor: colors.muted }]}>
            <Text style={{ color: colors.foreground, fontSize: 14 }}>✕</Text>
          </Pressable>
        </View>

        <View style={{ padding: 12 }}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={prefix ? `Search parts on shelf ${shelfPrefix}…` : "Search or enter new catalog #…"}
            placeholderTextColor={colors.mutedForeground}
            autoFocus
            style={[pickerStyles.searchInput, { backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground }]}
            autoCorrect={false}
            autoCapitalize="none"
          />
        </View>

        {/* ── Inline "new item" form ── */}
        {showCreateForm ? (
          <View style={[pickerStyles.createForm, { backgroundColor: colors.muted, borderColor: colors.border }]}>
            <Text style={[pickerStyles.createFormTitle, { color: colors.foreground }]}>
              New item — catalog: <Text style={{ color: colors.primary }}>{query.trim()}</Text>
            </Text>

            <Text style={[pickerStyles.createFormLabel, { color: colors.mutedForeground }]}>
              Vendor code <Text style={{ color: "#ef4444" }}>*</Text>
            </Text>
            <TextInput
              value={newVendor}
              onChangeText={(t) => { setNewVendor(t); setVendorError(null); }}
              placeholder="e.g. HUBBELL"
              placeholderTextColor={colors.mutedForeground}
              autoCapitalize="characters"
              autoCorrect={false}
              style={[pickerStyles.createFormInput, {
                backgroundColor: colors.background,
                borderColor: vendorError ? "#ef4444" : colors.border,
                color: colors.foreground,
              }]}
            />
            {vendorError ? (
              <Text style={{ color: "#ef4444", fontSize: 11, marginBottom: 6, fontFamily: "Inter_400Regular" }}>{vendorError}</Text>
            ) : null}

            <Text style={[pickerStyles.createFormLabel, { color: colors.mutedForeground }]}>
              Primary bin location <Text style={{ color: colors.mutedForeground }}>(optional)</Text>
            </Text>
            <TextInput
              value={newBinLocation}
              onChangeText={setNewBinLocation}
              placeholder="e.g. A-12-3"
              placeholderTextColor={colors.mutedForeground}
              autoCapitalize="characters"
              autoCorrect={false}
              style={[pickerStyles.createFormInput, {
                backgroundColor: colors.background,
                borderColor: colors.border,
                color: colors.foreground,
              }]}
            />

            {createError ? (
              <Text style={{ color: "#ef4444", fontSize: 12, marginBottom: 6, fontFamily: "Inter_400Regular" }}>{createError}</Text>
            ) : null}

            {isCreating ? (
              <View style={{ alignItems: "center", paddingVertical: 12 }}>
                <ActivityIndicator color={colors.primary} />
                <Text style={{ color: colors.mutedForeground, fontSize: 13, marginTop: 8, fontFamily: "Inter_400Regular" }}>
                  Creating new item…
                </Text>
              </View>
            ) : (
              <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
                <Pressable
                  onPress={handleCancelCreateForm}
                  style={[pickerStyles.createFormBtn, { backgroundColor: colors.background, borderColor: colors.border, flex: 1 }]}
                >
                  <Text style={{ color: colors.foreground, fontSize: 13, fontFamily: "Inter_500Medium" }}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={handleConfirmCreate}
                  style={[pickerStyles.createFormBtn, { backgroundColor: colors.primary, borderColor: colors.primary, flex: 2 }]}
                >
                  <Text style={{ color: colors.primaryForeground, fontSize: 13, fontFamily: "Inter_500Medium" }}>Create & assign</Text>
                </Pressable>
              </View>
            )}
          </View>
        ) : null}

        {!showCreateForm && createError ? (
          <Text style={[pickerStyles.errorText, { color: "#ef4444" }]}>{createError}</Text>
        ) : null}

        {isCreating && !showCreateForm ? (
          <View style={{ padding: 24, alignItems: "center" }}>
            <ActivityIndicator color={colors.primary} />
            <Text style={[{ color: colors.mutedForeground, fontSize: 13, marginTop: 8, fontFamily: "Inter_400Regular" }]}>
              Creating new item…
            </Text>
          </View>
        ) : !showCreateForm && searchMutation.isPending ? (
          <View style={{ padding: 24, alignItems: "center" }}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : !showCreateForm ? (
          <FlatList
            data={results}
            keyExtractor={(r) => String(r.item.id)}
            keyboardShouldPersistTaps="handled"
            ListHeaderComponent={
              debouncedQuery.trim() ? (
                <Pressable
                  onPress={handleOpenCreateForm}
                  style={[pickerStyles.createRow, { backgroundColor: colors.primary + "15", borderColor: colors.primary + "44" }]}
                >
                  <Text style={[pickerStyles.createIcon, { color: colors.primary }]}>＋</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={[pickerStyles.createLabel, { color: colors.primary }]}>
                      Add as new item
                    </Text>
                    <Text style={[pickerStyles.createCatalog, { color: colors.foreground }]} numberOfLines={1}>
                      {debouncedQuery.trim()}
                    </Text>
                  </View>
                </Pressable>
              ) : null
            }
            renderItem={({ item: r }) => (
              <Pressable
                onPress={() => onAssign(r.item)}
                style={[pickerStyles.resultRow, { borderBottomColor: colors.border }]}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Text style={[pickerStyles.resultCatalog, { color: colors.foreground, flex: 1 }]}>
                    {r.item.catalog}
                  </Text>
                  {prefix && r.item.binLocations.some(b => b.toLowerCase().startsWith(prefix)) ? (
                    <View style={[pickerStyles.shelfBadge, { backgroundColor: colors.primary + "22" }]}>
                      <Text style={[pickerStyles.shelfBadgeText, { color: colors.primary }]}>
                        {r.item.binLocations.find(b => b.toLowerCase().startsWith(prefix))}
                      </Text>
                    </View>
                  ) : null}
                </View>
                <Text style={[pickerStyles.resultVendor, { color: colors.mutedForeground }]}>
                  {r.item.vendor}
                </Text>
                {r.item.description ? (
                  <Text style={[pickerStyles.resultDesc, { color: colors.mutedForeground }]} numberOfLines={1}>
                    {r.item.description}
                  </Text>
                ) : null}
              </Pressable>
            )}
            ListEmptyComponent={
              debouncedQuery.trim() && !searchMutation.isPending ? (
                <Text style={[pickerStyles.emptyText, { color: colors.mutedForeground }]}>
                  No existing items match — use "Add as new item" above.
                </Text>
              ) : !debouncedQuery.trim() ? (
                <Text style={[pickerStyles.emptyText, { color: colors.mutedForeground }]}>
                  Type a catalog # to search or add a new item…
                </Text>
              ) : null
            }
          />
        ) : null}
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Main Barcode Screen ────────────────────────────────────────────────────────
interface BarcodeScreenProps {
  /** When provided (modal mode) a "Close" button appears in the header. */
  onClose?: () => void;
}

export default function BarcodeScreen({ onClose }: BarcodeScreenProps = {}) {
  const colors = useColors();
  const { isAdmin, textFontScale, adminToken } = useApp();
  const queryClient = useQueryClient();

  const [permission, requestPermission] = useCameraPermissions();

  // ── Scan state ───────────────────────────────────────────────────────────────
  const [scanPhase, setScanPhase] = useState<ScanPhase>("idle");
  const [scannedCode, setScannedCode] = useState<string | null>(null);
  const [matchedItem, setMatchedItem] = useState<InventoryItem | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [isOfflineMatch, setIsOfflineMatch] = useState(false);
  const [fuseSyncedAt, setFuseSyncedAt] = useState<number | null>(null);
  const [showAssignPicker, setShowAssignPicker] = useState(false);
  const [barcodeEditItem, setBarcodeEditItem] = useState<InventoryItem | null>(null);
  const [detailsEditItem, setDetailsEditItem] = useState<InventoryItem | null>(null);
  const [historyPreviewItem, setHistoryPreviewItem] = useState<InventoryItem | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // Debounce scans so a single barcode doesn't fire dozens of times
  const lastScannedRef = useRef<string | null>(null);
  const scanCooldownRef = useRef(false);

  // Pre-scan delay: hold a barcode steady for SCAN_DELAY_MS before registering
  const SCAN_DELAY_MS = 2000;
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const [scanDelaySeconds, setScanDelaySeconds] = useState<number | null>(null);
  const pendingCodeRef = useRef<string | null>(null);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Bin location suggestions (for shelf picker step 1) ───────────────────────
  const { data: inventoryPage } = useListInventory({ limit: 500 });
  const allBinLocations = React.useMemo(() => {
    const items = inventoryPage?.items ?? [];
    const set = new Set<string>();
    for (const item of items) {
      for (const bin of item.binLocations ?? []) {
        if (bin.trim()) set.add(bin.trim());
      }
    }
    return Array.from(set).sort();
  }, [inventoryPage]);

  // ── Add by Shelf state ───────────────────────────────────────────────────────
  const [shelfMode, setShelfMode] = useState(false);
  const [shelfPrefix, setShelfPrefix] = useState("");
  const [shelfStep, setShelfStep] = useState<"pickshelf" | "scanning">("pickshelf");
  const [shelfScannedCode, setShelfScannedCode] = useState<string | null>(null);
  const [shelfAssignPicker, setShelfAssignPicker] = useState(false);
  const [assignments, setAssignments] = useState<AssignmentEntry[]>([]);

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

  // ── Pre-scan delay helpers ────────────────────────────────────────────────────
  const clearPendingScan = useCallback(() => {
    if (pendingTimerRef.current) { clearTimeout(pendingTimerRef.current); pendingTimerRef.current = null; }
    if (countdownIntervalRef.current) { clearInterval(countdownIntervalRef.current); countdownIntervalRef.current = null; }
    pendingCodeRef.current = null;
    setPendingCode(null);
    setScanDelaySeconds(null);
  }, []);

  // ── Scan handler ─────────────────────────────────────────────────────────────
  const handleBarcodeScanned = useCallback(
    (data: { data: string }) => {
      const code = data.data;

      // Already in a non-idle phase — ignore
      if (scanPhase !== "idle") return;
      if (scanCooldownRef.current) return;

      // Same barcode already pending — let the existing countdown run
      if (pendingCodeRef.current === code) return;

      // New or different barcode — cancel existing countdown and start fresh
      clearPendingScan();
      pendingCodeRef.current = code;
      setPendingCode(code);

      const totalSeconds = Math.round(SCAN_DELAY_MS / 1000);
      setScanDelaySeconds(totalSeconds);
      let secondsLeft = totalSeconds;

      countdownIntervalRef.current = setInterval(() => {
        secondsLeft -= 1;
        setScanDelaySeconds(secondsLeft);
        if (secondsLeft <= 0) {
          clearInterval(countdownIntervalRef.current!);
          countdownIntervalRef.current = null;
        }
      }, 1000);

      pendingTimerRef.current = setTimeout(async () => {
        pendingCodeRef.current = null;
        setPendingCode(null);
        setScanDelaySeconds(null);

        // Shelf mode: capture and show catalog picker
        if (shelfMode && shelfStep === "scanning") {
          if (code === lastScannedRef.current) return;
          lastScannedRef.current = code;
          scanCooldownRef.current = true;
          setTimeout(() => { scanCooldownRef.current = false; }, 2000);
          setShelfScannedCode(code);
          setShelfAssignPicker(true);
          return;
        }

        // Normal lookup mode
        if (code === scannedCode) return;
        scanCooldownRef.current = true;
        setTimeout(() => { scanCooldownRef.current = false; }, 2000);

        setScannedCode(code);
        lastScannedRef.current = code;
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
      }, SCAN_DELAY_MS);
    },
    [shelfMode, shelfStep, scannedCode, addEntry, scanPhase, clearPendingScan],
  );

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
    lastScannedRef.current = null;
    scanCooldownRef.current = false;
  };

  // ── Assign barcode to item (normal mode) ─────────────────────────────────────
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
          const listKeyPrefix = getListInventoryQueryKey()[0];
          await queryClient.invalidateQueries({
            predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === listKeyPrefix,
          });
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

  // ── Shelf mode assign ─────────────────────────────────────────────────────────
  const handleShelfAssign = useCallback(
    async (item: InventoryItem) => {
      if (!shelfScannedCode) return;
      setShelfAssignPicker(false);
      try {
        const result = await resolveShelfAssign(
          shelfScannedCode,
          item,
          (id, barcodes) =>
            updateBarcodesMutation.mutateAsync({ id, data: { barcodes } }),
          upsertItemInBarcodeCache,
        );
        if (result.wasNew) {
          const listKeyPrefix = getListInventoryQueryKey()[0];
          await queryClient.invalidateQueries({
            predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === listKeyPrefix,
          });
        }
        setAssignments((prev) => [
          { barcode: shelfScannedCode, item, timestamp: new Date() },
          ...prev,
        ]);
        setShelfScannedCode(null);
        lastScannedRef.current = null;
      } catch {
        setScanError("Could not assign barcode. Please try again.");
        setShelfScannedCode(null);
      }
    },
    [shelfScannedCode, updateBarcodesMutation, queryClient],
  );

  const startShelfMode = () => {
    setShelfMode(true);
    setShelfStep("pickshelf");
    setShelfPrefix("");
    setAssignments([]);
    resetScan();
  };

  const exitShelfMode = () => {
    setShelfMode(false);
    setShelfStep("pickshelf");
    setShelfPrefix("");
    setShelfScannedCode(null);
    setShelfAssignPicker(false);
    resetScan();
  };

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

  if (!permission.granted) {
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
        </View>
      </SafeAreaView>
    );
  }

  const isCameraActive = !showAssignPicker && !barcodeEditItem && !shelfAssignPicker;

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>
            {shelfMode ? `Add by Shelf${shelfPrefix ? ` — ${shelfPrefix}` : ""}` : "Barcode"}
          </Text>
          <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>
            {shelfMode
              ? shelfStep === "pickshelf" ? "Pick a shelf prefix to begin" : `Scanning for shelf ${shelfPrefix}`
              : "Scan a barcode to look up parts"}
          </Text>
        </View>
        {isAdmin && !shelfMode ? (
          <Pressable
            onPress={startShelfMode}
            style={[styles.shelfBtn, { backgroundColor: colors.accent, borderColor: colors.border }]}
          >
            <Text style={[styles.shelfBtnText, { color: colors.foreground }]}>+ Add by Shelf</Text>
          </Pressable>
        ) : null}
        {shelfMode ? (
          <Pressable
            onPress={exitShelfMode}
            style={[styles.shelfBtn, { backgroundColor: colors.destructive + "22", borderColor: colors.destructive + "44" }]}
          >
            <Text style={[styles.shelfBtnText, { color: colors.destructive }]}>Done</Text>
          </Pressable>
        ) : null}
        {onClose ? (
          <Pressable
            onPress={onClose}
            style={[styles.shelfBtn, { backgroundColor: colors.muted, borderColor: colors.border, marginLeft: 6 }]}
          >
            <Text style={[styles.shelfBtnText, { color: colors.foreground }]}>Close</Text>
          </Pressable>
        ) : null}
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 120 }} keyboardShouldPersistTaps="handled">
        {/* ── Shelf mode: step 1 pick shelf ──────────────────────────────────── */}
        {shelfMode && shelfStep === "pickshelf" ? (
          <View style={{ padding: 16, gap: 12 }}>
            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>SHELF / BIN PREFIX</Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <TextInput
                value={shelfPrefix}
                onChangeText={setShelfPrefix}
                placeholder="e.g. A1, B-Row, Shelf-3…"
                placeholderTextColor={colors.mutedForeground}
                style={[styles.shelfInput, { flex: 1, backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground }]}
                autoCorrect={false}
                autoCapitalize="characters"
                returnKeyType="done"
              />
              <Pressable
                onPress={() => { if (shelfPrefix.trim()) setShelfStep("scanning"); }}
                disabled={!shelfPrefix.trim()}
                style={[styles.shelfStartBtn, { backgroundColor: shelfPrefix.trim() ? colors.primary : colors.muted }]}
              >
                <Text style={[styles.shelfStartBtnText, { color: shelfPrefix.trim() ? colors.primaryForeground : colors.mutedForeground }]}>
                  Start
                </Text>
              </Pressable>
            </View>
            {/* Suggestions from existing bin locations */}
            {allBinLocations.length > 0 ? (
              <View>
                <Text style={[styles.hint, { color: colors.mutedForeground, marginBottom: 6 }]}>
                  Tap an existing bin location to use it as a prefix:
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                  <View style={{ flexDirection: "row", flexWrap: "nowrap", gap: 6 }}>
                    {allBinLocations
                      .filter(b => !shelfPrefix.trim() || b.toUpperCase().startsWith(shelfPrefix.toUpperCase()))
                      .slice(0, 30)
                      .map(bin => (
                        <Pressable
                          key={bin}
                          onPress={() => setShelfPrefix(bin)}
                          style={[
                            styles.binChip,
                            {
                              backgroundColor: shelfPrefix === bin ? colors.primary : colors.muted,
                              borderColor: shelfPrefix === bin ? colors.primary : colors.border,
                            },
                          ]}
                        >
                          <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: shelfPrefix === bin ? colors.primaryForeground : colors.foreground }}>
                            {bin}
                          </Text>
                        </Pressable>
                      ))}
                  </View>
                </ScrollView>
              </View>
            ) : null}
            <Text style={[styles.hint, { color: colors.mutedForeground }]}>
              Select or type a shelf/bin prefix. Each scanned barcode will be assigned to an item from that shelf.
            </Text>
          </View>
        ) : null}

        {/* ── Camera viewfinder ──────────────────────────────────────────────── */}
        {(!shelfMode || shelfStep === "scanning") ? (
          <View style={styles.cameraWrapper}>
            {isCameraActive ? (
              <CameraView
                style={styles.camera}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ["qr", "ean13", "ean8", "code128", "code39", "pdf417", "upc_a", "upc_e", "aztec", "datamatrix", "itf14"] }}
                onBarcodeScanned={handleBarcodeScanned}
              />
            ) : (
              <View style={[styles.camera, { backgroundColor: colors.muted, alignItems: "center", justifyContent: "center" }]}>
                <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>Camera paused</Text>
              </View>
            )}

            {/* Viewfinder overlay */}
            <View style={styles.viewfinderOverlay} pointerEvents="none">
              <View style={[styles.viewfinderFrame, { borderColor: colors.primary }]} />
            </View>

            {/* Scanning status indicator */}
            {scanPhase === "looking" ? (
              <View style={[styles.scanStatus, { backgroundColor: colors.primary + "cc" }]}>
                <ActivityIndicator color="#fff" size="small" />
                <Text style={styles.scanStatusText}>Looking up…</Text>
              </View>
            ) : pendingCode ? (
              <View style={[styles.scanStatus, { backgroundColor: "#000000bb" }]}>
                <Text style={styles.scanStatusText}>
                  Hold steady… {scanDelaySeconds != null && scanDelaySeconds > 0 ? `${scanDelaySeconds}s` : ""}
                </Text>
              </View>
            ) : scanPhase === "idle" && !shelfMode ? (
              <View style={[styles.scanStatus, { backgroundColor: "#00000088" }]}>
                <Text style={styles.scanStatusText}>Point camera at a barcode</Text>
              </View>
            ) : shelfMode && shelfStep === "scanning" ? (
              <View style={[styles.scanStatus, { backgroundColor: "#00000088" }]}>
                <Text style={styles.scanStatusText}>Scan a barcode to assign</Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {/* ── Recents ────────────────────────────────────────────────────────── */}
        {!shelfMode && history.length > 0 ? (
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
                        <View style={[styles.recentBadge, { backgroundColor: entry.found ? colors.success + "22" : colors.muted }]}>
                          <Text style={[styles.recentBadgeText, { color: entry.found ? colors.success : colors.mutedForeground }]}>
                            {entry.found ? "found" : "unassigned"}
                          </Text>
                        </View>
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

        {/* ── Normal mode: found result ─────────────────────────────────────── */}
        {!shelfMode && scanPhase === "found" && matchedItem ? (
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
              onEditBarcodes={isAdmin ? setBarcodeEditItem : undefined}
              onEditItem={isAdmin ? setDetailsEditItem : undefined}
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

        {/* ── Normal mode: not found ────────────────────────────────────────── */}
        {!shelfMode && scanPhase === "notfound" && scannedCode ? (
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

        {/* ── Shelf mode: assignment log ────────────────────────────────────── */}
        {shelfMode && shelfStep === "scanning" && assignments.length > 0 ? (
          <View style={{ padding: 16 }}>
            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
              COMPLETED ({assignments.length})
            </Text>
            {assignments.map((a, i) => (
              <View
                key={i}
                style={[styles.logRow, { backgroundColor: colors.card, borderColor: colors.border }]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.logCatalog, { color: colors.foreground }]}>
                    {a.item.catalog}
                    <Text style={[styles.logVendor, { color: colors.mutedForeground }]}> · {a.item.vendor}</Text>
                  </Text>
                  <Text style={[styles.logBarcode, { color: colors.mutedForeground }]}>{a.barcode}</Text>
                </View>
                <View style={[styles.logBadge, { backgroundColor: colors.success + "22" }]}>
                  <Text style={[styles.logBadgeText, { color: colors.success }]}>✓</Text>
                </View>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>

      {/* ── Assign picker modals ─────────────────────────────────────────────── */}
      <CatalogPickerModal
        visible={showAssignPicker}
        barcodeCode={scannedCode ?? ""}
        onAssign={handleAssign}
        onCancel={() => setShowAssignPicker(false)}
      />

      <CatalogPickerModal
        visible={shelfAssignPicker}
        barcodeCode={shelfScannedCode ?? ""}
        shelfPrefix={shelfPrefix}
        onAssign={handleShelfAssign}
        onCancel={() => { setShelfAssignPicker(false); setShelfScannedCode(null); lastScannedRef.current = null; }}
      />

      {/* ── Barcode editor modal ─────────────────────────────────────────────── */}
      <BarcodeEditor
        item={barcodeEditItem}
        onClose={() => setBarcodeEditItem(null)}
        onBarcodesChanged={(id, barcodes) => {
          if (matchedItem?.id === id) {
            setMatchedItem((prev) => prev ? { ...prev, barcodes } : prev);
          }
        }}
      />

      {/* ── Part details editor modal ─────────────────────────────────────────── */}
      <PartDetailsEditor
        item={detailsEditItem}
        adminToken={adminToken}
        onClose={() => setDetailsEditItem(null)}
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
                onEditBarcodes={isAdmin ? setBarcodeEditItem : undefined}
                onEditItem={isAdmin ? setDetailsEditItem : undefined}
                rank={0}
                fontScale={textFontScale}
              />
            ) : null}
          </ScrollView>
        </SafeAreaView>
      </Modal>
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
  shelfInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  shelfStartBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    justifyContent: "center",
  },
  shelfStartBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  hint: { fontSize: 12, fontFamily: "Inter_400Regular", fontStyle: "italic", lineHeight: 18 },
  binChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
  },
  logRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 8,
    borderWidth: 1,
    padding: 10,
    marginBottom: 6,
    gap: 10,
  },
  logCatalog: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  logVendor: { fontSize: 13, fontFamily: "Inter_400Regular" },
  logBarcode: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 2 },
  logBadge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  logBadgeText: { fontSize: 14, fontFamily: "Inter_700Bold" },
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

const pickerStyles = StyleSheet.create({
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
  searchInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  resultRow: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  resultCatalog: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  resultVendor: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  resultDesc: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  emptyText: { padding: 24, textAlign: "center", fontSize: 13, fontFamily: "Inter_400Regular" },
  shelfBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    flexShrink: 1,
  },
  shelfBadgeText: { fontSize: 11, fontFamily: "Inter_500Medium" },
  createRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  createIcon: { fontSize: 22, lineHeight: 26 },
  createLabel: { fontSize: 11, fontFamily: "Inter_600SemiBold", letterSpacing: 0.4, textTransform: "uppercase" },
  createCatalog: { fontSize: 14, fontFamily: "Inter_700Bold", marginTop: 2 },
  errorText: { fontSize: 12, fontFamily: "Inter_400Regular", paddingHorizontal: 16, paddingBottom: 4 },
  createForm: {
    margin: 12,
    marginTop: 4,
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
  },
  createFormTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 12,
  },
  createFormLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    marginBottom: 4,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  createFormInput: {
    borderWidth: 1,
    borderRadius: 7,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    marginBottom: 10,
  },
  createFormBtn: {
    borderWidth: 1,
    borderRadius: 7,
    paddingVertical: 10,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
});
