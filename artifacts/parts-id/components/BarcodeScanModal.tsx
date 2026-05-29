import React, { useState, useRef, useCallback, useEffect } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { useColors } from "@/hooks/useColors";
import { lookupByBarcode } from "@workspace/api-client-react";
import type { InventoryItem } from "@workspace/api-client-react";
import { lookupByBarcodeOffline } from "@/utils/offlineBarcode";
import { useScanHistory } from "@/hooks/useScanHistory";

interface BarcodeScanModalProps {
  visible: boolean;
  onClose: () => void;
  onFound: (item: InventoryItem, barcode: string, isOffline: boolean) => void;
}

type ScanPhase = "idle" | "looking" | "found" | "notfound" | "offline_miss" | "error";

const SCAN_DELAY_MS = 1500;

export function BarcodeScanModal({ visible, onClose, onFound }: BarcodeScanModalProps) {
  const colors = useColors();
  const [permission, requestPermission] = useCameraPermissions();
  const [cameraBypass, setCameraBypass] = useState(false);
  const cameraViewSizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });
  const [scanPhase, setScanPhase] = useState<ScanPhase>("idle");
  const { addEntry } = useScanHistory();
  const lastScannedRef = useRef<string | null>(null);
  const cooldownRef = useRef(false);
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const pendingCodeRef = useRef<string | null>(null);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCommitRef = useRef<(() => void) | null>(null);

  const clearPendingScan = useCallback(() => {
    if (pendingTimerRef.current) { clearTimeout(pendingTimerRef.current); pendingTimerRef.current = null; }
    pendingCommitRef.current = null;
    pendingCodeRef.current = null;
    setPendingCode(null);
  }, []);

  const resetScan = useCallback(() => {
    setScanPhase("idle");
    lastScannedRef.current = null;
    cooldownRef.current = false;
    clearPendingScan();
  }, [clearPendingScan]);

  useEffect(() => {
    if (!visible) {
      setScanPhase("idle");
      lastScannedRef.current = null;
      cooldownRef.current = false;
      clearPendingScan();
    }
  }, [visible, clearPendingScan]);

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
      if (cooldownRef.current || scanPhase !== "idle") return;
      if (pendingCodeRef.current === code) return;

      // New or different barcode — restart pending countdown
      clearPendingScan();
      pendingCodeRef.current = code;
      setPendingCode(code);

      const doCommit = async () => {
        pendingCommitRef.current = null;
        pendingCodeRef.current = null;
        setPendingCode(null);
        lastScannedRef.current = code;
        cooldownRef.current = true;
        setTimeout(() => { cooldownRef.current = false; }, 2500);

        setScanPhase("looking");

        try {
          const item = await lookupByBarcode(encodeURIComponent(code));
          setScanPhase("found");
          addEntry({
            barcode: code,
            found: true,
            itemId: item.id,
            catalog: item.catalog,
            vendor: item.vendor,
            timestamp: new Date().toISOString(),
          });
          setTimeout(() => {
            onFound(item, code, false);
            onClose();
          }, 500);
        } catch (err: unknown) {
          const status =
            err && typeof err === "object" && "status" in err
              ? (err as { status: number }).status
              : null;
          if (status === 404) {
            setScanPhase("notfound");
            addEntry({ barcode: code, found: false, timestamp: new Date().toISOString() });
            setTimeout(resetScan, 2200);
          } else if (status === null) {
            const offlineItem = await lookupByBarcodeOffline(code);
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
              setTimeout(() => {
                onFound(offlineItem, code, true);
                onClose();
              }, 500);
            } else {
              setScanPhase("offline_miss");
              setTimeout(resetScan, 2500);
            }
          } else {
            setScanPhase("error");
            setTimeout(resetScan, 2000);
          }
        }
      };
      pendingCommitRef.current = doCommit;
      pendingTimerRef.current = setTimeout(doCommit, SCAN_DELAY_MS);
    },
    [addEntry, onFound, onClose, resetScan, clearPendingScan, scanPhase],
  );

  const captureNow = useCallback(() => {
    const commit = pendingCommitRef.current;
    if (!commit) return;
    if (pendingTimerRef.current) { clearTimeout(pendingTimerRef.current); pendingTimerRef.current = null; }
    void commit();
  }, []);

  const statusLabel =
    pendingCode ? "Hold steady…" :
    scanPhase === "looking" ? "Looking up…" :
    scanPhase === "found" ? "Found — opening result…" :
    scanPhase === "notfound" ? "Barcode not in inventory" :
    scanPhase === "offline_miss" ? "No connection — barcode not cached" :
    scanPhase === "error" ? "Lookup failed — try again" :
    "Point camera at a barcode";

  const statusBg =
    pendingCode ? "rgba(0,0,0,0.73)" :
    scanPhase === "found" ? colors.success + "cc" :
    scanPhase === "notfound" || scanPhase === "offline_miss" ? colors.warning + "cc" :
    scanPhase === "error" ? colors.destructive + "cc" :
    scanPhase === "looking" ? colors.primary + "cc" :
    "rgba(0,0,0,0.53)";

  const isTerminal =
    scanPhase === "notfound" || scanPhase === "offline_miss" || scanPhase === "error";

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
            <Pressable
              onPress={requestPermission}
              style={{ paddingHorizontal: 24, paddingVertical: 14, borderRadius: 10, backgroundColor: colors.primary }}
            >
              <Text style={{ color: colors.primaryForeground, fontSize: 15, fontFamily: "Inter_600SemiBold" }}>
                Allow Camera Access
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setCameraBypass(true)}
              style={{ paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border }}
            >
              <Text style={{ color: colors.mutedForeground, fontSize: 14, fontFamily: "Inter_500Medium" }}>
                Skip camera (dev only)
              </Text>
            </Pressable>
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
                  onBarcodeScanned={
                    scanPhase === "looking" || scanPhase === "found" ? undefined : handleBarcodeScanned
                  }
                />
              ) : (
                <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.muted, alignItems: "center", justifyContent: "center" }]}>
                  <Text style={{ color: colors.mutedForeground, fontSize: 13, fontFamily: "Inter_400Regular" }}>📷 Camera bypassed (dev)</Text>
                </View>
              )}
              <View style={[scanStyles.viewfinderOverlay, { pointerEvents: "none" }]}>
                <View style={[scanStyles.viewfinderFrame, { borderColor: colors.primary }]} />
              </View>
              <View style={[scanStyles.statusBar, { backgroundColor: statusBg }]}>
                {scanPhase === "looking" ? (
                  <ActivityIndicator color={colors.primaryForeground} size="small" />
                ) : null}
                <Text style={scanStyles.statusText}>{statusLabel}</Text>
              </View>
              {pendingCode ? (
                <Pressable onPress={captureNow} style={[scanStyles.captureBtn, { backgroundColor: colors.primary }]}>
                  <Text style={[scanStyles.captureBtnText, { color: colors.primaryForeground }]}>✓ Capture</Text>
                </Pressable>
              ) : null}
            </View>

            {isTerminal ? (
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
  captureBtn: {
    position: "absolute",
    bottom: 54,
    alignSelf: "center",
    paddingHorizontal: 22,
    paddingVertical: 11,
    borderRadius: 24,
  },
  captureBtnText: { fontSize: 14, fontFamily: "Inter_700Bold" },
});
