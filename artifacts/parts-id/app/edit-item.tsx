import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { KeyboardDoneInput } from "@/components/KeyboardDoneInput";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { InventoryItem, InventoryListResponse, SearchInventoryResponse } from "@workspace/api-client-react";
import { invalidateAllCachesAfterSave } from "@/utils/editItemCache";
import {
  useUpdateItemBins,
  useUpdateItemBarcodes,
  useUpdateItemKeywords,
  getListInventoryQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/contexts/AppContext";
import { shouldRedirectNonAdmin } from "@/utils/adminGuard";
import { useTrackScreen } from "@/utils/useTrackScreen";
import { MeasurePartScreen } from "@/components/MeasurePartScreen";
import type { PartDimensions } from "@/components/MeasurePartScreen";
import { isLiDARSupported } from "lidar-measure";
import { RetryImage } from "@/components/RetryImage";

interface CapturedPhoto {
  uri: string;
  base64: string;
}

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : "http://localhost:8080/api";

function fmtDim(v: number | null | undefined): string {
  if (v == null) return "";
  return String(v);
}

function parseDimField(s: string): number | null {
  const n = parseFloat(s);
  return isNaN(n) || n < 0 ? null : Math.round(n * 10) / 10;
}

export default function EditItemScreen() {
  "use no memo";
  useTrackScreen("Edit Item");
  const colors = useColors();
  const router = useRouter();
  const { adminToken, isLoading, pendingLidarDims, setPendingLidarDims } = useApp();
  const { item: itemParam, section: sectionParam } = useLocalSearchParams<{ item: string; section?: string }>();
  const queryClient = useQueryClient();
  const scrollViewRef = useRef<ScrollView>(null);
  const sectionYRef = useRef<Record<string, number>>({});

  const updateBinsMutation = useUpdateItemBins();
  const updateBarcodesMutation = useUpdateItemBarcodes();
  const updateKeywordsMutation = useUpdateItemKeywords();

  const item: InventoryItem | null = (() => {
    try { return itemParam ? (JSON.parse(itemParam) as InventoryItem) : null; }
    catch { return null; }
  })();

  // Admin guard — redirect non-admins after storage has finished loading
  useEffect(() => {
    if (shouldRedirectNonAdmin(isLoading, adminToken)) { router.replace("/(tabs)"); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, adminToken]);

  const [description, setDescription] = useState(item?.description ?? "");
  const [bins, setBins] = useState<string[]>(item?.binLocations ?? []);
  const [newBin, setNewBin] = useState("");
  const [barcodes, setBarcodes] = useState<string[]>(item?.barcodes ?? []);
  const [newBarcode, setNewBarcode] = useState("");
  const [keywords, setKeywords] = useState<string[]>(item?.aiKeywords ?? []);
  const [newKeyword, setNewKeyword] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [measureOpen, setMeasureOpen] = useState(false);
  const [lidarAvailable, setLidarAvailable] = useState(false);

  useEffect(() => {
    setLidarAvailable(isLiDARSupported());
  }, []);

  // Read LiDAR dims captured in the Measure tab and pre-fill the dimension
  // fields.  The Measure tab stores dims in AppContext (pendingLidarDims) and
  // navigates back here; we consume and clear them on the next focus.
  useFocusEffect(
    useCallback(() => {
      if (!pendingLidarDims) return;
      const d = pendingLidarDims;
      setPendingLidarDims(null);
      if (d.length != null) setDimLength(String(Math.round(d.length * 10) / 10));
      if (d.width != null) setDimWidth(String(Math.round(d.width * 10) / 10));
      if (d.height != null) setDimHeight(String(Math.round(d.height * 10) / 10));
      if (d.diameter != null) setDimDiameter(String(Math.round(d.diameter * 10) / 10));
      setSaveStatus("idle");
    }, [pendingLidarDims, setPendingLidarDims])
  );

  // Scroll to a specific section when navigated here with a section param
  useEffect(() => {
    if (!sectionParam) return;
    const timer = setTimeout(() => {
      const y = sectionYRef.current[sectionParam];
      if (y != null) scrollViewRef.current?.scrollTo({ y, animated: true });
    }, 350);
    return () => clearTimeout(timer);
  }, [sectionParam]);

  // Dimensions state
  const existingDims = (item as unknown as { dimensions?: PartDimensions | null })?.dimensions;
  const [dimLength, setDimLength] = useState(fmtDim(existingDims?.length));
  const [dimWidth, setDimWidth] = useState(fmtDim(existingDims?.width));
  const [dimHeight, setDimHeight] = useState(fmtDim(existingDims?.height));
  const [dimDiameter, setDimDiameter] = useState(fmtDim(existingDims?.diameter));

  const [newPhotoData, setNewPhotoData] = useState<CapturedPhoto | null>(null);
  const [removeCurrentPhoto, setRemoveCurrentPhoto] = useState(false);
  const [photoCameraOpen, setPhotoCameraOpen] = useState(false);
  const [takingEditPhoto, setTakingEditPhoto] = useState(false);
  const photoCameraRef = useRef<CameraView>(null);

  const [permission, requestPermission] = useCameraPermissions();
  const scannerLockRef = useRef(false);
  const itemRef = useRef(item);

  const openPhotoCamera = useCallback(async () => {
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) return;
    }
    setTakingEditPhoto(false);
    setPhotoCameraOpen(true);
  }, [permission, requestPermission]);

  const handleTakeEditPhoto = useCallback(async () => {
    if (takingEditPhoto || !photoCameraRef.current) return;
    setTakingEditPhoto(true);
    try {
      const result = await photoCameraRef.current.takePictureAsync({
        quality: 0.6,
        base64: true,
        exif: false,
      });
      if (result && result.base64) {
        setNewPhotoData({ uri: result.uri, base64: result.base64 });
        setRemoveCurrentPhoto(false);
        setSaveStatus("idle");
      }
      setPhotoCameraOpen(false);
    } catch (err) {
      console.warn("Failed to take photo:", err);
    } finally {
      setTakingEditPhoto(false);
    }
  }, [takingEditPhoto]);

  const openScanner = useCallback(async () => {
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) return;
    }
    scannerLockRef.current = false;
    setScannerOpen(true);
  }, [permission, requestPermission]);

  const handleBarcodeScanned = useCallback(({ data }: { data: string }) => {
    if (scannerLockRef.current) return;
    scannerLockRef.current = true;
    setScannerOpen(false);
    const trimmed = data.trim();
    if (trimmed && !barcodes.includes(trimmed)) {
      setBarcodes(prev => [...prev, trimmed]);
      setSaveStatus("idle");
    }
  }, [barcodes]);

  const handleMeasureConfirm = useCallback((dims: PartDimensions) => {
    setMeasureOpen(false);
    setDimLength(fmtDim(dims.length));
    setDimWidth(fmtDim(dims.width));
    setDimHeight(fmtDim(dims.height));
    setDimDiameter(fmtDim(dims.diameter));
    setSaveStatus("idle");
  }, []);

  const addBin = () => {
    const t = newBin.trim();
    if (!t) { setNewBin(""); return; }
    if (bins.some(b => b.toLowerCase() === t.toLowerCase())) { setNewBin(""); return; }
    setBins([...bins, t]);
    setNewBin("");
    setSaveStatus("idle");
  };

  const addBarcode = () => {
    const t = newBarcode.trim();
    if (!t || barcodes.includes(t)) { setNewBarcode(""); return; }
    setBarcodes([...barcodes, t]);
    setNewBarcode("");
    setSaveStatus("idle");
  };

  const addKeyword = () => {
    const t = newKeyword.trim().toLowerCase();
    if (!t || keywords.includes(t)) { setNewKeyword(""); return; }
    setKeywords([...keywords, t]);
    setNewKeyword("");
    setSaveStatus("idle");
  };

  const handleSave = async () => {
    const current = itemRef.current;
    if (!current || !adminToken) return;
    setSaveStatus("saving");
    setErrorMsg(null);

    // Auto-add any pending barcode text before saving
    const pendingBarcode = newBarcode.trim();
    const finalBarcodes =
      pendingBarcode && !barcodes.includes(pendingBarcode)
        ? [...barcodes, pendingBarcode]
        : barcodes;
    if (finalBarcodes !== barcodes) {
      setBarcodes(finalBarcodes);
      setNewBarcode("");
    }

    // Build current dimensions object for comparison
    const newDims: PartDimensions = {
      length: parseDimField(dimLength),
      width: parseDimField(dimWidth),
      height: parseDimField(dimHeight),
      diameter: parseDimField(dimDiameter),
    };
    const oldDims = existingDims ?? {};
    const dimsChanged =
      newDims.length !== (oldDims.length ?? null) ||
      newDims.width !== (oldDims.width ?? null) ||
      newDims.height !== (oldDims.height ?? null) ||
      newDims.diameter !== (oldDims.diameter ?? null);

    try {
      const saves: Promise<unknown>[] = [];

      if (description.trim() !== (current.description ?? "").trim()) {
        saves.push(
          fetch(`${API_BASE}/inventory/${current.id}/description`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
            body: JSON.stringify({ description: description.trim() }),
          }).then(async (res) => {
            if (!res.ok) {
              const d = await res.json().catch(() => ({})) as { error?: string };
              throw new Error(d.error ?? `HTTP ${res.status}`);
            }
          }),
        );
      }

      if (JSON.stringify(bins) !== JSON.stringify(current.binLocations ?? [])) {
        saves.push(updateBinsMutation.mutateAsync({ id: current.id, data: { binLocations: bins } }));
      }

      if (JSON.stringify(finalBarcodes) !== JSON.stringify(current.barcodes ?? [])) {
        saves.push(updateBarcodesMutation.mutateAsync({ id: current.id, data: { barcodes: finalBarcodes } }));
      }

      if (JSON.stringify(keywords) !== JSON.stringify(current.aiKeywords ?? [])) {
        saves.push(updateKeywordsMutation.mutateAsync({ id: current.id, data: { keywords } }));
      }

      if (dimsChanged) {
        saves.push(
          fetch(`${API_BASE}/inventory/${current.id}/dimensions`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
            body: JSON.stringify(newDims),
          }).then(async (res) => {
            if (!res.ok) {
              const d = await res.json().catch(() => ({})) as { error?: string };
              throw new Error(d.error ?? `HTTP ${res.status}`);
            }
          }),
        );
      }

        let capturedImageUrl: string | null | undefined = undefined;

      if (newPhotoData) {
        saves.push(
          fetch(`${API_BASE}/inventory/${current.id}/photo`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
            body: JSON.stringify({ imageBase64: newPhotoData.base64, mimeType: "image/jpeg" }),
          }).then(async (res) => {
            if (!res.ok) {
              const d = await res.json().catch(() => ({})) as { error?: string };
              throw new Error(d.error ?? `HTTP ${res.status}`);
            }
            const d = await res.json() as { imageUrl?: string | null };
            capturedImageUrl = d.imageUrl ?? null;
          }),
        );
      } else if (removeCurrentPhoto && current.imageUrl) {
        saves.push(
          fetch(`${API_BASE}/inventory/${current.id}/photo`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
            body: JSON.stringify({ remove: true }),
          }).then(async (res) => {
            if (!res.ok) {
              const d = await res.json().catch(() => ({})) as { error?: string };
              throw new Error(d.error ?? `HTTP ${res.status}`);
            }
            capturedImageUrl = null;
          }),
        );
      }

      if (saves.length > 0) {
        await Promise.all(saves);
        const listKeyPrefix = getListInventoryQueryKey()[0];

        if (capturedImageUrl !== undefined) {
          const patchedImageUrl = capturedImageUrl;
          queryClient.setQueriesData<InventoryListResponse>(
            { predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === listKeyPrefix },
            (old) => {
              if (!old) return old;
              return {
                ...old,
                items: old.items.map((i) =>
                  i.id === current.id ? { ...i, imageUrl: patchedImageUrl } : i,
                ),
              };
            },
          );
          queryClient.setQueriesData<SearchInventoryResponse>(
            { predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === "searchInventory" },
            (old) => {
              if (!old) return old;
              const patchResult = (r: SearchInventoryResponse["results"][number]) =>
                r.item.id === current.id
                  ? { ...r, item: { ...r.item, imageUrl: patchedImageUrl } }
                  : r;
              return {
                ...old,
                results: old.results.map(patchResult),
                sizeUnknownResults: old.sizeUnknownResults?.map(patchResult),
              };
            },
          );
        }

        await invalidateAllCachesAfterSave({
          queryClient,
          asyncStorage: AsyncStorage,
          itemId: current.id,
        });
      }

      setSaveStatus("saved");
      setTimeout(() => router.back(), 500);
    } catch (err) {
      const msg = err && typeof err === "object" && "message" in err
        ? String((err as { message: unknown }).message) : "Save failed";
      setErrorMsg(
        msg.includes("401")
          ? "Admin session expired. Re-unlock and try again."
          : "Could not save changes. Check connection and try again.",
      );
      setSaveStatus("error");
    }
  };

  if (!item) {
    return (
      <SafeAreaView style={[s.safe, { backgroundColor: colors.background }]}>
        <View style={s.center}>
          <Text style={[s.errorText, { color: colors.destructive }]}>Item not found.</Text>
          <Pressable onPress={() => router.back()} style={[s.backBtn, { backgroundColor: colors.primary }]}>
            <Text style={[s.backBtnText, { color: colors.primaryForeground }]}>Go Back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const isSaving = saveStatus === "saving";
  const isSaved = saveStatus === "saved";

  const hasChanges =
    description.trim() !== (item.description ?? "").trim() ||
    JSON.stringify(bins) !== JSON.stringify(item.binLocations ?? []) ||
    JSON.stringify(barcodes) !== JSON.stringify(item.barcodes ?? []) ||
    JSON.stringify(keywords) !== JSON.stringify(item.aiKeywords ?? []) ||
    parseDimField(dimLength) !== (existingDims?.length ?? null) ||
    parseDimField(dimWidth) !== (existingDims?.width ?? null) ||
    parseDimField(dimHeight) !== (existingDims?.height ?? null) ||
    parseDimField(dimDiameter) !== (existingDims?.diameter ?? null) ||
    newPhotoData !== null ||
    (removeCurrentPhoto && !!item.imageUrl);

  const currentPhotoUri = removeCurrentPhoto
    ? null
    : (newPhotoData?.uri ?? item.imageUrl ?? null);

  const statusColor =
    isSaving ? colors.warning
    : isSaved ? colors.success
    : saveStatus === "error" ? colors.destructive
    : "transparent";
  const statusLabel =
    isSaving ? "Saving…" : isSaved ? "✓ Saved" : saveStatus === "error" ? "Save failed" : "";

  return (
    <SafeAreaView style={[s.safe, { backgroundColor: colors.background }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        {/* Header */}
        <View style={[s.header, { borderBottomColor: colors.border }]}>
          <Pressable onPress={() => router.back()} style={s.headerBack}>
            <Text style={[s.headerBackText, { color: colors.primary }]}>← Back</Text>
          </Pressable>
          <View style={s.headerCenter}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={[s.headerTitle, { color: colors.foreground }]}>Edit Part</Text>
              {saveStatus !== "idle" ? (
                <View style={[s.statusBadge, { backgroundColor: statusColor + "22" }]}>
                  {isSaving ? <ActivityIndicator size="small" color={statusColor} style={{ marginRight: 4 }} /> : null}
                  <Text style={[s.statusText, { color: statusColor }]}>{statusLabel}</Text>
                </View>
              ) : null}
            </View>
            <Text style={[s.headerSub, { color: colors.mutedForeground }]} numberOfLines={1}>
              {item.vendor} · {item.catalog}
            </Text>
          </View>
          <View style={{ minWidth: 60 }} />
        </View>

        <ScrollView
          ref={scrollViewRef}
          style={{ flex: 1 }}
          contentContainerStyle={s.scroll}
          keyboardShouldPersistTaps="handled"
        >
          {/* Photo */}
          <Text style={[s.sectionLabel, { color: colors.mutedForeground }]}>PHOTO</Text>
          <Text style={[s.fieldHint, { color: colors.mutedForeground }]}>
            {Platform.OS !== "web"
              ? "Take or replace the item photo. Tap ✕ to remove."
              : "Photo capture is only available on device."}
          </Text>
          <View style={s.photoRow}>
            {currentPhotoUri ? (
              <View style={s.photoThumbWrap}>
                <RetryImage uri={currentPhotoUri} style={s.photoThumb} resizeMode="cover" />
                <Pressable
                  onPress={() => { setRemoveCurrentPhoto(true); setNewPhotoData(null); setSaveStatus("idle"); }}
                  style={[s.photoRemoveBtn, { backgroundColor: colors.destructive }]}
                >
                  <Text style={{ color: "#fff", fontSize: 11, fontFamily: "Inter_700Bold" }}>✕</Text>
                </Pressable>
              </View>
            ) : (
              <View style={[s.photoPlaceholder, { backgroundColor: colors.muted, borderColor: colors.border }]}>
                <Feather name="image" size={26} color={colors.mutedForeground} />
                <Text style={[s.photoPlaceholderText, { color: colors.mutedForeground }]}>No photo</Text>
              </View>
            )}
            {Platform.OS !== "web" ? (
              <Pressable
                onPress={openPhotoCamera}
                style={[s.photoCameraBtn, { backgroundColor: colors.muted, borderColor: colors.border }]}
                accessibilityLabel="Take or replace item photo"
              >
                <Feather name="camera" size={20} color={colors.foreground} />
                <Text style={[s.photoCameraBtnText, { color: colors.foreground }]}>
                  {currentPhotoUri ? "Replace" : "Take Photo"}
                </Text>
              </Pressable>
            ) : null}
          </View>

          {/* Description */}
          <Text style={[s.sectionLabel, { color: colors.mutedForeground, marginTop: 24 }]}>DESCRIPTION</Text>
          <KeyboardDoneInput
            value={description}
            onChangeText={(v) => { setDescription(v); setSaveStatus("idle"); }}
            placeholder="Brief description of the part…"
            placeholderTextColor={colors.mutedForeground}
            multiline
            numberOfLines={3}
            style={[s.descInput, { backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground }]}
            autoCorrect
            autoCapitalize="sentences"
          />

          {/* Bins */}
          <View onLayout={(e) => { sectionYRef.current.bins = e.nativeEvent.layout.y; }}>
          <Text style={[s.sectionLabel, { color: colors.mutedForeground, marginTop: 24 }]}>
            BIN LOCATIONS ({bins.length})
          </Text>
          <Text style={[s.fieldHint, { color: colors.mutedForeground }]}>Tap a bin to remove it.</Text>
          <View style={s.chipRow}>
            {bins.map((b) => (
              <Pressable
                key={b}
                onPress={() => { setBins(bins.filter(x => x !== b)); setSaveStatus("idle"); }}
                style={[s.chip, { backgroundColor: colors.accent, borderColor: colors.primary + "44" }]}
              >
                <Text style={[s.chipText, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>{b}</Text>
                <Text style={[s.chipRemove, { color: colors.mutedForeground }]}>✕</Text>
              </Pressable>
            ))}
          </View>
          {bins.length === 0 ? (
            <Text style={[s.emptyHint, { color: colors.mutedForeground }]}>No bins assigned.</Text>
          ) : null}
          <View style={[s.addRow, { marginTop: 10 }]}>
            <KeyboardDoneInput
              value={newBin}
              onChangeText={setNewBin}
              placeholder="e.g. A1-04"
              placeholderTextColor={colors.mutedForeground}
              style={[s.addInput, { flex: 1, backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground }]}
              onSubmitEditing={addBin}
              returnKeyType="done"
              autoCorrect={false}
              autoCapitalize="characters"
            />
            <Pressable
              onPress={addBin}
              disabled={!newBin.trim()}
              style={[s.addBtn, { backgroundColor: newBin.trim() ? colors.primary : colors.muted }]}
            >
              <Text style={[s.addBtnText, { color: newBin.trim() ? colors.primaryForeground : colors.mutedForeground }]}>
                + Add
              </Text>
            </Pressable>
          </View>
          </View>

          {/* Barcodes */}
          <View onLayout={(e) => { sectionYRef.current.barcodes = e.nativeEvent.layout.y; }}>
          <Text style={[s.sectionLabel, { color: colors.mutedForeground, marginTop: 24 }]}>
            BARCODES ({barcodes.length})
          </Text>
          <Text style={[s.fieldHint, { color: colors.mutedForeground }]}>Tap a barcode to remove it.</Text>
          <View style={s.chipRow}>
            {barcodes.map((bc) => (
              <Pressable
                key={bc}
                onPress={() => { setBarcodes(barcodes.filter(x => x !== bc)); setSaveStatus("idle"); }}
                style={[s.chip, { backgroundColor: colors.accent, borderColor: colors.primary + "44" }]}
              >
                <Text style={[s.chipText, { color: colors.foreground }]}>{bc}</Text>
                <Text style={[s.chipRemove, { color: colors.mutedForeground }]}>✕</Text>
              </Pressable>
            ))}
          </View>
          {barcodes.length === 0 ? (
            <Text style={[s.emptyHint, { color: colors.mutedForeground }]}>No barcodes assigned.</Text>
          ) : null}
          <View style={[s.addRow, { marginTop: 10 }]}>
            <KeyboardDoneInput
              value={newBarcode}
              onChangeText={(v) => { setNewBarcode(v); setSaveStatus("idle"); }}
              placeholder="Type barcode…"
              placeholderTextColor={colors.mutedForeground}
              keyboardType="number-pad"
              style={[s.addInput, { flex: 1, backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground }]}
              onSubmitEditing={addBarcode}
              returnKeyType="done"
              autoCorrect={false}
              autoCapitalize="none"
            />
            {Platform.OS !== "web" ? (
              <Pressable
                onPress={openScanner}
                style={[s.scanBtn, { backgroundColor: colors.muted, borderColor: colors.border }]}
                accessibilityLabel="Scan barcode with camera"
              >
                <Feather name="camera" size={18} color={colors.foreground} />
              </Pressable>
            ) : null}
            <Pressable
              onPress={addBarcode}
              disabled={!newBarcode.trim()}
              style={[s.addBtn, { backgroundColor: newBarcode.trim() ? colors.primary : colors.muted }]}
            >
              <Text style={[s.addBtnText, { color: newBarcode.trim() ? colors.primaryForeground : colors.mutedForeground }]}>
                + Add
              </Text>
            </Pressable>
          </View>
          </View>

          {/* Dimensions */}
          <View style={[s.dimHeader, { marginTop: 24 }]}>
            <Text style={[s.sectionLabel, { color: colors.mutedForeground }]}>DIMENSIONS (mm)</Text>
            {Platform.OS === "ios" ? (
              lidarAvailable ? (
                <Pressable
                  onPress={() => {
                    const label = item ? `${item.vendor} · ${item.catalog}` : "";
                    // Navigate to the dedicated Measure tab — it stores confirmed
                    // dims in AppContext.pendingLidarDims and navigates back here,
                    // where useFocusEffect picks them up and pre-fills the form.
                    (router.navigate as (url: string) => void)(
                      `/(tabs)/measure?fromItemForm=true&itemLabel=${encodeURIComponent(label)}`
                    );
                  }}
                  style={[s.measureBtn, { backgroundColor: colors.primary + "18", borderColor: colors.primary + "55" }]}
                  accessibilityLabel="Measure dimensions with LiDAR"
                >
                  <Feather name="maximize-2" size={13} color={colors.primary} />
                  <Text style={[s.measureBtnText, { color: colors.primary }]}>LiDAR</Text>
                </Pressable>
              ) : (
                <Pressable
                  onPress={() => setMeasureOpen(true)}
                  style={[s.measureBtn, { backgroundColor: colors.primary + "18", borderColor: colors.primary + "55" }]}
                  accessibilityLabel="Estimate dimensions from photo"
                >
                  <Feather name="maximize" size={13} color={colors.primary} />
                  <Text style={[s.measureBtnText, { color: colors.primary }]}>Estimate</Text>
                </Pressable>
              )
            ) : null}
          </View>
          <Text style={[s.fieldHint, { color: colors.mutedForeground }]}>
            {Platform.OS === "ios"
              ? lidarAvailable
                ? "Tap LiDAR to measure precisely, or enter values manually. Leave blank if unknown."
                : "Tap Estimate to measure from a photo, or enter values manually. Leave blank if unknown."
              : "Enter physical dimensions in millimetres. Leave blank if unknown."}
          </Text>
          <View style={s.dimGrid}>
            <View style={s.dimField}>
              <Text style={[s.dimLabel, { color: colors.mutedForeground }]}>Length</Text>
              <KeyboardDoneInput
                value={dimLength}
                onChangeText={v => { setDimLength(v.replace(/[^0-9.]/g, "")); setSaveStatus("idle"); }}
                placeholder="–"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="numeric"
                style={[s.dimInput, { backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground }]}
              />
            </View>
            <View style={s.dimField}>
              <Text style={[s.dimLabel, { color: colors.mutedForeground }]}>Width</Text>
              <KeyboardDoneInput
                value={dimWidth}
                onChangeText={v => { setDimWidth(v.replace(/[^0-9.]/g, "")); setSaveStatus("idle"); }}
                placeholder="–"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="numeric"
                style={[s.dimInput, { backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground }]}
              />
            </View>
            <View style={s.dimField}>
              <Text style={[s.dimLabel, { color: colors.mutedForeground }]}>Height</Text>
              <KeyboardDoneInput
                value={dimHeight}
                onChangeText={v => { setDimHeight(v.replace(/[^0-9.]/g, "")); setSaveStatus("idle"); }}
                placeholder="–"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="numeric"
                style={[s.dimInput, { backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground }]}
              />
            </View>
            <View style={s.dimField}>
              <Text style={[s.dimLabel, { color: colors.mutedForeground }]}>Diameter</Text>
              <KeyboardDoneInput
                value={dimDiameter}
                onChangeText={v => { setDimDiameter(v.replace(/[^0-9.]/g, "")); setSaveStatus("idle"); }}
                placeholder="–"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="numeric"
                style={[s.dimInput, { backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground }]}
              />
            </View>
          </View>
          {(dimLength || dimWidth || dimHeight || dimDiameter) ? (
            <Text style={[s.dimSummary, { color: colors.primary }]}>
              {[
                dimLength && dimWidth && dimHeight && `${dimLength} × ${dimWidth} × ${dimHeight} mm`,
                dimDiameter && `⌀ ${dimDiameter} mm`,
              ].filter(Boolean).join("   ")}
            </Text>
          ) : null}

          {/* Keywords */}
          <View onLayout={(e) => { sectionYRef.current.keywords = e.nativeEvent.layout.y; }}>
          <Text style={[s.sectionLabel, { color: colors.mutedForeground, marginTop: 24 }]}>
            AI KEYWORDS ({keywords.length})
          </Text>
          <Text style={[s.fieldHint, { color: colors.mutedForeground }]}>Tap a keyword to remove it.</Text>
          <View style={s.chipRow}>
            {keywords.map((kw) => (
              <Pressable
                key={kw}
                onPress={() => { setKeywords(keywords.filter(k => k !== kw)); setSaveStatus("idle"); }}
                style={[s.chip, { backgroundColor: colors.accent, borderColor: colors.primary + "44" }]}
              >
                <Text style={[s.chipText, { color: colors.foreground }]}>{kw}</Text>
                <Text style={[s.chipRemove, { color: colors.mutedForeground }]}>✕</Text>
              </Pressable>
            ))}
          </View>
          {keywords.length === 0 ? (
            <Text style={[s.emptyHint, { color: colors.mutedForeground }]}>No keywords yet. Add some below.</Text>
          ) : null}
          <View style={[s.addRow, { marginTop: 10 }]}>
            <KeyboardDoneInput
              value={newKeyword}
              onChangeText={setNewKeyword}
              placeholder="Type keyword and press Add…"
              placeholderTextColor={colors.mutedForeground}
              style={[s.addInput, { flex: 1, backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground }]}
              onSubmitEditing={addKeyword}
              returnKeyType="done"
              autoCorrect={false}
              autoCapitalize="none"
            />
            <Pressable
              onPress={addKeyword}
              disabled={!newKeyword.trim()}
              style={[s.addBtn, { backgroundColor: newKeyword.trim() ? colors.primary : colors.muted }]}
            >
              <Text style={[s.addBtnText, { color: newKeyword.trim() ? colors.primaryForeground : colors.mutedForeground }]}>
                + Add
              </Text>
            </Pressable>
          </View>
          </View>

          {errorMsg ? (
            <View style={[s.errorBanner, { backgroundColor: colors.destructive + "14", borderColor: colors.destructive + "55" }]}>
              <Text style={[s.errorText, { color: colors.destructive }]}>{errorMsg}</Text>
            </View>
          ) : null}
        </ScrollView>

        {/* Footer */}
        <View style={[s.footer, { borderTopColor: colors.border }]}>
          <Pressable
            onPress={() => router.back()}
            style={[s.cancelBtn, { borderColor: colors.border }]}
          >
            <Text style={[s.cancelBtnText, { color: colors.foreground }]}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={handleSave}
            disabled={isSaving || (!hasChanges && saveStatus !== "error")}
            style={[
              s.saveBtn,
              { backgroundColor: isSaving || (!hasChanges && saveStatus !== "error") ? colors.muted : colors.primary },
            ]}
          >
            {isSaving ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text
                style={[
                  s.saveBtnText,
                  { color: isSaving || (!hasChanges && saveStatus !== "error") ? colors.mutedForeground : colors.primaryForeground },
                ]}
              >
                Save Details
              </Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>

      {/* Barcode scanner modal — native only */}
      {Platform.OS !== "web" ? (
        <Modal
          visible={scannerOpen}
          animationType="slide"
          onRequestClose={() => setScannerOpen(false)}
        >
          <View style={s.scanModal}>
            <CameraView
              style={StyleSheet.absoluteFill}
              onBarcodeScanned={handleBarcodeScanned}
              barcodeScannerSettings={{
                barcodeTypes: ["ean13", "ean8", "code128", "code39", "upc_a", "upc_e", "qr"],
              }}
            />
            {/* Viewfinder overlay */}
            <View style={s.scanOverlay}>
              <View style={s.scanHeader}>
                <Pressable onPress={() => setScannerOpen(false)} style={s.scanCloseBtn}>
                  <Feather name="x" size={20} color="#fff" />
                </Pressable>
                <Text style={s.scanTitle}>Scan Barcode</Text>
                <View style={{ width: 40 }} />
              </View>
              <View style={s.viewfinderWrapper}>
                <View style={s.viewfinder}>
                  <View style={[s.vfCorner, s.vfTL]} />
                  <View style={[s.vfCorner, s.vfTR]} />
                  <View style={[s.vfCorner, s.vfBL]} />
                  <View style={[s.vfCorner, s.vfBR]} />
                </View>
              </View>
              <Text style={s.scanHint}>Point at a barcode to add it automatically</Text>
            </View>
          </View>
        </Modal>
      ) : null}

      {/* Measure modal — iOS only (LiDAR or AI Vision estimate) */}
      {Platform.OS === "ios" ? (
        <MeasurePartScreen
          visible={measureOpen}
          onClose={() => setMeasureOpen(false)}
          onConfirm={handleMeasureConfirm}
          initialDims={existingDims}
          adminToken={adminToken ?? ""}
        />
      ) : null}

      {/* Photo camera modal — native only */}
      {Platform.OS !== "web" ? (
        <Modal
          visible={photoCameraOpen}
          animationType="slide"
          onRequestClose={() => setPhotoCameraOpen(false)}
        >
          <View style={s.scanModal}>
            <CameraView
              ref={photoCameraRef}
              style={StyleSheet.absoluteFill}
              mode="picture"
              facing="back"
            />
            <View style={s.scanOverlay}>
              <View style={s.scanHeader}>
                <Pressable onPress={() => setPhotoCameraOpen(false)} style={s.scanCloseBtn}>
                  <Feather name="x" size={20} color="#fff" />
                </Pressable>
                <Text style={s.scanTitle}>Capture Item Photo</Text>
                <View style={{ width: 40 }} />
              </View>
              <View style={{ flex: 1 }} />
              <View style={s.photoShutterRow}>
                <Pressable
                  onPress={handleTakeEditPhoto}
                  disabled={takingEditPhoto}
                  style={[s.photoShutterBtn, { opacity: takingEditPhoto ? 0.6 : 1 }]}
                >
                  {takingEditPhoto ? (
                    <ActivityIndicator size="large" color="#fff" />
                  ) : (
                    <View style={s.photoShutterInner} />
                  )}
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      ) : null}
    </SafeAreaView>
  );
}

const CORNER = 20;
const CORNER_W = 3;

const s = StyleSheet.create({
  safe: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 16 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderBottomWidth: 1,
    gap: 8,
  },
  headerBack: { minWidth: 60 },
  headerBackText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  headerCenter: { flex: 1, alignItems: "center" },
  headerTitle: { fontSize: 17, fontFamily: "Inter_700Bold" },
  headerSub: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    gap: 3,
  },
  statusText: { fontSize: 12, fontFamily: "Inter_500Medium" },
  scroll: { padding: 16, paddingBottom: 32 },
  sectionLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  fieldHint: { fontSize: 12, fontFamily: "Inter_400Regular", fontStyle: "italic", marginBottom: 10, lineHeight: 16 },
  descInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    minHeight: 80,
    textAlignVertical: "top",
    lineHeight: 20,
  },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    gap: 6,
  },
  chipText: { fontSize: 13, fontFamily: "Inter_400Regular" },
  chipRemove: { fontSize: 11 },
  emptyHint: { fontSize: 13, fontFamily: "Inter_400Regular", fontStyle: "italic" },
  addRow: { flexDirection: "row", gap: 8 },
  addInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  scanBtn: {
    width: 44,
    borderWidth: 1,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  addBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, justifyContent: "center" },
  addBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  // Dimensions
  dimHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  measureBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
  },
  measureBtnText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  dimGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  dimField: { width: "47%" },
  dimLabel: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  dimInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
  },
  dimSummary: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    marginTop: 8,
    textAlign: "center",
    letterSpacing: 0.3,
  },
  errorBanner: { marginTop: 16, borderRadius: 8, borderWidth: 1, padding: 12 },
  errorText: { fontSize: 13, fontFamily: "Inter_500Medium", lineHeight: 18 },
  footer: { flexDirection: "row", padding: 16, borderTopWidth: 1, gap: 10 },
  cancelBtn: { flex: 1, borderWidth: 1, borderRadius: 8, paddingVertical: 14, alignItems: "center" },
  cancelBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  saveBtn: { flex: 2, borderRadius: 8, paddingVertical: 14, alignItems: "center" },
  saveBtnText: { fontSize: 15, fontFamily: "Inter_700Bold" },
  backBtn: { paddingHorizontal: 24, paddingVertical: 12, borderRadius: 8 },
  backBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  // Scanner modal
  scanModal: { flex: 1, backgroundColor: "#000" },
  scanOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "space-between",
    paddingBottom: 48,
  },
  scanHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 56,
    paddingBottom: 16,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  scanCloseBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  scanTitle: { color: "#fff", fontSize: 17, fontFamily: "Inter_600SemiBold" },
  viewfinderWrapper: { flex: 1, alignItems: "center", justifyContent: "center" },
  viewfinder: { width: 260, height: 160, position: "relative" },
  vfCorner: {
    position: "absolute",
    width: CORNER,
    height: CORNER,
    borderColor: "#fff",
  },
  vfTL: { top: 0, left: 0, borderTopWidth: CORNER_W, borderLeftWidth: CORNER_W },
  vfTR: { top: 0, right: 0, borderTopWidth: CORNER_W, borderRightWidth: CORNER_W },
  vfBL: { bottom: 0, left: 0, borderBottomWidth: CORNER_W, borderLeftWidth: CORNER_W },
  vfBR: { bottom: 0, right: 0, borderBottomWidth: CORNER_W, borderRightWidth: CORNER_W },
  scanHint: {
    color: "rgba(255,255,255,0.75)",
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    paddingHorizontal: 32,
  },
  photoRow: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 8 },
  photoThumbWrap: { position: "relative", width: 80, height: 80 },
  photoThumb: { width: 80, height: 80, borderRadius: 8 },
  photoRemoveBtn: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  photoPlaceholder: {
    width: 80,
    height: 80,
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  photoPlaceholderText: { fontSize: 10, fontFamily: "Inter_400Regular" },
  photoCameraBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  photoCameraBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  photoShutterRow: {
    alignItems: "center",
    paddingBottom: 56,
  },
  photoShutterBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: "rgba(255,255,255,0.25)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 3,
    borderColor: "#fff",
  },
  photoShutterInner: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#fff",
  },
});
