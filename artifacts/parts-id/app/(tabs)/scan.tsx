/**
 * Scan tab — point camera at a barcode / QR / Data Matrix label and jump
 * straight to the part. Vendor barcodes (UPCs) usually do NOT match the
 * warehouse catalog code, so unknown scans fall through to a
 * scan-to-link picker that calls the existing Search and Photo ID
 * surfaces to bind the barcode to the right inventory row.
 *
 * Scanning is one-shot: a successful read pauses the camera, opens the
 * result, and only re-arms when the worker dismisses the result. That
 * matches the warehouse workflow ("scan, look at part, walk to bin")
 * and avoids the chaos of repeated reads on the same label.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
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
import * as Haptics from "expo-haptics";
import {
  useBarcodeLookup,
  barcodeLink,
  useBarcodeRecent,
  useSearchInventory,
  useAiIdentifyPart,
} from "@workspace/api-client-react";
import type {
  InventoryItem,
  SearchResult,
  BarcodeLookupResponse,
} from "@workspace/api-client-react";
import * as ImagePicker from "expo-image-picker";
import { resizeImage } from "@/utils/resizeImage";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/contexts/AppContext";
import { ResultCard } from "@/components/ResultCard";

const BARCODE_TYPES = [
  "ean13",
  "ean8",
  "upc_a",
  "upc_e",
  "code128",
  "code39",
  "datamatrix",
  "qr",
] as const;

type PickerMode = "menu" | "search" | "photo";

export default function ScanScreen() {
  const colors = useColors();
  const { textFontScale } = useApp();
  const isWeb = Platform.OS === "web";

  const [permission, requestPermission] = useCameraPermissions();
  const [permissionExplained, setPermissionExplained] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [scanning, setScanning] = useState(true);
  const [manualEntry, setManualEntry] = useState(isWeb);
  const [manualValue, setManualValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const lastScanRef = useRef<string>("");

  // Result panel state
  const [matchedItem, setMatchedItem] = useState<InventoryItem | null>(null);
  const [pendingBarcode, setPendingBarcode] = useState<string | null>(null);
  const [recentItems, setRecentItems] = useState<InventoryItem[]>([]);
  const [pickerMode, setPickerMode] = useState<PickerMode>("menu");

  const { adminToken, isAdmin } = useApp();
  // The mutating /link endpoint is gated by the admin token (same gate
  // the Upload tab uses). Reads (`/lookup`, `/recent`) are open.
  const [linking, setLinking] = useState(false);
  const lookupMutation = useBarcodeLookup();
  const searchMutation = useSearchInventory();
  const identifyMutation = useAiIdentifyPart();
  const recentQuery = useBarcodeRecent({ limit: 20 });

  // Show ephemeral toasts (auto-dismiss after 2.5s).
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const resetScanner = useCallback(() => {
    setMatchedItem(null);
    setPendingBarcode(null);
    setPickerMode("menu");
    setError(null);
    lastScanRef.current = "";
    setScanning(true);
  }, []);

  const performLookup = useCallback(
    async (barcode: string) => {
      const trimmed = barcode.trim();
      if (!trimmed) return;
      setScanning(false);
      setError(null);
      try {
        const res: BarcodeLookupResponse = await lookupMutation.mutateAsync({
          data: { barcode: trimmed },
        });
        setRecentItems(res.recentlyViewed);
        if (res.match) {
          setMatchedItem(res.match);
          setPendingBarcode(null);
          // Light haptic + toast confirms the scan landed on a real part.
          if (Platform.OS !== "web") {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }
          setToast(`Scanned ${res.match.catalog}`);
        } else {
          setMatchedItem(null);
          setPendingBarcode(trimmed);
          setPickerMode("menu");
          if (Platform.OS !== "web") {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          }
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? `Lookup failed: ${err.message}`
            : "Lookup failed — please try again.",
        );
        setScanning(true);
      }
    },
    [lookupMutation],
  );

  const handleBarcodeScanned = useCallback(
    ({ data }: { data: string }) => {
      // Guard against the camera firing the same code repeatedly while the
      // worker holds the phone over the label.
      if (!scanning || lookupMutation.isPending) return;
      if (data === lastScanRef.current) return;
      lastScanRef.current = data;
      void performLookup(data);
    },
    [scanning, lookupMutation.isPending, performLookup],
  );

  const handleManualSubmit = useCallback(() => {
    if (!manualValue.trim()) return;
    void performLookup(manualValue);
    setManualValue("");
  }, [manualValue, performLookup]);

  // Link the pending barcode to a chosen part, then surface the part.
  const handlePickPart = useCallback(
    async (item: InventoryItem) => {
      if (!pendingBarcode) {
        setMatchedItem(item);
        return;
      }
      if (!isAdmin || !adminToken) {
        setError(
          "Sign in as admin (Upload tab) to teach the app new barcodes.",
        );
        return;
      }
      setLinking(true);
      try {
        const res = await barcodeLink(
          { barcode: pendingBarcode, inventoryId: item.id },
          { headers: { Authorization: `Bearer ${adminToken}` } },
        );
        setMatchedItem(res.item);
        setPendingBarcode(null);
        setToast(`Linked to ${res.item.catalog}`);
        if (Platform.OS !== "web") {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? `Failed to link: ${err.message}`
            : "Failed to link barcode.",
        );
      } finally {
        setLinking(false);
      }
    },
    [pendingBarcode, isAdmin, adminToken],
  );

  // Sub-picker: search by keyword/catalog
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const runSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    try {
      const res = await searchMutation.mutateAsync({
        data: { keywords: searchQuery, confidenceThreshold: 30 },
      });
      setSearchResults(res.results);
    } catch (err) {
      setError(
        err instanceof Error ? `Search failed: ${err.message}` : "Search failed.",
      );
    }
  }, [searchQuery, searchMutation]);

  // Sub-picker: photo ID
  const runPhotoIdentify = useCallback(async () => {
    try {
      const cam = await ImagePicker.requestCameraPermissionsAsync();
      if (cam.status !== "granted") {
        setError("Camera access denied — please enable it in Settings.");
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: "images",
        quality: 0.7,
        allowsEditing: true,
      });
      if (result.canceled || result.assets.length === 0) return;
      const asset = result.assets[0]!;
      const resized = await resizeImage(asset.uri, asset.width ?? 0);
      const id = await identifyMutation.mutateAsync({
        data: { images: [resized.base64] },
      });
      const allTerms = [...id.searchTerms, ...id.synonyms.slice(0, 3)].join(" ");
      if (allTerms.trim()) {
        const res = await searchMutation.mutateAsync({
          data: { keywords: allTerms, confidenceThreshold: 30 },
        });
        setSearchResults(res.results);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? `Photo ID failed: ${err.message}`
          : "Photo ID failed.",
      );
    }
  }, [identifyMutation, searchMutation]);

  // ── Permission gate ────────────────────────────────────────────────────────
  if (!isWeb && !permission) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.primary} />
      </SafeAreaView>
    );
  }

  // When the worker has chosen manual entry, fall through to the main
  // view so the input bar is reachable regardless of the camera
  // permission state — the gates below are bypassed.
  if (!isWeb && permission && !permission.granted && !permissionExplained && !manualEntry) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
        <View style={styles.explainerCard}>
          <Text style={[styles.explainerTitle, { color: colors.foreground }]}>
            Scan barcodes to find parts faster
          </Text>
          <Text style={[styles.explainerBody, { color: colors.mutedForeground }]}>
            We use the camera only while you're on this tab to read EAN, UPC,
            Code 128, Code 39, Data Matrix, and QR codes printed on parts and
            bins. Photos are never stored.
          </Text>
          <Pressable
            style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
            onPress={async () => {
              setPermissionExplained(true);
              await requestPermission();
            }}
          >
            <Text style={[styles.primaryBtnText, { color: colors.primaryForeground }]}>
              Continue
            </Text>
          </Pressable>
          <Pressable onPress={() => setManualEntry(true)} style={styles.secondaryBtn}>
            <Text style={{ color: colors.primary, fontFamily: "Inter_500Medium" }}>
              Type barcode instead
            </Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (!isWeb && permission && !permission.granted && !manualEntry) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
        <View style={styles.explainerCard}>
          <Text style={[styles.explainerTitle, { color: colors.foreground }]}>
            Camera access is off
          </Text>
          <Text style={[styles.explainerBody, { color: colors.mutedForeground }]}>
            Open Settings to grant camera access, or type the barcode by hand.
          </Text>
          <Pressable
            style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
            onPress={() => Linking.openSettings()}
          >
            <Text style={[styles.primaryBtnText, { color: colors.primaryForeground }]}>
              Open Settings
            </Text>
          </Pressable>
          <Pressable onPress={() => setManualEntry(true)} style={styles.secondaryBtn}>
            <Text style={{ color: colors.primary, fontFamily: "Inter_500Medium" }}>
              Type barcode instead
            </Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/* Camera viewfinder */}
      {!isWeb && permission?.granted ? (
        <View style={styles.cameraWrap}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            enableTorch={torchOn}
            barcodeScannerSettings={{ barcodeTypes: [...BARCODE_TYPES] }}
            onBarcodeScanned={scanning ? handleBarcodeScanned : undefined}
          />
          {/* Reticle overlay */}
          <View pointerEvents="none" style={styles.reticleWrap}>
            <View style={[styles.reticle, { borderColor: colors.primary }]} />
            <Text style={[styles.reticleHint, { color: "#fff" }]}>
              {lookupMutation.isPending
                ? "Looking up…"
                : "Center barcode in the box"}
            </Text>
          </View>
          <View style={styles.controlsRow}>
            <Pressable
              onPress={() => setTorchOn((v) => !v)}
              style={[
                styles.controlBtn,
                { backgroundColor: torchOn ? colors.primary : "#00000099" },
              ]}
              accessibilityRole="button"
              accessibilityLabel={torchOn ? "Turn torch off" : "Turn torch on"}
            >
              <Text style={[styles.controlText, { color: "#fff" }]}>
                {torchOn ? "Torch on" : "Torch"}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setManualEntry((v) => !v)}
              style={[styles.controlBtn, { backgroundColor: "#00000099" }]}
              accessibilityRole="button"
              accessibilityLabel="Type barcode"
            >
              <Text style={[styles.controlText, { color: "#fff" }]}>
                Type barcode
              </Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={[styles.webPlaceholder, { borderColor: colors.border }]}>
          <Text style={[styles.explainerBody, { color: colors.mutedForeground }]}>
            {isWeb
              ? "Camera scanning isn't available in the web build. Type the barcode below to look it up."
              : "Camera is off. Type the barcode below, or open Settings to enable camera access."}
          </Text>
          {!isWeb && permission && !permission.granted ? (
            <Pressable
              style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
              onPress={() => Linking.openSettings()}
            >
              <Text style={[styles.primaryBtnText, { color: colors.primaryForeground }]}>
                Open Settings
              </Text>
            </Pressable>
          ) : null}
        </View>
      )}

      {/* Manual entry */}
      {manualEntry || isWeb ? (
        <View style={[styles.manualBar, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <TextInput
            value={manualValue}
            onChangeText={setManualValue}
            placeholder="Type barcode or catalog #"
            placeholderTextColor={colors.mutedForeground}
            autoCapitalize="characters"
            autoCorrect={false}
            style={[styles.manualInput, { color: colors.foreground, borderColor: colors.border }]}
            onSubmitEditing={handleManualSubmit}
            returnKeyType="search"
          />
          <Pressable
            onPress={handleManualSubmit}
            style={[styles.primaryBtn, { backgroundColor: colors.primary, marginTop: 0, paddingHorizontal: 16 }]}
            disabled={!manualValue.trim()}
          >
            <Text style={[styles.primaryBtnText, { color: colors.primaryForeground }]}>
              Lookup
            </Text>
          </Pressable>
        </View>
      ) : null}

      {/* Toast */}
      {toast ? (
        <View style={[styles.toast, { backgroundColor: colors.foreground }]}>
          <Text style={[styles.toastText, { color: colors.background }]}>{toast}</Text>
        </View>
      ) : null}

      {/* Inline error */}
      {error ? (
        <View style={[styles.errorBar, { backgroundColor: colors.destructive + "22", borderColor: colors.destructive }]}>
          <Text style={{ color: colors.destructive, fontFamily: "Inter_500Medium" }}>{error}</Text>
        </View>
      ) : null}

      {/* Match modal — opened when lookup returns a real part. */}
      <Modal
        visible={matchedItem !== null}
        animationType="slide"
        transparent
        onRequestClose={resetScanner}
      >
        <Pressable style={styles.modalOverlay} onPress={resetScanner}>
          <Pressable
            onPress={() => undefined}
            style={[styles.modalSheet, { backgroundColor: colors.background, borderColor: colors.border }]}
          >
            <View style={[styles.modalHeader, { borderColor: colors.border }]}>
              <Text style={[styles.modalTitle, { color: colors.foreground }]}>
                Scanned Part
              </Text>
              <Pressable onPress={resetScanner} hitSlop={10} style={[styles.closeBtn, { borderColor: colors.border }]}>
                <Text style={{ color: colors.foreground, fontFamily: "Inter_600SemiBold" }}>✕ Close</Text>
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={{ padding: 14 }}>
              {matchedItem ? (
                <ResultCard
                  result={{
                    item: matchedItem,
                    confidence: 1,
                    matchReason: "Matched by barcode scan",
                    seriesLabel: undefined,
                    variants: [],
                  }}
                  rank={0}
                  fontScale={textFontScale}
                />
              ) : null}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* No-match scan-to-link picker */}
      <Modal
        visible={pendingBarcode !== null && matchedItem === null}
        animationType="slide"
        transparent
        onRequestClose={resetScanner}
      >
        <Pressable style={styles.modalOverlay} onPress={resetScanner}>
          <Pressable
            onPress={() => undefined}
            style={[styles.modalSheet, { backgroundColor: colors.background, borderColor: colors.border }]}
          >
            <View style={[styles.modalHeader, { borderColor: colors.border }]}>
              <Text style={[styles.modalTitle, { color: colors.foreground }]}>
                {pickerMode === "menu"
                  ? "Don't recognize this barcode yet"
                  : pickerMode === "search"
                  ? "Search for the part"
                  : "Take a photo of the part"}
              </Text>
              <Pressable onPress={resetScanner} hitSlop={10} style={[styles.closeBtn, { borderColor: colors.border }]}>
                <Text style={{ color: colors.foreground, fontFamily: "Inter_600SemiBold" }}>✕ Cancel</Text>
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={{ padding: 14 }}>
              {pendingBarcode ? (
                <Text style={[styles.barcodeLabel, { color: colors.mutedForeground }]}>
                  Barcode: {pendingBarcode}
                </Text>
              ) : null}

              {pickerMode === "menu" ? (
                <>
                  <Text style={[styles.helpText, { color: colors.foreground }]}>
                    Pick the part this barcode belongs to. Next scan of the same
                    barcode will jump straight to that part.
                  </Text>
                  <View style={{ gap: 8, marginTop: 12 }}>
                    <Pressable
                      style={[styles.modeBtn, { borderColor: colors.border, backgroundColor: colors.card }]}
                      onPress={() => {
                        setPickerMode("search");
                        setSearchResults([]);
                      }}
                    >
                      <Text style={[styles.modeBtnText, { color: colors.foreground }]}>
                        🔍  Search by catalog or keyword
                      </Text>
                    </Pressable>
                    <Pressable
                      style={[styles.modeBtn, { borderColor: colors.border, backgroundColor: colors.card }]}
                      onPress={() => {
                        setPickerMode("photo");
                        setSearchResults([]);
                        void runPhotoIdentify();
                      }}
                    >
                      <Text style={[styles.modeBtnText, { color: colors.foreground }]}>
                        📷  Identify with Photo ID
                      </Text>
                    </Pressable>
                  </View>

                  <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
                    OR PICK FROM RECENTLY VIEWED
                  </Text>
                  <RecentList
                    items={
                      recentItems.length > 0
                        ? recentItems
                        : recentQuery.data?.items ?? []
                    }
                    onPick={handlePickPart}
                    busy={linking}
                  />
                </>
              ) : null}

              {pickerMode === "search" ? (
                <>
                  <View style={[styles.manualBar, { padding: 0, borderWidth: 0 }]}>
                    <TextInput
                      value={searchQuery}
                      onChangeText={setSearchQuery}
                      placeholder="Catalog # or keywords"
                      placeholderTextColor={colors.mutedForeground}
                      style={[styles.manualInput, { color: colors.foreground, borderColor: colors.border }]}
                      onSubmitEditing={runSearch}
                      autoFocus
                    />
                    <Pressable
                      onPress={runSearch}
                      style={[styles.primaryBtn, { backgroundColor: colors.primary, marginTop: 0, paddingHorizontal: 16 }]}
                    >
                      <Text style={[styles.primaryBtnText, { color: colors.primaryForeground }]}>Search</Text>
                    </Pressable>
                  </View>
                  {searchMutation.isPending ? (
                    <ActivityIndicator color={colors.primary} style={{ marginTop: 12 }} />
                  ) : null}
                  <RecentList items={searchResults.map((r) => r.item)} onPick={handlePickPart} busy={linking} />
                </>
              ) : null}

              {pickerMode === "photo" ? (
                <>
                  {identifyMutation.isPending || searchMutation.isPending ? (
                    <ActivityIndicator color={colors.primary} style={{ marginTop: 12 }} />
                  ) : null}
                  <RecentList items={searchResults.map((r) => r.item)} onPick={handlePickPart} busy={linking} />
                  <Pressable
                    onPress={runPhotoIdentify}
                    style={[styles.secondaryBtn, { borderColor: colors.border, borderWidth: 1, marginTop: 12, padding: 10, alignSelf: "stretch", alignItems: "center" }]}
                  >
                    <Text style={{ color: colors.primary, fontFamily: "Inter_600SemiBold" }}>
                      Take another photo
                    </Text>
                  </Pressable>
                </>
              ) : null}

              {pickerMode !== "menu" ? (
                <Pressable onPress={() => setPickerMode("menu")} style={[styles.secondaryBtn, { marginTop: 12 }]}>
                  <Text style={{ color: colors.primary, fontFamily: "Inter_500Medium" }}>← Back</Text>
                </Pressable>
              ) : null}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function RecentList({
  items,
  onPick,
  busy,
}: {
  items: InventoryItem[];
  onPick: (item: InventoryItem) => void;
  busy: boolean;
}) {
  const colors = useColors();
  if (items.length === 0) {
    return (
      <Text style={{ color: colors.mutedForeground, marginTop: 12, fontFamily: "Inter_400Regular" }}>
        No items to show yet.
      </Text>
    );
  }
  return (
    <View style={{ marginTop: 8 }}>
      {items.map((item) => (
        <Pressable
          key={item.id}
          onPress={() => onPick(item)}
          disabled={busy}
          style={({ pressed }) => [
            styles.recentRow,
            {
              borderColor: colors.border,
              backgroundColor: pressed ? colors.accent : colors.card,
              opacity: busy ? 0.5 : 1,
            },
          ]}
        >
          <Text style={[styles.recentVendor, { color: colors.mutedForeground }]}>
            {item.vendor}
          </Text>
          <Text style={[styles.recentCatalog, { color: colors.foreground }]} numberOfLines={1}>
            {item.catalog}
          </Text>
          {item.description ? (
            <Text style={[styles.recentDesc, { color: colors.mutedForeground }]} numberOfLines={2}>
              {item.description}
            </Text>
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  safe: { flex: 1, alignItems: "center", justifyContent: "center" },
  cameraWrap: { flex: 1, position: "relative" },
  reticleWrap: { position: "absolute", inset: 0, alignItems: "center", justifyContent: "center" },
  reticle: { width: 260, height: 160, borderWidth: 3, borderRadius: 12 },
  reticleHint: {
    marginTop: 16,
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    backgroundColor: "#00000088",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 4,
  },
  controlsRow: {
    position: "absolute",
    bottom: 16,
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "center",
    gap: 12,
  },
  controlBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    minHeight: 44,
    minWidth: 88,
    alignItems: "center",
    justifyContent: "center",
  },
  controlText: { fontFamily: "Inter_600SemiBold", fontSize: 13 },
  webPlaceholder: {
    margin: 16,
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
  },
  explainerCard: {
    margin: 24,
    padding: 20,
    gap: 12,
  },
  explainerTitle: { fontSize: 18, fontFamily: "Inter_700Bold" },
  explainerBody: { fontSize: 14, fontFamily: "Inter_400Regular", lineHeight: 20 },
  primaryBtn: {
    marginTop: 12,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
  },
  primaryBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  secondaryBtn: { paddingVertical: 8, alignItems: "center" },
  manualBar: {
    flexDirection: "row",
    gap: 8,
    padding: 10,
    borderTopWidth: 1,
    alignItems: "center",
  },
  manualInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: "Inter_500Medium",
    minHeight: 44,
  },
  toast: {
    position: "absolute",
    top: 12,
    alignSelf: "center",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
  },
  toastText: { fontFamily: "Inter_600SemiBold" },
  errorBar: {
    margin: 12,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  modalOverlay: { flex: 1, justifyContent: "flex-end", backgroundColor: "#00000088" },
  modalSheet: {
    maxHeight: "92%",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    overflow: "hidden",
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modalTitle: { fontSize: 15, fontFamily: "Inter_700Bold", flexShrink: 1 },
  closeBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  barcodeLabel: { fontFamily: "Inter_500Medium", marginBottom: 8 },
  helpText: { fontFamily: "Inter_400Regular", lineHeight: 20 },
  modeBtn: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
  },
  modeBtnText: { fontFamily: "Inter_600SemiBold", fontSize: 14 },
  sectionLabel: {
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1,
    fontSize: 11,
    marginTop: 18,
    marginBottom: 6,
  },
  recentRow: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginTop: 6,
  },
  recentVendor: { fontFamily: "Inter_500Medium", fontSize: 11, letterSpacing: 0.5 },
  recentCatalog: { fontFamily: "Inter_700Bold", fontSize: 16, marginTop: 2 },
  recentDesc: { fontFamily: "Inter_400Regular", fontSize: 12, marginTop: 4 },
});
