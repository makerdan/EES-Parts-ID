import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Modal,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { Feather } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import type { InventoryItem, InventoryListResponse, SearchInventoryResponse } from "@workspace/api-client-react";
import { useUpdateItemBins, useUpdateItemKeywords } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { getListInventoryQueryKey } from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";
import { DismissKeyboard } from "@/components/DismissKeyboard";
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
  : "";

if (__DEV__ && !process.env.EXPO_PUBLIC_DOMAIN) {
  // eslint-disable-next-line no-console
  console.error(
    "[PartDetailsEditor] EXPO_PUBLIC_DOMAIN is not set — all API calls will fail. " +
    "Set the environment variable before starting the dev server.",
  );
}

function fmtDim(v: number | null | undefined): string {
  if (v == null) return "";
  return String(v);
}

function parseDimField(s: string): number | null {
  const n = parseFloat(s);
  return isNaN(n) || n < 0 ? null : Math.round(n * 10) / 10;
}

interface PartDetailsEditorProps {
  item: InventoryItem | null;
  adminToken: string | null;
  onClose: () => void;
  onShowOnMap?: (item: InventoryItem) => void;
}

/**
 * Combined full-part editor opened after a successful quick-add.
 * Lets admins fill in description, bin locations, keywords, and dimensions
 * in one place without navigating to the Upload tab.
 *
 * On iOS devices with LiDAR a "LiDAR" shortcut appears in the dimensions
 * section so admins can capture measurements without navigating to Edit.
 * On non-LiDAR iOS devices the "Estimate" (photo AI) path is shown instead.
 * Android and Web see neither — manual entry only.
 */
