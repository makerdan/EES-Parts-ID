import React, { useState, useRef, useCallback } from "react";
import {
  ActivityIndicator,
  Pressable,
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

const SCAN_DELAY_MS = 1500;

export function BarcodeAddPart() {
  "use no memo";
  const colors = useColors();
  const { isAdmin } = useApp();
  const queryClient = useQueryClient();

  const [permission, requestPermission] = useCameraPermissions();

  // Normal assign state
  const [scannedCode, setScannedCode] = useState<string | null>(null);
  const [assignPicker, setAssignPicker] = useState(false);
  const [lastAssigned, setLastAssigned] = useState<AssignmentEntry | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  // Pre-scan delay state
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const pendingCodeRef = useRef<string | null>(null);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScannedRef = useRef<string | null>(null);
  const scanCooldownRef = useRef(false);

  // Shelf mode state
  const [shelfMode, setShelfMode] = useState(false);
  const [shelfPrefix, setShelfPrefix] = useState("");
  const [shelfStep, setShelfStep] = useState<"pickshelf" | "scanning">("pickshelf");
  const [shelfScannedCode, setShelfScannedCode] = useState<string | null>(null);
  const [shelfAssignPicker, setShelfAssignPicker] = useState(false);
  const [assignments, setAssignments] = useState<AssignmentEntry[]>([]);

  const updateBarcodesMutation = useUpdateItemBarcodes();
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

  const clearPendingScan = useCallback(() => {
    if (pendingTimerRef.current) { clearTimeout(pendingTimerRef.current); pendingTimerRef.current = null; }
    pendingCodeRef.current = null;
    setPendingCode(null);
  }, []);

  const handleBarcodeScanned = useCallback(
    (data: { data: string }) => {
      const code = data.data;
      if (scanCooldownRef.current) return;
      if (pendingCodeRef.current === code) return;

      clearPendingScan();
      pendingCodeRef.current = code;
      setPendingCode(code);

      pendingTimerRef.current = setTimeout(() => {
        pendingCodeRef.current = null;
        setPendingCode(null);

        if (shelfMode && shelfStep === "scanning") {
          if (code === lastScannedRef.current) return;
          lastScannedRef.current = code;
          scanCooldownRef.current = true;
          setTimeout(() => { scanCooldownRef.current = false; }, 2000);
          setShelfScannedCode(code);
          setShelfAssignPicker(true);
          return;
        }

        if (code === lastScannedRef.current) return;
        lastScannedRef.current = code;
        scanCooldownRef.current = true;
        setTimeout(() => { scanCooldownRef.current = false; }, 2000);
        setScannedCode(code);
        setAssignPicker(true);
      }, SCAN_DELAY_MS);
    },
    [shelfMode, shelfStep, clearPendingScan],
  );

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
        setLastAssigned({ barcode: scannedCode, item });
        setScannedCode(null);
        lastScannedRef.current = null;
        scanCooldownRef.current = false;
      } catch {
        setScanError("Could not assign barcode. Please try again.");
      }
    },
    [scannedCode, updateBarcodesMutation, queryClient],
  );

  const handleShelfAssign = useCallback(
    async (item: InventoryItem) => {
      if (!shelfScannedCode) return;
      setShelfAssignPicker(false);
      setScanError(null);
      try {
        const result = await resolveShelfAssign(
          shelfScannedCode,
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
        setAssignments((prev) => [{ barcode: shelfScannedCode, item }, ...prev]);
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
    setScannedCode(null);
    setLastAssigned(null);
    clearPendingScan();
    lastScannedRef.current = null;
    scanCooldownRef.current = false;
  };

  const exitShelfMode = () => {
    setShelfMode(false);
    setShelfStep("pickshelf");
    setShelfPrefix("");
    setShelfScannedCode(null);
    setShelfAssignPicker(false);
    setAssignments([]);
    clearPendingScan();
    lastScannedRef.current = null;
    scanCooldownRef.current = false;
  };

  const isCameraActive = !assignPicker && !shelfAssignPicker;

  if (!permission) {
    return (
      <View style={[apStyles.permBox, { backgroundColor: colors.muted, borderColor: colors.border }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!permission.granted) {
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
      </View>
    );
  }

  return (
    <View>
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
            placeholder="Shelf prefix (e.g. A-01)"
            placeholderTextColor={colors.mutedForeground}
            value={shelfPrefix}
            onChangeText={setShelfPrefix}
            autoCapitalize="characters"
            autoCorrect={false}
          />
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

      {/* Camera viewfinder */}
      {(!shelfMode || shelfStep === "scanning") ? (
        <View style={apStyles.cameraWrapper}>
          <CameraView
            style={apStyles.camera}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr", "ean13", "ean8", "upc_a", "upc_e", "code128", "code39", "code93", "codabar", "itf14", "datamatrix", "pdf417", "aztec"] }}
            onBarcodeScanned={isCameraActive ? handleBarcodeScanned : undefined}
          />
          <View style={apStyles.viewfinderOverlay}>
            <View style={[apStyles.viewfinderFrame, { borderColor: colors.primary }]} />
          </View>
          {pendingCode ? (
            <View style={[apStyles.scanStatus, { backgroundColor: "rgba(0,0,0,0.67)" }]}>
              <ActivityIndicator color={colors.primaryForeground} size="small" />
              <Text style={apStyles.scanStatusText}>Scanning…</Text>
            </View>
          ) : null}
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
              key={i}
              style={[apStyles.logRow, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <View style={{ flex: 1 }}>
                <Text style={[apStyles.logCatalog, { color: colors.foreground }]}>
                  {a.item.catalog}
                  <Text style={[apStyles.logVendor, { color: colors.mutedForeground }]}> · {a.item.vendor}</Text>
                </Text>
                <Text style={[apStyles.logBarcode, { color: colors.mutedForeground }]}>{a.barcode}</Text>
              </View>
              <View style={[apStyles.logBadge, { backgroundColor: colors.success + "22" }]}>
                <Text style={[apStyles.logBadgeText, { color: colors.success }]}>✓</Text>
              </View>
            </View>
          ))}
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
          lastScannedRef.current = null;
          scanCooldownRef.current = false;
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
          lastScannedRef.current = null;
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
    marginTop: 10,
    borderRadius: 10,
    borderWidth: 1,
    padding: 12,
    gap: 2,
  },
  lastAssignedLabel: { fontSize: 11, fontFamily: "Inter_700Bold", letterSpacing: 0.5, textTransform: "uppercase" },
  lastAssignedCatalog: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  lastAssignedBarcode: { fontSize: 11, fontFamily: "Inter_400Regular" },
  completedLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1,
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
});
