import { useQueryClient } from "@tanstack/react-query";
import type { InventoryItem } from "@workspace/api-client-react";
import { lookupByBarcode, useUpdateItemBarcodes } from "@workspace/api-client-react";
import { type BarcodeScanningResult,CameraView, useCameraPermissions } from "expo-camera";
import React, { useCallback, useEffect,useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { CatalogPickerModal } from "@/components/CatalogPickerModal";
import { useApp } from "@/contexts/AppContext";
import { useColors } from "@/hooks/useColors";
import { useScanHistory } from "@/hooks/useScanHistory";
import { invalidateListCache } from "@/utils/editItemCache";
import { lookupByBarcodeOffline, upsertItemInBarcodeCache } from "@/utils/offlineBarcode";

interface BarcodeScanModalProps {
  visible: boolean;
  onClose: () => void;
  onFound: (item: InventoryItem, barcode: string, isOffline: boolean) => void;
}

type ScanPhase = "idle" | "looking" | "found" | "notfound" | "offline_miss" | "error";
type AdminPickerMode = "link" | "create";

export function BarcodeScanModal({ visible, onClose, onFound }: BarcodeScanModalProps) {
  "use no memo";
  const colors = useColors();
  const { isAdmin } = useApp();
  const queryClient = useQueryClient();
  const updateBarcodesMutation = useUpdateItemBarcodes();
  const [permission, requestPermission] = useCameraPermissions();
  const [cameraBypass, setCameraBypass] = useState(false);
  const cameraViewSizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });
  const [scanPhase, setScanPhase] = useState<ScanPhase>("idle");
  const { addEntry } = useScanHistory();

  // Pending barcode — set when camera detects a barcode, cleared on commit or reset
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const pendingCodeRef = useRef<string | null>(null);
  const pendingCommitRef = useRef<(() => void) | null>(null);

  const [notFoundCode, setNotFoundCode] = useState<string | null>(null);
  const [showAdminPicker, setShowAdminPicker] = useState(false);
  const [adminPickerMode, setAdminPickerMode] = useState<AdminPickerMode>("link");
  const [adminSuccessMsg, setAdminSuccessMsg] = useState<string | null>(null);
  const [adminAssignError, setAdminAssignError] = useState<string | null>(null);

  const isMountedRef = useRef(true);
  const timerIdsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const clearAllTimers = useCallback(() => {
    timerIdsRef.current.forEach(clearTimeout);
    timerIdsRef.current.clear();
  }, []);

  const scheduleTimer = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      timerIdsRef.current.delete(id);
      if (isMountedRef.current) fn();
    }, ms);
    timerIdsRef.current.add(id);
    return id;
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      clearAllTimers();
    };
  }, [clearAllTimers]);

  const clearPendingScan = useCallback(() => {
    pendingCommitRef.current = null;
    pendingCodeRef.current = null;
    setPendingCode(null);
  }, []);

  const resetScan = useCallback(() => {
    setScanPhase("idle");
    setNotFoundCode(null);
    setAdminSuccessMsg(null);
    setAdminAssignError(null);
    clearPendingScan();
  }, [clearPendingScan]);

  useEffect(() => {
    if (!visible) {
      clearAllTimers();
      setScanPhase("idle");
      setNotFoundCode(null);
      setShowAdminPicker(false);
      setAdminSuccessMsg(null);
      setAdminAssignError(null);
      clearPendingScan();
    }
  }, [visible, clearPendingScan, clearAllTimers]);

  const handleAdminAssign = useCallback(
    async (item: InventoryItem) => {
      if (!notFoundCode) return;
      setShowAdminPicker(false);
      setAdminAssignError(null);
      const action = adminPickerMode === "create" ? "created" : "linked";
      try {
        const existing = item.barcodes ?? [];
        if (!existing.includes(notFoundCode)) {
          const updated = await updateBarcodesMutation.mutateAsync({
            id: item.id,
            data: { barcodes: [...existing, notFoundCode] },
          });
          await invalidateListCache({ queryClient });
          await upsertItemInBarcodeCache(updated);
        }
        if (!isMountedRef.current) return;
        addEntry({
          barcode: notFoundCode,
          found: true,
          itemId: item.id,
          catalog: item.catalog,
          vendor: item.vendor,
          timestamp: new Date().toISOString(),
          adminAction: action,
        });
        setAdminSuccessMsg(action === "created" ? `Created ${item.catalog}` : `Linked to ${item.catalog}`);
        scheduleTimer(() => {
          resetScan();
        }, 1800);
      } catch {
        if (!isMountedRef.current) return;
        setAdminAssignError("Could not save — please try again.");
      }
    },
    [notFoundCode, adminPickerMode, addEntry, updateBarcodesMutation, queryClient, resetScan, scheduleTimer],
  );

  const handleBarcodeScanned = useCallback(
    (result: BarcodeScanningResult) => {
      // Reject scans that originate outside the viewfinder square
      const { width: cw, height: ch } = cameraViewSizeRef.current;
      if (cw > 0 && ch > 0) {
        const VF_W = 220, VF_H = 220, MARGIN = 20;
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

        setScanPhase("looking");

        try {
          const item = await lookupByBarcode(encodeURIComponent(code));
          if (!isMountedRef.current) return;
          setScanPhase("found");
          addEntry({
            barcode: code,
            found: true,
            itemId: item.id,
            catalog: item.catalog,
            vendor: item.vendor,
            timestamp: new Date().toISOString(),
          });
          scheduleTimer(() => {
            onFound(item, code, false);
            onClose();
          }, 500);
        } catch (err: unknown) {
          if (!isMountedRef.current) return;
          const status =
            err && typeof err === "object" && "status" in err
              ? (err as { status: number }).status
              : null;
          if (status === 404) {
            setScanPhase("notfound");
            addEntry({ barcode: code, found: false, timestamp: new Date().toISOString() });
            if (isAdmin) {
              setNotFoundCode(code);
            }
            // Non-admin: keep the message visible until the user taps
            // "Scan Again" — actionable, not auto-dismissed (F-052).
          } else if (status === null) {
            const offlineItem = await lookupByBarcodeOffline(code);
            if (!isMountedRef.current) return;
            if (offlineItem) {
              setScanPhase("found");
              addEntry({
                barcode: code,
                found: true,
                itemId: offlineItem.id,
                catalog: offlineItem.catalog,
                vendor: offlineItem.vendor,
                timestamp: new Date().toISOString(),
              });
              scheduleTimer(() => {
                onFound(offlineItem, code, true);
                onClose();
              }, 500);
            } else {
              // Offline cache miss — actionable: user must tap Dismiss (F-052)
              setScanPhase("offline_miss");
            }
          } else {
            // Server/network error — actionable: user must tap Dismiss (F-052)
            setScanPhase("error");
          }
        }
      };
      pendingCommitRef.current = doCommit;
    },
    [addEntry, onFound, onClose, resetScan, scanPhase, isAdmin, scheduleTimer],
  );

  const captureNow = useCallback(() => {
    const commit = pendingCommitRef.current;
    if (!commit) return;
    void commit();
  }, []);

  const canCapture = scanPhase === "idle" && !!pendingCode;

  const statusLabel =
    scanPhase === "looking" ? "Looking up…" :
    scanPhase === "found" ? "Found — opening result…" :
    scanPhase === "notfound" ? "Barcode not in inventory" :
    scanPhase === "offline_miss" ? "No connection — barcode not cached" :
    scanPhase === "error" ? "Lookup failed — try again" :
    canCapture ? "Barcode detected — tap Scan" :
    "Aim camera at a barcode";

  const statusBg =
    canCapture ? colors.success + "cc" :
    scanPhase === "found" ? colors.success + "cc" :
    scanPhase === "notfound" || scanPhase === "offline_miss" ? colors.warning + "cc" :
    scanPhase === "error" ? colors.destructive + "cc" :
    scanPhase === "looking" ? colors.primary + "cc" :
    "rgba(0,0,0,0.53)";

  const isTerminal =
    scanPhase === "notfound" || scanPhase === "offline_miss" || scanPhase === "error";

  const isAdminNotFound = scanPhase === "notfound" && isAdmin && notFoundCode;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
        <View style={[scanStyles.header, { borderBottomColor: colors.border }]}>
          <Text style={[scanStyles.title, { color: colors.foreground }]}>Scan Barcode</Text>
          <Pressable onPress={onClose} hitSlop={10}>
            <Text style={{ color: colors.primary, fontSize: 15, fontFamily: "Inter_500Medium" }}>
              Close
            </Text>
          </Pressable>
        </View>

        {!permission ? (
          <View style={scanStyles.center}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : !permission.granted && !cameraBypass ? (
          <View style={[scanStyles.center, { gap: 16, padding: 32 }]}>
            <Text style={{ color: colors.foreground, fontSize: 15, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 22 }}>
              Camera access is required for barcode scanning.
            </Text>
            {permission.canAskAgain ? (
              <Pressable
                onPress={requestPermission}
                style={{ paddingHorizontal: 24, paddingVertical: 14, borderRadius: 10, backgroundColor: colors.primary }}
              >
                <Text style={{ color: colors.primaryForeground, fontSize: 15, fontFamily: "Inter_600SemiBold" }}>
                  Allow Camera Access
                </Text>
              </Pressable>
            ) : (
              <>
                <Text style={{ color: colors.mutedForeground, fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 }}>
                  Camera access was permanently denied. Enable it in Settings to use the scanner.
                </Text>
                <Pressable
                  onPress={() => void Linking.openSettings()}
                  style={{ paddingHorizontal: 24, paddingVertical: 14, borderRadius: 10, backgroundColor: colors.primary }}
                >
                  <Text style={{ color: colors.primaryForeground, fontSize: 15, fontFamily: "Inter_600SemiBold" }}>
                    Open Settings
                  </Text>
                </Pressable>
              </>
            )}
            {__DEV__ ? (
              <Pressable
                onPress={() => setCameraBypass(true)}
                style={{ paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border }}
              >
                <Text style={{ color: colors.mutedForeground, fontSize: 14, fontFamily: "Inter_500Medium" }}>
                  Skip camera (dev only)
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : (
          <>
            <View style={scanStyles.cameraWrapper} onLayout={(e) => { cameraViewSizeRef.current = e.nativeEvent.layout; }}>
              {!cameraBypass ? (
                <CameraView
                  style={StyleSheet.absoluteFill}
                  facing="back"
                  barcodeScannerSettings={{
                    barcodeTypes: ["qr", "ean13", "ean8", "code128", "code39", "pdf417", "upc_a", "upc_e", "aztec", "datamatrix", "itf14"],
                  }}
                  {...(scanPhase === "looking" || scanPhase === "found"
                    ? {}
                    : { onBarcodeScanned: handleBarcodeScanned })}
                />
              ) : (
                <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.muted, alignItems: "center", justifyContent: "center" }]}>
                  <Text style={{ color: colors.mutedForeground, fontSize: 13, fontFamily: "Inter_400Regular" }}>📷 Camera bypassed (dev)</Text>
                </View>
              )}
              <View style={[scanStyles.viewfinderOverlay, { pointerEvents: "none" }]}>
                <View style={[scanStyles.viewfinderFrame, { borderColor: canCapture ? colors.success : colors.primary }]} />
              </View>
              <View style={[scanStyles.statusBar, { backgroundColor: statusBg }]}>
                {scanPhase === "looking" ? (
                  <ActivityIndicator color={colors.primaryForeground} size="small" />
                ) : null}
                <Text style={scanStyles.statusText}>{statusLabel}</Text>
              </View>
            </View>

            {/* Scan button — shown when idle */}
            {scanPhase === "idle" ? (
              <View style={scanStyles.scanBtnRow}>
                <Pressable
                  onPress={captureNow}
                  disabled={!canCapture}
                  style={[
                    scanStyles.scanBtn,
                    { backgroundColor: canCapture ? colors.primary : colors.muted, borderColor: canCapture ? colors.primary : colors.border },
                  ]}
                >
                  <Text style={[scanStyles.scanBtnText, { color: canCapture ? colors.primaryForeground : colors.mutedForeground }]}>
                    {canCapture ? "⬤  Scan" : "Scan"}
                  </Text>
                </Pressable>
                {canCapture ? (
                  <Text style={[scanStyles.scanBtnHint, { color: colors.mutedForeground }]}>
                    {pendingCode}
                  </Text>
                ) : (
                  <Text style={[scanStyles.scanBtnHint, { color: colors.mutedForeground }]}>
                    Aim at a barcode, then tap Scan
                  </Text>
                )}
              </View>
            ) : null}

            {isAdminNotFound && !adminSuccessMsg ? (
              <View style={[scanStyles.adminPanel, { borderTopColor: colors.border }]}>
                <Text style={[scanStyles.adminPanelCode, { color: colors.mutedForeground }]}>
                  Barcode: <Text style={{ color: colors.foreground, fontFamily: "Inter_600SemiBold" }}>{notFoundCode}</Text>
                </Text>

                {adminAssignError ? (
                  <View style={[scanStyles.adminErrorRow, { backgroundColor: colors.destructive + "14", borderColor: colors.destructive + "33" }]}>
                    <Text style={{ color: colors.destructive, fontSize: 13, fontFamily: "Inter_400Regular", flex: 1 }}>{adminAssignError}</Text>
                    <Pressable onPress={() => setAdminAssignError(null)} hitSlop={8}>
                      <Text style={{ color: colors.destructive, fontSize: 13 }}>✕</Text>
                    </Pressable>
                  </View>
                ) : null}

                <View style={scanStyles.adminBtnRow}>
                  <Pressable
                    onPress={() => { setAdminPickerMode("link"); setShowAdminPicker(true); }}
                    style={[scanStyles.adminBtn, { backgroundColor: colors.primary }]}
                  >
                    <Text style={[scanStyles.adminBtnText, { color: colors.primaryForeground }]}>Add to Existing Item</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => { setAdminPickerMode("create"); setShowAdminPicker(true); }}
                    style={[scanStyles.adminBtn, { backgroundColor: colors.accent, borderWidth: 1, borderColor: colors.border }]}
                  >
                    <Text style={[scanStyles.adminBtnText, { color: colors.foreground }]}>Create New Part</Text>
                  </Pressable>
                </View>

                <Pressable onPress={resetScan} style={scanStyles.adminCancelBtn}>
                  <Text style={{ color: colors.mutedForeground, fontSize: 13, fontFamily: "Inter_500Medium" }}>
                    Scan Again
                  </Text>
                </Pressable>
              </View>
            ) : adminSuccessMsg ? (
              <View style={[scanStyles.adminSuccessPanel, { backgroundColor: colors.success + "15", borderColor: colors.success + "44" }]}>
                <Text style={[scanStyles.adminSuccessIcon, { color: colors.success }]}>✓</Text>
                <View>
                  <Text style={[scanStyles.adminSuccessLabel, { color: colors.success }]}>Done</Text>
                  <Text style={[scanStyles.adminSuccessDetail, { color: colors.foreground }]}>{adminSuccessMsg}</Text>
                </View>
              </View>
            ) : isTerminal ? (
              <View style={{ padding: 24, alignItems: "center" }}>
                <Pressable
                  onPress={resetScan}
                  style={{ paddingHorizontal: 24, paddingVertical: 12, borderRadius: 8, backgroundColor: colors.primary }}
                >
                  <Text style={{ color: colors.primaryForeground, fontSize: 14, fontFamily: "Inter_600SemiBold" }}>
                    Scan Again
                  </Text>
                </Pressable>
              </View>
            ) : null}
          </>
        )}
      </SafeAreaView>

      <CatalogPickerModal
        visible={showAdminPicker}
        barcodeCode={notFoundCode ?? ""}
        {...(adminPickerMode === "create"
          ? { initialQuery: notFoundCode ?? "" }
          : {})}
        initialShowCreateForm={adminPickerMode === "create"}
        onAssign={handleAdminAssign}
        onCancel={() => setShowAdminPicker(false)}
      />
    </Modal>
  );
}

const scanStyles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  title: { fontSize: 17, fontFamily: "Inter_600SemiBold" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  cameraWrapper: {
    width: "100%",
    aspectRatio: 1,
    position: "relative",
    overflow: "hidden",
  },
  viewfinderOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  viewfinderFrame: {
    width: 220,
    height: 220,
    borderWidth: 2,
    borderRadius: 16,
  },
  statusBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
  },
  statusText: { color: "#fff", fontSize: 14, fontFamily: "Inter_500Medium" },
  scanBtnRow: {
    marginHorizontal: 16,
    marginTop: 16,
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
    fontSize: 12,
    fontFamily: "Inter_400Regular",
  },
  adminPanel: {
    padding: 20,
    gap: 12,
    borderTopWidth: 1,
  },
  adminPanelCode: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  adminErrorRow: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    gap: 8,
  },
  adminBtnRow: {
    flexDirection: "row",
    gap: 10,
  },
  adminBtn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  adminBtnText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    textAlign: "center",
  },
  adminCancelBtn: {
    alignItems: "center",
    paddingVertical: 6,
  },
  adminSuccessPanel: {
    margin: 20,
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  adminSuccessIcon: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
  },
  adminSuccessLabel: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  adminSuccessDetail: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
});