export function PartDetailsEditor({ item, adminToken, onClose, onShowOnMap }: PartDetailsEditorProps) {
  "use no memo";
  const colors = useColors();
  const queryClient = useQueryClient();
  const updateBinsMutation = useUpdateItemBins();
  const updateKeywordsMutation = useUpdateItemKeywords();
  const [description, setDescription] = useState(item?.description ?? "");
  const [bins, setBins] = useState<string[]>(item?.binLocations ?? []);
  const [newBin, setNewBin] = useState("");
  const [keywords, setKeywords] = useState<string[]>(item?.aiKeywords ?? []);
  const [newKeyword, setNewKeyword] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [fieldSaveErrors, setFieldSaveErrors] = useState<{
    description?: string;
    bins?: string;
    keywords?: string;
    dimensions?: string;
    photo?: string;
  }>({});

  // Dimensions state
  const existingDims = (item as unknown as { dimensions?: PartDimensions | null })?.dimensions;
  const [dimLength, setDimLength] = useState(fmtDim(existingDims?.length));
  const [dimWidth, setDimWidth] = useState(fmtDim(existingDims?.width));
  const [dimHeight, setDimHeight] = useState(fmtDim(existingDims?.height));
  const [dimDiameter, setDimDiameter] = useState(fmtDim(existingDims?.diameter));
  const [measureOpen, setMeasureOpen] = useState(false);
  const [lidarAvailable, setLidarAvailable] = useState(false);

  useEffect(() => {
    setLidarAvailable(isLiDARSupported());
  }, []);

  // Photo state
  const [newPhotoData, setNewPhotoData] = useState<CapturedPhoto | null>(null);
  const [removeCurrentPhoto, setRemoveCurrentPhoto] = useState(false);
  const [photoCameraOpen, setPhotoCameraOpen] = useState(false);
  const [takingPhoto, setTakingPhoto] = useState(false);
  const photoCameraRef = useRef<CameraView>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  const itemRef = useRef(item);
  useEffect(() => { itemRef.current = item; }, [item]);

  const [copiedBin, setCopiedBin] = useState<string | null>(null);
  const copyBinTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopyBin = useCallback(async (bin: string) => {
    await Clipboard.setStringAsync(bin);
    setCopiedBin(bin);
    if (copyBinTimeoutRef.current) clearTimeout(copyBinTimeoutRef.current);
    copyBinTimeoutRef.current = setTimeout(() => {
      copyBinTimeoutRef.current = null;
      setCopiedBin(null);
    }, 2000);
  }, []);

  const dimStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (dimStatusTimerRef.current) clearTimeout(dimStatusTimerRef.current);
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      if (copyBinTimeoutRef.current) clearTimeout(copyBinTimeoutRef.current);
    };
  }, []);

  const openPhotoCamera = useCallback(async () => {
    if (!cameraPermission?.granted) {
      const result = await requestCameraPermission();
      if (!result.granted) return;
    }
    setTakingPhoto(false);
    setPhotoCameraOpen(true);
  }, [cameraPermission, requestCameraPermission]);

  const handleTakePhoto = useCallback(async () => {
    if (takingPhoto || !photoCameraRef.current) return;
    setTakingPhoto(true);
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
      setTakingPhoto(false);
    }
  }, [takingPhoto]);

  useEffect(() => {
    const current = itemRef.current;
    if (!current) return;
    const dims = (current as unknown as { dimensions?: PartDimensions | null })?.dimensions;
    setDescription(current.description ?? "");
    setBins(current.binLocations ?? []);
    setKeywords(current.aiKeywords ?? []);
    setNewBin("");
    setNewKeyword("");
    setNewPhotoData(null);
    setRemoveCurrentPhoto(false);
    setSaveStatus("idle");
    setErrorMsg(null);
    setFieldSaveErrors({});
    setCopiedBin(null);
    if (copyBinTimeoutRef.current) { clearTimeout(copyBinTimeoutRef.current); copyBinTimeoutRef.current = null; }
    setDimLength(fmtDim(dims?.length));
    setDimWidth(fmtDim(dims?.width));
    setDimHeight(fmtDim(dims?.height));
    setDimDiameter(fmtDim(dims?.diameter));
    setDimSaveStatus("idle");
    setDimSaveError(null);
    dimAutoSavedRef.current = null;
  }, [item?.id]);

  const addBin = () => {
    const trimmed = newBin.trim();
    if (!trimmed) { setNewBin(""); return; }
    if (bins.some((b) => b.toLowerCase() === trimmed.toLowerCase())) { setNewBin(""); return; }
    setBins([...bins, trimmed]);
    setNewBin("");
  };

  const removeBin = (bin: string) => setBins(bins.filter((b) => b !== bin));

  const addKeyword = () => {
    const trimmed = newKeyword.trim().toLowerCase();
    if (!trimmed || keywords.includes(trimmed)) { setNewKeyword(""); return; }
    setKeywords([...keywords, trimmed]);
    setNewKeyword("");
  };

  const removeKeyword = (kw: string) => setKeywords(keywords.filter((k) => k !== kw));

  const [dimSaveStatus, setDimSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [dimSaveError, setDimSaveError] = useState<string | null>(null);
  // Tracks the dims that handleMeasureConfirm has already persisted, so
  // handleSave won't send a redundant PATCH for the same values.
  const dimAutoSavedRef = useRef<PartDimensions | null>(null);

  const handleMeasureConfirm = useCallback(async (dims: PartDimensions) => {
    setMeasureOpen(false);
    setDimLength(fmtDim(dims.length));
    setDimWidth(fmtDim(dims.width));
    setDimHeight(fmtDim(dims.height));
    setDimDiameter(fmtDim(dims.diameter));

    const current = itemRef.current;
    if (!current || !adminToken) return;

    setDimSaveStatus("saving");
    setDimSaveError(null);
    try {
      const res = await fetch(`${API_BASE}/inventory/${current.id}/dimensions`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify(dims),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const listKeyPrefix = getListInventoryQueryKey()[0];
      await queryClient.invalidateQueries({
        predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === listKeyPrefix,
      });
      await queryClient.invalidateQueries({ queryKey: ["searchInventory"] });
      // Store as parsed values so dimsAlreadySaved can compare apples-to-apples
      // with what parseDimField(fmtDim(x)) would produce from the display string.
      dimAutoSavedRef.current = {
        length: parseDimField(fmtDim(dims.length)),
        width: parseDimField(fmtDim(dims.width)),
        height: parseDimField(fmtDim(dims.height)),
        diameter: parseDimField(fmtDim(dims.diameter)),
      };
      setDimSaveStatus("saved");
      if (dimStatusTimerRef.current) clearTimeout(dimStatusTimerRef.current);
      dimStatusTimerRef.current = setTimeout(() => { dimStatusTimerRef.current = null; setDimSaveStatus("idle"); }, 2500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Save failed";
      setDimSaveError(
        msg.includes("401")
          ? "Admin session expired — re-unlock and try again."
          : "Could not save dimensions — check connection.",
      );
      setDimSaveStatus("error");
    }
  }, [adminToken, queryClient]);

  const handleSave = async () => {
    const current = itemRef.current;
    if (!current || !adminToken) return;
    setSaveStatus("saving");
    setErrorMsg(null);
    setFieldSaveErrors({});

    type SaveOp = {
      field: "description" | "bins" | "keywords" | "dimensions" | "photo";
      promise: Promise<unknown>;
      restoreFn: () => void;
    };

    const ops: SaveOp[] = [];

    if (description.trim() !== (current.description ?? "").trim()) {
      ops.push({
        field: "description",
        restoreFn: () => setDescription(current.description ?? ""),
        promise: fetch(`${API_BASE}/inventory/${current.id}/description`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({ description: description.trim() }),
        }).then(async (res) => {
          if (!res.ok) {
            const data = await res.json().catch(() => ({})) as { error?: string };
            throw new Error(data.error ?? `HTTP ${res.status}`);
          }
        }),
      });
    }

    const binsChanged = JSON.stringify(bins) !== JSON.stringify(current.binLocations ?? []);
    if (binsChanged) {
      ops.push({
        field: "bins",
        restoreFn: () => setBins(current.binLocations ?? []),
        promise: updateBinsMutation.mutateAsync({ id: current.id, data: { binLocations: bins } }),
      });
    }

    const kwChanged = JSON.stringify(keywords) !== JSON.stringify(current.aiKeywords ?? []);
    if (kwChanged) {
      ops.push({
        field: "keywords",
        restoreFn: () => setKeywords(current.aiKeywords ?? []),
        promise: updateKeywordsMutation.mutateAsync({ id: current.id, data: { keywords } }),
      });
    }

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

    // Skip the PATCH if handleMeasureConfirm already persisted these exact values.
    const autoSaved = dimAutoSavedRef.current;
    const dimsAlreadySaved = autoSaved !== null &&
      newDims.length === (autoSaved.length ?? null) &&
      newDims.width === (autoSaved.width ?? null) &&
      newDims.height === (autoSaved.height ?? null) &&
      newDims.diameter === (autoSaved.diameter ?? null);

    if (dimsChanged && !dimsAlreadySaved) {
      ops.push({
        field: "dimensions",
        restoreFn: () => {
          setDimLength(fmtDim(existingDims?.length));
          setDimWidth(fmtDim(existingDims?.width));
          setDimHeight(fmtDim(existingDims?.height));
          setDimDiameter(fmtDim(existingDims?.diameter));
        },
        promise: fetch(`${API_BASE}/inventory/${current.id}/dimensions`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify(newDims),
        }).then(async (res) => {
          if (!res.ok) {
            const data = await res.json().catch(() => ({})) as { error?: string };
            throw new Error(data.error ?? `HTTP ${res.status}`);
          }
        }),
      });
    }

    let capturedImageUrl: string | null | undefined = undefined;

    if (newPhotoData) {
      ops.push({
        field: "photo",
        restoreFn: () => {},
        promise: fetch(`${API_BASE}/inventory/${current.id}/photo`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
          body: JSON.stringify({ imageBase64: newPhotoData.base64, mimeType: "image/jpeg" }),
        }).then(async (res) => {
          if (!res.ok) {
            const data = await res.json().catch(() => ({})) as { error?: string };
            throw new Error(data.error ?? `HTTP ${res.status}`);
          }
          const data = await res.json() as { imageUrl?: string | null };
          capturedImageUrl = data.imageUrl ?? null;
        }),
      });
    } else if (removeCurrentPhoto && current.imageUrl) {
      ops.push({
        field: "photo",
        restoreFn: () => setRemoveCurrentPhoto(false),
        promise: fetch(`${API_BASE}/inventory/${current.id}/photo`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
          body: JSON.stringify({ remove: true }),
        }).then(async (res) => {
          if (!res.ok) {
            const data = await res.json().catch(() => ({})) as { error?: string };
            throw new Error(data.error ?? `HTTP ${res.status}`);
          }
          capturedImageUrl = null;
        }),
      });
    }

    if (ops.length === 0) {
      setSaveStatus("idle");
      return;
    }

    const results = await Promise.allSettled(ops.map((o) => o.promise));
    const newFieldErrors: typeof fieldSaveErrors = {};
    let anyFailed = false;

    results.forEach((result, i) => {
      if (result.status === "rejected") {
        anyFailed = true;
        ops[i].restoreFn();
        const msg =
          result.reason instanceof Error ? result.reason.message : "Save failed";
        newFieldErrors[ops[i].field] = msg.includes("401")
          ? "Session expired — re-unlock admin access"
          : "Could not save — check connection";
      }
    });

    if (anyFailed) {
      setFieldSaveErrors(newFieldErrors);
      setSaveStatus("error");
    } else {
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

      await queryClient.invalidateQueries({
        predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === listKeyPrefix,
      });
      await queryClient.invalidateQueries({ queryKey: ["searchInventory"] });
      setSaveStatus("saved");
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      closeTimerRef.current = setTimeout(() => { closeTimerRef.current = null; onClose(); }, 500);
    }
  };

  if (!item) return null;

  const isSaving = saveStatus === "saving";
  const isSaved = saveStatus === "saved";

  const hasChanges =
    description.trim() !== (item.description ?? "").trim() ||
    JSON.stringify(bins) !== JSON.stringify(item.binLocations ?? []) ||
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
    isSaving ? "Saving…"
    : isSaved ? "✓ Saved"
    : saveStatus === "error" ? "Save failed"
    : "";

  return (
    <>
      <Modal
        visible
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={onClose}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={[styles.container, { backgroundColor: colors.background }]}
        >
          <DismissKeyboard>
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={[styles.title, { color: colors.foreground }]}>Edit Part</Text>
                {saveStatus !== "idle" && (
                  <View style={[styles.statusBadge, { backgroundColor: statusColor + "22" }]}>
                    {isSaving ? (
                      <ActivityIndicator size="small" color={statusColor} style={{ marginRight: 4 }} />
                    ) : null}
                    <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
                  </View>
                )}
              </View>
              <Text style={[styles.sub, { color: colors.mutedForeground }]} numberOfLines={1}>
                {item.vendor} · {item.catalog}
              </Text>
            </View>
            <Pressable
              onPress={onClose}
              style={[styles.closeBtn, { backgroundColor: colors.muted }]}
            >
              <Text style={{ color: colors.foreground, fontSize: 14 }}>✕</Text>
            </Pressable>
          </View>

          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={[styles.hint, { color: colors.mutedForeground }]}>
              Edit this part's photo, description, bin locations, keywords, and dimensions.
            </Text>

            {/* Photo */}
            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>PHOTO</Text>
            <Text style={[styles.fieldHint, { color: colors.mutedForeground }]}>
              {Platform.OS !== "web"
                ? "Take or replace the item photo. Tap ✕ to remove."
                : "Photo capture is only available on device."}
            </Text>
            <View style={styles.photoRow}>
              {currentPhotoUri ? (
                <View style={styles.photoThumbWrap}>
                  <RetryImage uri={currentPhotoUri} style={styles.photoThumb} resizeMode="cover" />
                  <Pressable
                    onPress={() => { setRemoveCurrentPhoto(true); setNewPhotoData(null); setSaveStatus("idle"); }}
                    style={[styles.photoRemoveBtn, { backgroundColor: colors.destructive }]}
                  >
                    <Text style={{ color: "#fff", fontSize: 11, fontFamily: "Inter_700Bold" }}>✕</Text>
                  </Pressable>
                </View>
              ) : (
                <View style={[styles.photoPlaceholder, { backgroundColor: colors.muted, borderColor: colors.border }]}>
                  <Feather name="image" size={26} color={colors.mutedForeground} />
                  <Text style={[styles.photoPlaceholderText, { color: colors.mutedForeground }]}>No photo</Text>
                </View>
              )}
              {Platform.OS !== "web" ? (
                <Pressable
                  onPress={openPhotoCamera}
                  style={[styles.photoCameraBtn, { backgroundColor: colors.muted, borderColor: colors.border }]}
                  accessibilityLabel="Take or replace item photo"
                >
                  <Feather name="camera" size={20} color={colors.foreground} />
                  <Text style={[styles.photoCameraBtnText, { color: colors.foreground }]}>
                    {currentPhotoUri ? "Replace" : "Take Photo"}
                  </Text>
                </Pressable>
              ) : null}
            </View>
            {fieldSaveErrors.photo ? (
              <Text style={[styles.fieldErrorText, { color: colors.destructive }]}>{fieldSaveErrors.photo}</Text>
            ) : null}

            {/* Description */}
            <Text style={[styles.sectionLabel, { color: colors.mutedForeground, marginTop: 20 }]}>DESCRIPTION</Text>
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder="Brief description of the part…"
              placeholderTextColor={colors.mutedForeground}
              multiline
              numberOfLines={3}
              style={[
                styles.descInput,
                { backgroundColor: colors.muted, borderColor: fieldSaveErrors.description ? colors.destructive : colors.border, color: colors.foreground },
              ]}
              autoCorrect
              autoCapitalize="sentences"
              returnKeyType="default"
            />
            {fieldSaveErrors.description ? (
              <Text style={[styles.fieldErrorText, { color: colors.destructive }]}>{fieldSaveErrors.description}</Text>
            ) : null}

            {/* Bin Locations */}
            <Text style={[styles.sectionLabel, { color: colors.mutedForeground, marginTop: 20 }]}>
              BIN LOCATIONS ({bins.length})
            </Text>
            <Text style={[styles.fieldHint, { color: colors.mutedForeground }]}>
              Tap a bin to copy it. Tap ✕ to remove.
            </Text>
            <View style={styles.chipRow}>
              {bins.map((b) => (
                <View
                  key={b}
                  style={[styles.chip, { backgroundColor: colors.accent, borderColor: copiedBin === b ? colors.success : colors.primary + "44" }]}
                >
                  <Pressable
                    onPress={() => handleCopyBin(b)}
                    style={styles.chipCopyArea}
                    accessibilityLabel={`Copy bin ${b}`}
                  >
                    <Text style={[styles.chipText, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>{b}</Text>
                    <Text style={[styles.chipHint, { color: copiedBin === b ? colors.success : colors.mutedForeground }]}>
                      {copiedBin === b ? "Copied!" : "Tap to copy"}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => removeBin(b)}
                    style={styles.chipRemoveBtn}
                    accessibilityLabel={`Remove bin ${b}`}
                  >
                    <Text style={[styles.chipRemove, { color: colors.mutedForeground }]}>✕</Text>
                  </Pressable>
                </View>
              ))}
            </View>
            {fieldSaveErrors.bins ? (
              <Text style={[styles.fieldErrorText, { color: colors.destructive }]}>{fieldSaveErrors.bins}</Text>
            ) : null}
            {bins.length === 0 && (
              <Text style={[styles.emptyHint, { color: colors.mutedForeground }]}>
                No additional bins. The initial bin was added on creation.
              </Text>
            )}
            <View style={[styles.addRow, { marginTop: 10 }]}>
              <TextInput
                value={newBin}
                onChangeText={setNewBin}
                placeholder="e.g. A1-04"
                placeholderTextColor={colors.mutedForeground}
                style={[
                  styles.addInput,
                  { flex: 1, backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground },
                ]}
                onSubmitEditing={addBin}
                returnKeyType="done"
                autoCorrect={false}
                autoCapitalize="characters"
              />
              <Pressable
                onPress={addBin}
                disabled={!newBin.trim()}
                style={[
                  styles.addBtn,
                  { backgroundColor: newBin.trim() ? colors.primary : colors.muted },
                ]}
              >
                <Text
                  style={[
                    styles.addBtnText,
                    { color: newBin.trim() ? colors.primaryForeground : colors.mutedForeground },
                  ]}
                >
                  + Add
                </Text>
              </Pressable>
            </View>

            {/* Keywords */}
            <Text style={[styles.sectionLabel, { color: colors.mutedForeground, marginTop: 24 }]}>
              KEYWORDS ({keywords.length})
            </Text>
            <Text style={[styles.fieldHint, { color: colors.mutedForeground }]}>
              Tap a keyword to remove it.
            </Text>
            <View style={styles.chipRow}>
              {keywords.map((kw) => (
                <Pressable
                  key={kw}
                  onPress={() => removeKeyword(kw)}
                  style={[styles.chip, { backgroundColor: colors.accent, borderColor: colors.primary + "44" }]}
                >
                  <Text style={[styles.chipText, { color: colors.foreground }]}>{kw}</Text>
                  <Text style={[styles.chipRemove, { color: colors.mutedForeground }]}>✕</Text>
                </Pressable>
              ))}
            </View>
            {fieldSaveErrors.keywords ? (
              <Text style={[styles.fieldErrorText, { color: colors.destructive }]}>{fieldSaveErrors.keywords}</Text>
            ) : null}
            {keywords.length === 0 && (
              <Text style={[styles.emptyHint, { color: colors.mutedForeground }]}>
                No keywords yet. Add some below.
              </Text>
            )}
            <View style={[styles.addRow, { marginTop: 10 }]}>
              <TextInput
                value={newKeyword}
                onChangeText={setNewKeyword}
                placeholder="Type keyword and press Add…"
                placeholderTextColor={colors.mutedForeground}
                style={[
                  styles.addInput,
                  { flex: 1, backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground },
                ]}
                onSubmitEditing={addKeyword}
                returnKeyType="done"
                autoCorrect={false}
                autoCapitalize="none"
              />
              <Pressable
                onPress={addKeyword}
                style={[styles.addBtn, { backgroundColor: colors.primary }]}
              >
                <Text style={[styles.addBtnText, { color: colors.primaryForeground }]}>+ Add</Text>
              </Pressable>
            </View>

            {/* Dimensions */}
            <View style={[styles.dimHeader, { marginTop: 24 }]}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>DIMENSIONS (mm)</Text>
                {dimSaveStatus === "saving" ? (
                  <ActivityIndicator size="small" color={colors.warning} />
                ) : dimSaveStatus === "saved" ? (
                  <Text style={[styles.dimStatusText, { color: colors.success }]}>✓ Saved</Text>
                ) : dimSaveStatus === "error" ? (
                  <Text style={[styles.dimStatusText, { color: colors.destructive }]}>Save failed</Text>
                ) : null}
              </View>
              {Platform.OS === "ios" ? (
                lidarAvailable ? (
                  <Pressable
                    onPress={() => setMeasureOpen(true)}
                    style={[styles.measureBtn, { backgroundColor: colors.primary + "18", borderColor: colors.primary + "55" }]}
                    accessibilityLabel="Measure dimensions with LiDAR"
                  >
                    <Feather name="maximize-2" size={13} color={colors.primary} />
                    <Text style={[styles.measureBtnText, { color: colors.primary }]}>LiDAR</Text>
                  </Pressable>
                ) : (
                  <Pressable
                    onPress={() => setMeasureOpen(true)}
                    style={[styles.measureBtn, { backgroundColor: colors.primary + "18", borderColor: colors.primary + "55" }]}
                    accessibilityLabel="Estimate dimensions from photo"
                  >
                    <Feather name="maximize" size={13} color={colors.primary} />
                    <Text style={[styles.measureBtnText, { color: colors.primary }]}>Estimate</Text>
                  </Pressable>
                )
              ) : null}
            </View>
            <Text style={[styles.fieldHint, { color: colors.mutedForeground }]}>
              {Platform.OS === "ios"
                ? lidarAvailable
                  ? "Tap LiDAR to measure precisely, or enter values manually. Leave blank if unknown."
                  : "Tap Estimate to measure from a photo, or enter values manually. Leave blank if unknown."
                : "Enter physical dimensions in millimetres. Leave blank if unknown."}
            </Text>
            <View style={styles.dimGrid}>
              <View style={styles.dimField}>
                <Text style={[styles.dimLabel, { color: colors.mutedForeground }]}>Length</Text>
                <TextInput
                  value={dimLength}
                  onChangeText={v => { setDimLength(v.replace(/[^0-9.]/g, "")); setSaveStatus("idle"); }}
                  placeholder="–"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="numeric"
                  style={[styles.dimInput, { backgroundColor: colors.muted, borderColor: fieldSaveErrors.dimensions ? colors.destructive : colors.border, color: colors.foreground }]}
                />
              </View>
              <View style={styles.dimField}>
                <Text style={[styles.dimLabel, { color: colors.mutedForeground }]}>Width</Text>
                <TextInput
                  value={dimWidth}
                  onChangeText={v => { setDimWidth(v.replace(/[^0-9.]/g, "")); setSaveStatus("idle"); }}
                  placeholder="–"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="numeric"
                  style={[styles.dimInput, { backgroundColor: colors.muted, borderColor: fieldSaveErrors.dimensions ? colors.destructive : colors.border, color: colors.foreground }]}
                />
              </View>
              <View style={styles.dimField}>
                <Text style={[styles.dimLabel, { color: colors.mutedForeground }]}>Height</Text>
                <TextInput
                  value={dimHeight}
                  onChangeText={v => { setDimHeight(v.replace(/[^0-9.]/g, "")); setSaveStatus("idle"); }}
                  placeholder="–"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="numeric"
                  style={[styles.dimInput, { backgroundColor: colors.muted, borderColor: fieldSaveErrors.dimensions ? colors.destructive : colors.border, color: colors.foreground }]}
                />
              </View>
              <View style={styles.dimField}>
                <Text style={[styles.dimLabel, { color: colors.mutedForeground }]}>Diameter</Text>
                <TextInput
                  value={dimDiameter}
                  onChangeText={v => { setDimDiameter(v.replace(/[^0-9.]/g, "")); setSaveStatus("idle"); }}
                  placeholder="–"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="numeric"
                  style={[styles.dimInput, { backgroundColor: colors.muted, borderColor: fieldSaveErrors.dimensions ? colors.destructive : colors.border, color: colors.foreground }]}
                />
              </View>
            </View>
            {dimSaveError ? (
              <Text style={[styles.fieldErrorText, { color: colors.destructive }]}>{dimSaveError}</Text>
            ) : fieldSaveErrors.dimensions ? (
              <Text style={[styles.fieldErrorText, { color: colors.destructive }]}>{fieldSaveErrors.dimensions}</Text>
            ) : null}
            {(dimLength || dimWidth || dimHeight || dimDiameter) ? (
              <Text style={[styles.dimSummary, { color: colors.primary }]}>
                {[
                  dimLength && dimWidth && dimHeight && `${dimLength} × ${dimWidth} × ${dimHeight} mm`,
                  dimDiameter && `⌀ ${dimDiameter} mm`,
                ].filter(Boolean).join("   ")}
              </Text>
            ) : null}

            {errorMsg ? (
              <View style={[styles.errorBanner, { backgroundColor: colors.destructive + "14", borderColor: colors.destructive + "55" }]}>
                <Text style={[styles.errorText, { color: colors.destructive }]}>{errorMsg}</Text>
              </View>
            ) : null}
          </ScrollView>

          <View style={[styles.footer, { borderTopColor: colors.border }]}>
            {onShowOnMap && item ? (
              <Pressable
                onPress={() => { onClose(); onShowOnMap(item); }}
                style={[styles.mapBtn, { backgroundColor: colors.accentForeground + "18", borderColor: colors.accentForeground + "44" }]}
                accessibilityLabel="Show this part on the map"
              >
                <Feather name="map-pin" size={14} color={colors.accentForeground} />
                <Text style={[styles.mapBtnText, { color: colors.accentForeground }]}>Map it!</Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={onClose}
              style={[styles.cancelBtn, { borderColor: colors.border }]}
            >
              <Text style={[styles.cancelBtnText, { color: colors.foreground }]}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={handleSave}
              disabled={isSaving || (!hasChanges && saveStatus !== "error")}
              style={[
                styles.saveBtn,
                { backgroundColor: isSaving || (!hasChanges && saveStatus !== "error") ? colors.muted : colors.primary },
              ]}
            >
              {isSaving ? (
                <ActivityIndicator color={colors.primaryForeground} />
              ) : (
                <Text
                  style={[
                    styles.saveBtnText,
                    { color: isSaving || (!hasChanges && saveStatus !== "error") ? colors.mutedForeground : colors.primaryForeground },
                  ]}
                >
                  Save Details
                </Text>
              )}
            </Pressable>
          </View>
          </DismissKeyboard>
        </KeyboardAvoidingView>
      </Modal>

      {/* MeasurePartScreen is rendered outside the main Modal so it can present
          its own full-screen Modal without nesting conflicts on iOS. */}
      {adminToken ? (
        <MeasurePartScreen
          visible={measureOpen}
          onClose={() => setMeasureOpen(false)}
          onConfirm={handleMeasureConfirm}
          initialDims={{
            length: parseDimField(dimLength),
            width: parseDimField(dimWidth),
            height: parseDimField(dimHeight),
            diameter: parseDimField(dimDiameter),
          }}
          adminToken={adminToken}
        />
      ) : null}

      {/* Photo camera modal — rendered outside the main Modal for the same reason */}
      {Platform.OS !== "web" ? (
        <Modal
          visible={photoCameraOpen}
          animationType="slide"
          onRequestClose={() => setPhotoCameraOpen(false)}
        >
          <View style={styles.cameraModal}>
            <CameraView
              ref={photoCameraRef}
              style={StyleSheet.absoluteFill}
              mode="picture"
              facing="back"
            />
            <View style={styles.cameraOverlay}>
              <View style={styles.cameraHeader}>
                <Pressable onPress={() => setPhotoCameraOpen(false)} style={styles.cameraCloseBtn}>
                  <Feather name="x" size={20} color="#fff" />
                </Pressable>
                <Text style={styles.cameraTitle}>Capture Item Photo</Text>
                <View style={{ width: 40 }} />
              </View>
              <View style={{ flex: 1 }} />
              <View style={styles.shutterRow}>
                <Pressable
                  onPress={handleTakePhoto}
                  disabled={takingPhoto}
                  style={[styles.shutterBtn, { opacity: takingPhoto ? 0.6 : 1 }]}
                >
                  {takingPhoto ? (
                    <ActivityIndicator size="large" color="#fff" />
                  ) : (
                    <View style={styles.shutterInner} />
                  )}
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
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
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    gap: 3,
  },
  statusText: { fontSize: 12, fontFamily: "Inter_500Medium" },
  scrollContent: { padding: 16, gap: 0, paddingBottom: 32 },
  hint: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
    lineHeight: 18,
    marginBottom: 20,
  },
  sectionLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  fieldHint: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
    marginBottom: 10,
    lineHeight: 16,
  },
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
  chipCopyArea: { flexDirection: "column", alignItems: "flex-start" },
  chipHint: { fontSize: 10, fontFamily: "Inter_400Regular" },
  chipRemoveBtn: { paddingLeft: 4, paddingVertical: 2 },
  chipRemove: { fontSize: 11 },
  emptyHint: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
  },
  fieldErrorText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    marginTop: 4,
  },
  addRow: { flexDirection: "row", gap: 8 },
  addInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  addBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    justifyContent: "center",
  },
  addBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  // Photo styles
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
  cameraModal: { flex: 1, backgroundColor: "#000" },
  cameraOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "space-between",
    paddingBottom: 48,
  },
  cameraHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 56,
    paddingBottom: 16,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  cameraCloseBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  cameraTitle: { color: "#fff", fontSize: 17, fontFamily: "Inter_600SemiBold" },
  shutterRow: { alignItems: "center", paddingBottom: 56 },
  shutterBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: "rgba(255,255,255,0.25)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 3,
    borderColor: "#fff",
  },
  shutterInner: { width: 56, height: 56, borderRadius: 28, backgroundColor: "#fff" },
  // Dimension styles
  dimHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 0,
  },
  measureBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 7,
    borderWidth: 1,
    marginBottom: 6,
  },
  measureBtnText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  dimStatusText: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  dimGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 4,
  },
  dimField: { width: "47%" },
  dimLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    marginBottom: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  dimInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    textAlign: "center",
  },
  dimSummary: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    marginTop: 10,
    textAlign: "center",
  },
  errorBanner: {
    marginTop: 16,
    borderRadius: 8,
    borderWidth: 1,
    padding: 12,
  },
  errorText: { fontSize: 13, fontFamily: "Inter_500Medium", lineHeight: 18 },
  footer: {
    flexDirection: "row",
    padding: 16,
    borderTopWidth: 1,
    gap: 10,
  },
  mapBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 14,
    paddingHorizontal: 12,
  },
  mapBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  cancelBtn: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
  },
  cancelBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  saveBtn: {
    flex: 2,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
  },
  saveBtnText: { fontSize: 15, fontFamily: "Inter_700Bold" },
});
