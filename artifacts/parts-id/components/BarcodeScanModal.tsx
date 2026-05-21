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
import { CameraView, useCameraPermissions } from "expo-camera";
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

export function BarcodeScanModal({ visible, onClose, onFound }: BarcodeScanModalProps) {
  const colors = useColors();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanPhase, setScanPhase] = useState<ScanPhase>("idle");
  const { addEntry } = useScanHistory();
  const lastScannedRef = useRef<string | null>(null);
  const cooldownRef = useRef(false);

  const resetScan = useCallback(() => {
    setScanPhase("idle");
    lastScannedRef.current = null;
    cooldownRef.current = false;
  }, []);

  useEffect(() => {
    if (!visible) {
      setScanPhase("idle");
      lastScannedRef.current = null;
      cooldownRef.current = false;
    }
  }, [visible]);

  const handleBarcodeScanned = useCallback(
    async ({ data: code }: { data: string }) => {
      if (cooldownRef.current || code === lastScannedRef.current) return;
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
    },
    [addEntry, onFound, onClose, resetScan],
  );

  const statusLabel =
    scanPhase === "looking" ? "Looking up…" :
    scanPhase === "found" ? "Found — opening result…" :
    scanPhase === "notfound" ? "Barcode not in inventory" :
    scanPhase === "offline_miss" ? "No connection — barcode not cached" :
    scanPhase === "error" ? "Lookup failed — try again" :
    "Point camera at a barcode";

  const statusBg =
    scanPhase === "found" ? colors.success + "cc" :
    scanPhase === "notfound" || scanPhase === "offline_miss" ? colors.warning + "cc" :
    scanPhase === "error" ? colors.destructive + "cc" :
    scanPhase === "looking" ? colors.primary + "cc" :
    "#00000088";

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
        ) : !permission.granted ? (
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
          </View>
        ) : (
          <>
            <View style={scanStyles.cameraWrapper}>
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
              <View style={[scanStyles.viewfinderOverlay, { pointerEvents: "none" }]}>
                <View style={[scanStyles.viewfinderFrame, { borderColor: colors.primary }]} />
              </View>
              <View style={[scanStyles.statusBar, { backgroundColor: statusBg }]}>
                {scanPhase === "looking" ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : null}
                <Text style={scanStyles.statusText}>{statusLabel}</Text>
              </View>
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
});
