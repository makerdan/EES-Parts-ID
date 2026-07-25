import { Feather } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQueryClient } from "@tanstack/react-query";
import type { InventoryItem, InventoryListResponse, SearchInventoryResponse } from "@workspace/api-client-react";
import {
  getListInventoryQueryKey,
  useUpdateItemBarcodes,
  useUpdateItemBins,
  useUpdateItemKeywords,
} from "@workspace/api-client-react";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as FileSystem from "expo-file-system/legacy";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { isLiDARSupported } from "lidar-measure";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
import type { PartDimensions } from "@/components/MeasurePartScreen";
import { MeasurePartScreen } from "@/components/MeasurePartScreen";
import { PartPhotoPicker } from "@/components/PartPhotoPicker";
import { useApp } from "@/contexts/AppContext";
import { useColors } from "@/hooks/useColors";
import { shouldRedirectNonAdmin } from "@/utils/adminGuard";
import { API_BASE } from "@/utils/apiBase";
import { evictDeletedItemFromAllCaches, invalidateAllCachesAfterSave, invalidateListCache } from "@/utils/editItemCache";
import { useTrackScreen } from "@/utils/useTrackScreen";

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
  const { adminToken, isAdmin, isLoading, pendingLidarDims, setPendingLidarDims } = useApp();
  const { item: itemParam, section: sectionParam } = useLocalSearchParams<{ item: string; section?: string }>();
  const queryClient = useQueryClient();
  const scrollViewRef = useRef<ScrollView>(null);
  const sectionYRef = useRef<Record<string, number>>({});
  const navTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { return () => { if (navTimerRef.current !== null) clearTimeout(navTimerRef.current); }; }, []);

  const updateBinsMutation = useUpdateItemBins();
  const updateBarcodesMutation = useUpdateItemBarcodes();
  const updateKeywordsMutation = useUpdateItemKeywords();

  const item: InventoryItem | null = (() => {
    try { return itemParam ? (JSON.parse(itemParam) as InventoryItem) : null; }
    catch { return null; }
  })();

  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  // Admin guard — redirect non-admins after storage has finished loading.
  // Suppressed during an active or recently-failed save so the user can read
  // the error banner and decide to cancel before being kicked to tabs.
  useEffect(() => {
    if (saveStatus === "saving" || saveStatus === "error") return;
    if (shouldRedirectNonAdmin(isLoading, isAdmin)) { router.replace("/(tabs)"); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, isAdmin, saveStatus]);

  const [description, setDescription] = useState(item?.description ?? "");
  const [size, setSize] = useState(item?.size ?? "");
  const [sizeSaving, setSizeSaving] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [sizeError, setSizeError] = useState<string | null>(null);
  const [expandedDescription, setExpandedDescription] = useState(item?.expandedDescription ?? "");
  const savedExpandedDescRef = useRef<string>(item?.expandedDescription ?? "");
  const [expandedDescSaving, setExpandedDescSaving] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [expandedDescError, setExpandedDescError] = useState<string | null>(null);
  const [bins, setBins] = useState<Array<string>>(item?.binLocations ?? []);
  const [newBin, setNewBin] = useState("");
  const [barcodes, setBarcodes] = useState<Array<string>>(item?.barcodes ?? []);
  const [newBarcode, setNewBarcode] = useState("");
  const [keywords, setKeywords] = useState<Array<string>>(item?.aiKeywords ?? []);
  const [newKeyword, setNewKeyword] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [fieldSaveErrors, setFieldSaveErrors] = useState<{
    description?: string;
    bins?: string;
    barcodes?: string;
    keywords?: string;
    dimensions?: string;
    photo?: string;
    photo2?: string;
  }>({});
  const [committedFields, setCommittedFields] = useState<Set<string>>(new Set());
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
  const existingDims = item?.dimensions;
  const [dimLength, setDimLength] = useState(fmtDim(existingDims?.length));
  const [dimWidth, setDimWidth] = useState(fmtDim(existingDims?.width));
  const [dimHeight, setDimHeight] = useState(fmtDim(existingDims?.height));
  const [dimDiameter, setDimDiameter] = useState(fmtDim(existingDims?.diameter));

  const [photoUri1, setPhotoUri1] = useState<string | null>(item?.imageUrl ?? null);
  const [photoUri2, setPhotoUri2] = useState<string | null>(item?.imageUrl2 ?? null);

  const [permission, requestPermission] = useCameraPermissions();
  const scannerLockRef = useRef(false);
  const itemRef = useRef(item);

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

  const handleSaveSize = async () => {
    const current = itemRef.current;
    if (!current || !adminToken) return;
    if (size.length > 100) {
      setSizeError("Size must be 100 characters or fewer.");
      return;
    }
    setSizeSaving("saving");
    setSizeError(null);
    const prevSize = current?.size ?? null;
    try {
      const res = await fetch(`${API_BASE}/inventory/${current.id}/size`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ size: size.trim() || null }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const listKeyPrefixSize = getListInventoryQueryKey()[0];
      const newSizeVal = size.trim() || null;
      const patchSize = (i: InventoryItem): InventoryItem =>
        i.id === current.id ? { ...i, ...(({ size: newSizeVal } as unknown) as Partial<InventoryItem>) } : i;
      queryClient.setQueriesData<InventoryListResponse>(
        { predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === listKeyPrefixSize },
        (old) => old ? { ...old, items: old.items.map(patchSize) } : old,
      );
      queryClient.setQueriesData<SearchInventoryResponse>(
        { predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === "searchInventory" },
        (old) => {
          if (!old) return old;
          const patchResult = (r: SearchInventoryResponse["results"][number]) =>
            r.item.id === current.id ? { ...r, item: patchSize(r.item) } : r;
          return { ...old, results: old.results.map(patchResult), sizeUnknownResults: old.sizeUnknownResults?.map(patchResult) };
        },
      );
      await invalidateListCache({ queryClient });
      await queryClient.invalidateQueries({ queryKey: ["searchInventory"] });
      setSizeSaving("saved");
    } catch (err) {
      setSizeError(err instanceof Error ? err.message : "Save failed");
      setSizeSaving("error");
      setSize(prevSize ?? "");
    }
  };

  const handleSaveExpandedDesc = async () => {
    const current = itemRef.current;
    if (!current || !adminToken) return;
    setExpandedDescSaving("saving");
    setExpandedDescError(null);
    try {
      const res = await fetch(`${API_BASE}/inventory/${current.id}/expanded-description`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ expandedDescription: expandedDescription.trim() || null }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      savedExpandedDescRef.current = expandedDescription.trim();
      const savedText = expandedDescription.trim() || null;
      const listKeyPrefixSave = getListInventoryQueryKey()[0];
      const patchExpandedSave = (i: InventoryItem): InventoryItem =>
        i.id === current.id ? { ...i, expandedDescription: savedText } : i;
      queryClient.setQueriesData<InventoryListResponse>(
        { predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === listKeyPrefixSave },
        (old) => old ? { ...old, items: old.items.map(patchExpandedSave) } : old,
      );
      queryClient.setQueriesData<SearchInventoryResponse>(
        { predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === "searchInventory" },
        (old) => {
          if (!old) return old;
          const patchResult = (r: SearchInventoryResponse["results"][number]) =>
            r.item.id === current.id ? { ...r, item: patchExpandedSave(r.item) } : r;
          return { ...old, results: old.results.map(patchResult), sizeUnknownResults: old.sizeUnknownResults?.map(patchResult) };
        },
      );
      await invalidateListCache({ queryClient });
      await queryClient.invalidateQueries({ queryKey: ["searchInventory"] });
      setExpandedDescSaving("saved");
    } catch (err) {
      setExpandedDescError(err instanceof Error ? err.message : "Save failed");
      setExpandedDescSaving("error");
    }
  };

  const handleClearExpandedDesc = async () => {
    const current = itemRef.current;
    if (!current || !adminToken) return;
    const previousText = expandedDescription;
    setExpandedDescription("");
    setExpandedDescSaving("saving");
    setExpandedDescError(null);
    try {
      const res = await fetch(`${API_BASE}/inventory/${current.id}/expanded-description`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ expandedDescription: null }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      savedExpandedDescRef.current = "";
      const listKeyPrefixClear = getListInventoryQueryKey()[0];
      const patchExpandedClear = (i: InventoryItem): InventoryItem =>
        i.id === current.id ? { ...i, expandedDescription: null } : i;
      queryClient.setQueriesData<InventoryListResponse>(
        { predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === listKeyPrefixClear },
        (old) => old ? { ...old, items: old.items.map(patchExpandedClear) } : old,
      );
      queryClient.setQueriesData<SearchInventoryResponse>(
        { predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === "searchInventory" },
        (old) => {
          if (!old) return old;
          const patchResult = (r: SearchInventoryResponse["results"][number]) =>
            r.item.id === current.id ? { ...r, item: patchExpandedClear(r.item) } : r;
          return { ...old, results: old.results.map(patchResult), sizeUnknownResults: old.sizeUnknownResults?.map(patchResult) };
        },
      );
      await invalidateListCache({ queryClient });
      await queryClient.invalidateQueries({ queryKey: ["searchInventory"] });
      setExpandedDescSaving("saved");
    } catch (err) {
      setExpandedDescription(previousText);
      setExpandedDescError(err instanceof Error ? err.message : "Clear failed");
      setExpandedDescSaving("error");
    }
  };

  const handleDeleteItem = useCallback(() => {
    const current = itemRef.current;
    if (!current || !adminToken) {
      setErrorMsg("Admin session expired. Re-unlock and try again.");
      setSaveStatus("error");
      return;
    }
    Alert.alert(
      "Delete Part",
      `Permanently delete "${current.catalog}"? This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              const res = await fetch(`${API_BASE}/inventory/${current.id}`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${adminToken}` },
              });
              if (!res.ok) {
                const data = await res.json().catch(() => ({})) as { error?: string };
                setErrorMsg(data.error ?? `Could not delete part (HTTP ${res.status}).`);
                setSaveStatus("error");
                return;
              }
              // Synchronously remove the item from all in-memory caches so
              // BrowseByAisle / aisle-shelf views don't show it on the next
              // render, then trigger a background refetch to confirm removal.
              await evictDeletedItemFromAllCaches({
                queryClient,
                asyncStorage: AsyncStorage,
                itemId: current.id,
              });
              router.back();
            } catch {
              setErrorMsg("Could not delete the part. Check your connection and try again.");
              setSaveStatus("error");
            }
          },
        },
      ],
    );
  }, [adminToken, queryClient, router]);

  const handleSave = async () => {
    const current = itemRef.current;
    if (!current || !adminToken) {
      setErrorMsg("Admin session expired. Tap Cancel, re-unlock as admin, then try again.");
      setSaveStatus("error");
      return;
    }
    setSaveStatus("saving");
    setErrorMsg(null);
    setFieldSaveErrors({});

    const listKeyPrefix = getListInventoryQueryKey()[0];
    const inventorySnapshot = queryClient.getQueriesData<InventoryListResponse>(
      { predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === listKeyPrefix },
    );
    const searchSnapshot = queryClient.getQueriesData<SearchInventoryResponse>(
      { predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === "searchInventory" },
    );

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

    // Auto-add any pending bin text before saving
    const pendingBin = newBin.trim();
    const finalBins =
      pendingBin && !bins.some((b) => b.toLowerCase() === pendingBin.toLowerCase())
        ? [...bins, pendingBin]
        : bins;
    if (finalBins !== bins) {
      setBins(finalBins);
      setNewBin("");
    }

    // Auto-add any pending keyword text before saving
    const pendingKeyword = newKeyword.trim().toLowerCase();
    const finalKeywords =
      pendingKeyword && !keywords.includes(pendingKeyword)
        ? [...keywords, pendingKeyword]
        : keywords;
    if (finalKeywords !== keywords) {
      setKeywords(finalKeywords);
      setNewKeyword("");
    }

    // Build current dimensions object for comparison.
    // Use itemRef.current?.dimensions (not the render-time `existingDims` closure)
    // so a mid-edit item refresh doesn't produce a stale baseline.
    const newDims: PartDimensions = {
      length: parseDimField(dimLength),
      width: parseDimField(dimWidth),
      height: parseDimField(dimHeight),
      diameter: parseDimField(dimDiameter),
    };
    const oldDims = itemRef.current?.dimensions ?? {};
    const dimsChanged =
      newDims.length !== (oldDims.length ?? null) ||
      newDims.width !== (oldDims.width ?? null) ||
      newDims.height !== (oldDims.height ?? null) ||
      newDims.diameter !== (oldDims.diameter ?? null);

    try {
      const ops: Array<{ field: string; restoreFn: () => void; promise: Promise<unknown> }> = [];

      // ?? "" handles newly-added items where description is null — null becomes ""
      // so a first-time description edit is correctly detected as a change.
      if (description.trim() !== (current.description ?? "").trim()) {
        ops.push({
          field: "description",
          restoreFn: () => setDescription(current.description ?? ""),
          promise: fetch(`${API_BASE}/inventory/${current.id}/description`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
            body: JSON.stringify({ description: description.trim() }),
          }).then(async (res) => {
            if (!res.ok) {
              const d = await res.json().catch(() => ({})) as { error?: string };
              throw new Error(d.error ?? `HTTP ${res.status}`);
            }
          }),
        });
      }

      if (JSON.stringify(finalBins) !== JSON.stringify(current.binLocations ?? [])) {
        ops.push({
          field: "bins",
          restoreFn: () => setBins(current.binLocations ?? []),
          promise: updateBinsMutation.mutateAsync({ id: current.id, data: { binLocations: finalBins } }),
        });
      }

      if (JSON.stringify(finalBarcodes) !== JSON.stringify(current.barcodes ?? [])) {
        ops.push({
          field: "barcodes",
          restoreFn: () => setBarcodes(current.barcodes ?? []),
          promise: updateBarcodesMutation.mutateAsync({ id: current.id, data: { barcodes: finalBarcodes } }),
        });
      }

      if (JSON.stringify(finalKeywords) !== JSON.stringify(current.aiKeywords ?? [])) {
        ops.push({
          field: "keywords",
          restoreFn: () => setKeywords(current.aiKeywords ?? []),
          promise: updateKeywordsMutation.mutateAsync({ id: current.id, data: { keywords: finalKeywords } }),
        });
      }

      if (dimsChanged) {
        ops.push({
          field: "dimensions",
          restoreFn: () => {
            const savedDims = itemRef.current?.dimensions;
            setDimLength(fmtDim(savedDims?.length));
            setDimWidth(fmtDim(savedDims?.width));
            setDimHeight(fmtDim(savedDims?.height));
            setDimDiameter(fmtDim(savedDims?.diameter));
          },
          promise: fetch(`${API_BASE}/inventory/${current.id}/dimensions`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
            body: JSON.stringify(newDims),
          }).then(async (res) => {
            if (!res.ok) {
              const d = await res.json().catch(() => ({})) as { error?: string };
              throw new Error(d.error ?? `HTTP ${res.status}`);
            }
          }),
        });
      }

      let capturedImageUrl: string | null | undefined = undefined;
      let capturedImageUrl2: string | null | undefined = undefined;

      const originalImageUrl = current.imageUrl ?? null;
      const originalImageUrl2 = current.imageUrl2 ?? null;

      if (photoUri1 !== originalImageUrl) {
        if (photoUri1) {
          const slot1Uri = photoUri1;
          const prevPhotoUri1 = originalImageUrl;
          ops.push({
            field: "photo",
            restoreFn: () => setPhotoUri1(prevPhotoUri1),
            promise: (async () => {
              const base64 = await FileSystem.readAsStringAsync(slot1Uri, { encoding: "base64" });
              const res = await fetch(`${API_BASE}/inventory/${current.id}/photo`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
                body: JSON.stringify({ imageBase64: base64, mimeType: "image/jpeg", slot: 1 }),
              });
              if (!res.ok) {
                const d = await res.json().catch(() => ({})) as { error?: string };
                throw new Error(d.error ?? `HTTP ${res.status}`);
              }
              const d = await res.json() as { imageUrl?: string | null };
              capturedImageUrl = d.imageUrl ?? null;
            })(),
          });
        } else {
          const prevPhotoUri1 = originalImageUrl;
          ops.push({
            field: "photo",
            restoreFn: () => setPhotoUri1(prevPhotoUri1),
            promise: fetch(`${API_BASE}/inventory/${current.id}/photo`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
              body: JSON.stringify({ remove: true, slot: 1 }),
            }).then(async (res) => {
              if (!res.ok) {
                const d = await res.json().catch(() => ({})) as { error?: string };
                throw new Error(d.error ?? `HTTP ${res.status}`);
              }
              capturedImageUrl = null;
            }),
          });
        }
      }

      if (photoUri2 !== originalImageUrl2) {
        if (photoUri2) {
          const slot2Uri = photoUri2;
          const prevPhotoUri2 = originalImageUrl2;
          ops.push({
            field: "photo2",
            restoreFn: () => setPhotoUri2(prevPhotoUri2),
            promise: (async () => {
              const base64 = await FileSystem.readAsStringAsync(slot2Uri, { encoding: "base64" });
              const res = await fetch(`${API_BASE}/inventory/${current.id}/photo`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
                body: JSON.stringify({ imageBase64: base64, mimeType: "image/jpeg", slot: 2 }),
              });
              if (!res.ok) {
                const d = await res.json().catch(() => ({})) as { error?: string };
                throw new Error(d.error ?? `HTTP ${res.status}`);
              }
              const d = await res.json() as { imageUrl2?: string | null };
              capturedImageUrl2 = d.imageUrl2 ?? null;
            })(),
          });
        } else {
          const prevPhotoUri2 = originalImageUrl2;
          ops.push({
            field: "photo2",
            restoreFn: () => setPhotoUri2(prevPhotoUri2),
            promise: fetch(`${API_BASE}/inventory/${current.id}/photo`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
              body: JSON.stringify({ remove: true, slot: 2 }),
            }).then(async (res) => {
              if (!res.ok) {
                const d = await res.json().catch(() => ({})) as { error?: string };
                throw new Error(d.error ?? `HTTP ${res.status}`);
              }
              capturedImageUrl2 = null;
            }),
          });
        }
      }

      if (ops.length > 0) {
        const settled = await Promise.allSettled(ops.map(o => o.promise));

        const failedIndices = settled
          .map((r, i) => r.status === "rejected" ? i : -1)
          .filter(i => i >= 0);

        if (failedIndices.length > 0) {
          // Revert UI state for each field that failed.
          for (const i of failedIndices) {
            ops[i].restoreFn();
          }

          // Which fields succeeded?
          const succeededFields = new Set(
            ops.filter((_, i) => settled[i].status === "fulfilled").map(o => o.field),
          );

          // Restore the full cache snapshot first, then re-apply patches for
          // fields that succeeded so they remain visible to the user.
          for (const [key, data] of inventorySnapshot) {
            queryClient.setQueryData(key, data);
          }
          for (const [key, data] of searchSnapshot) {
            queryClient.setQueryData(key, data);
          }

          if (succeededFields.size > 0) {
            const patchItemPartial = (i: InventoryItem): InventoryItem => {
              if (i.id !== current.id) return i;
              return {
                ...i,
                ...(succeededFields.has("description") ? { description: description.trim() } : {}),
                ...(succeededFields.has("keywords") ? { aiKeywords: finalKeywords } : {}),
                ...(succeededFields.has("bins") ? { binLocations: finalBins } : {}),
                ...(succeededFields.has("barcodes") ? { barcodes: finalBarcodes } : {}),
                ...(succeededFields.has("dimensions") ? { dimensions: newDims } : {}),
                ...(succeededFields.has("photo") && capturedImageUrl !== undefined ? { imageUrl: capturedImageUrl, thumbnailUrl: null } : {}),
                ...(succeededFields.has("photo2") && capturedImageUrl2 !== undefined ? { imageUrl2: capturedImageUrl2, thumbnailUrl2: null } : {}),
              };
            };
            queryClient.setQueriesData<InventoryListResponse>(
              { predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === listKeyPrefix },
              (old) => old ? { ...old, items: old.items.map(patchItemPartial) } : old,
            );
            queryClient.setQueriesData<SearchInventoryResponse>(
              { predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === "searchInventory" },
              (old) => {
                if (!old) return old;
                const patchResult = (r: SearchInventoryResponse["results"][number]) =>
                  r.item.id === current.id ? { ...r, item: patchItemPartial(r.item) } : r;
                return { ...old, results: old.results.map(patchResult), sizeUnknownResults: old.sizeUnknownResults?.map(patchResult) };
              },
            );
            if (succeededFields.has("photo") && capturedImageUrl !== undefined) setPhotoUri1(capturedImageUrl);
            if (succeededFields.has("photo2") && capturedImageUrl2 !== undefined) setPhotoUri2(capturedImageUrl2);
          }

          await queryClient.invalidateQueries(
            { predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === listKeyPrefix },
          );
          await queryClient.invalidateQueries({ queryKey: ["searchInventory"] });

          const newFieldErrors: typeof fieldSaveErrors = {};
          let has401 = false;
          settled.forEach((result, i) => {
            if (result.status === "rejected") {
              const msg = result.reason instanceof Error ? result.reason.message : String(result.reason ?? "Save failed");
              if (msg.includes("401")) has401 = true;
              newFieldErrors[ops[i].field as keyof typeof fieldSaveErrors] = has401
                ? "Session expired — re-unlock admin access"
                : "Could not save — check connection";
            }
          });
          setFieldSaveErrors(newFieldErrors);
          setCommittedFields(prev => {
            const next = new Set(prev);
            succeededFields.forEach(f => next.add(f));
            return next;
          });

          const fieldLabel: Record<string, string> = {
            description: "Description",
            bins: "Bins",
            barcodes: "Barcodes",
            keywords: "Keywords",
            dimensions: "Dimensions",
            photo: "Photo 1",
            photo2: "Photo 2",
          };
          const savedLabels = [...succeededFields].map(f => fieldLabel[f] ?? f);
          const failedLabels = Object.keys(newFieldErrors).map(f => fieldLabel[f] ?? f);
          const parts: Array<string> = [];
          if (savedLabels.length > 0) parts.push(`${savedLabels.join(", ")} saved`);
          if (failedLabels.length > 0) parts.push(`${failedLabels.join(", ")} failed`);
          if (has401) {
            setErrorMsg("Admin session expired. Re-unlock and try again.");
          } else {
            setErrorMsg(parts.join(" · ") + " — check connection and retry");
          }
          setSaveStatus("error");
          return;
        }

        // All fields saved — patch cache and navigate away.
        const patchItem = (i: InventoryItem): InventoryItem => {
          if (i.id !== current.id) return i;
          return {
            ...i,
            description: description.trim(),
            aiKeywords: finalKeywords,
            binLocations: finalBins,
            barcodes: finalBarcodes,
            ...(dimsChanged ? { dimensions: newDims } : {}),
            ...(capturedImageUrl !== undefined ? { imageUrl: capturedImageUrl, thumbnailUrl: null } : {}),
            ...(capturedImageUrl2 !== undefined ? { imageUrl2: capturedImageUrl2, thumbnailUrl2: null } : {}),
          };
        };
        queryClient.setQueriesData<InventoryListResponse>(
          { predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === listKeyPrefix },
          (old) => {
            if (!old) return old;
            return { ...old, items: old.items.map(patchItem) };
          },
        );
        queryClient.setQueriesData<SearchInventoryResponse>(
          { predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === "searchInventory" },
          (old) => {
            if (!old) return old;
            const patchResult = (r: SearchInventoryResponse["results"][number]) =>
              r.item.id === current.id ? { ...r, item: patchItem(r.item) } : r;
            return {
              ...old,
              results: old.results.map(patchResult),
              sizeUnknownResults: old.sizeUnknownResults?.map(patchResult),
            };
          },
        );

        if (capturedImageUrl !== undefined) setPhotoUri1(capturedImageUrl);
        if (capturedImageUrl2 !== undefined) setPhotoUri2(capturedImageUrl2);

        await invalidateAllCachesAfterSave({
          queryClient,
          asyncStorage: AsyncStorage,
          itemId: current.id,
        });
      }

      setSaveStatus("saved");
      navTimerRef.current = setTimeout(() => router.back(), 500);
    } catch (err) {
      const msg = err && typeof err === "object" && "message" in err
        ? String((err as { message: unknown }).message) : "Save failed";
      if (msg.includes("401")) {
        setErrorMsg("Admin session expired. Re-unlock and try again.");
      } else if (msg && msg !== "Save failed" && !msg.startsWith("HTTP 5")) {
        setErrorMsg(msg);
      } else {
        setErrorMsg("Could not save changes. Check connection and try again.");
      }
      setSaveStatus("error");

      for (const [key, data] of inventorySnapshot) {
        queryClient.setQueryData(key, data);
      }
      for (const [key, data] of searchSnapshot) {
        queryClient.setQueryData(key, data);
      }
      await queryClient.invalidateQueries(
        { predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === listKeyPrefix },
      );
      await queryClient.invalidateQueries({ queryKey: ["searchInventory"] });
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
    expandedDescription.trim() !== savedExpandedDescRef.current ||
    JSON.stringify(bins) !== JSON.stringify(item.binLocations ?? []) ||
    JSON.stringify(barcodes) !== JSON.stringify(item.barcodes ?? []) ||
    JSON.stringify(keywords) !== JSON.stringify(item.aiKeywords ?? []) ||
    parseDimField(dimLength) !== (existingDims?.length ?? null) ||
    parseDimField(dimWidth) !== (existingDims?.width ?? null) ||
    parseDimField(dimHeight) !== (existingDims?.height ?? null) ||
    parseDimField(dimDiameter) !== (existingDims?.diameter ?? null) ||
    photoUri1 !== (item.imageUrl ?? null) ||
    photoUri2 !== (item?.imageUrl2 ?? null);

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
          {/* Photos */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={[s.sectionLabel, { color: colors.mutedForeground }]}>PHOTOS</Text>
            {(committedFields.has("photo") || committedFields.has("photo2")) ? (
              <Text style={{ color: colors.success, fontSize: 11, fontFamily: "Inter_500Medium" }}>✓ Saved</Text>
            ) : null}
          </View>
          <View style={s.photoSlots}>
            <PartPhotoPicker
              slot={1}
              label="Box / Label"
              value={photoUri1}
              onChange={(uri) => { setPhotoUri1(uri); setSaveStatus("idle"); }}
            />
            {fieldSaveErrors.photo ? (
              <Text style={[s.fieldHint, { color: colors.destructive }]}>{fieldSaveErrors.photo}</Text>
            ) : null}
            <PartPhotoPicker
              slot={2}
              label="Detail / Wire Frame"
              value={photoUri2}
              onChange={(uri) => { setPhotoUri2(uri); setSaveStatus("idle"); }}
            />
            {fieldSaveErrors.photo2 ? (
              <Text style={[s.fieldHint, { color: colors.destructive }]}>{fieldSaveErrors.photo2}</Text>
            ) : null}
          </View>

          {/* Description */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 24 }}>
            <Text style={[s.sectionLabel, { color: colors.mutedForeground }]}>DESCRIPTION</Text>
            {committedFields.has("description") ? (
              <Text style={{ color: colors.success, fontSize: 11, fontFamily: "Inter_500Medium" }}>✓ Saved</Text>
            ) : null}
          </View>
          <KeyboardDoneInput
            value={description}
            onChangeText={(v) => { setDescription(v); setSaveStatus("idle"); }}
            placeholder="Brief description of the part…"
            placeholderTextColor={colors.mutedForeground}
            multiline
            numberOfLines={3}
            style={[s.descInput, { backgroundColor: colors.muted, borderColor: fieldSaveErrors.description ? colors.destructive : colors.border, color: colors.foreground }]}
            autoCorrect
            autoCapitalize="sentences"
          />
          {fieldSaveErrors.description ? (
            <Text style={[s.fieldHint, { color: colors.destructive, marginTop: 4 }]}>{fieldSaveErrors.description}</Text>
          ) : null}

          {/* Size */}
          <Text style={[s.sectionLabel, { color: colors.mutedForeground, marginTop: 24 }]}>SIZE</Text>
          <Text style={[s.fieldHint, { color: colors.mutedForeground }]}>
            Human-readable size label (e.g. 1/2", 3/4", 4" × 2"). Max 100 chars.
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 }}>
            <KeyboardDoneInput
              value={size}
              onChangeText={(v) => { setSize(v); if (sizeSaving !== "idle") setSizeSaving("idle"); setSizeError(null); }}
              placeholder='e.g. 1/2"'
              placeholderTextColor={colors.mutedForeground}
              maxLength={100}
              style={[
                s.descInput,
                { flex: 1, backgroundColor: colors.muted, borderColor: sizeSaving === "error" ? colors.destructive : colors.border, color: colors.foreground },
              ]}
              autoCorrect={false}
              autoCapitalize="none"
            />
            <Pressable
              onPress={handleSaveSize}
              disabled={sizeSaving === "saving" || size.trim() === (item?.size ?? "") || size.length > 100}
              style={[
                s.saveBtn,
                {
                  marginTop: 0,
                  backgroundColor:
                    (sizeSaving === "saving" || size.trim() === (item?.size ?? "") || size.length > 100)
                      ? colors.muted
                      : colors.primary,
                },
              ]}
            >
              <Text style={[s.saveBtnText, { color: (sizeSaving === "saving" || size.trim() === (item?.size ?? "") || size.length > 100) ? colors.mutedForeground : colors.primaryForeground }]}>
                Save
              </Text>
            </Pressable>
          </View>
          {sizeSaving === "error" && sizeError ? (
            <Text style={[s.fieldHint, { color: colors.destructive, marginTop: 4 }]}>{sizeError}</Text>
          ) : null}
          {sizeSaving === "saved" ? (
            <Text style={{ color: colors.success, fontSize: 12, fontFamily: "Inter_500Medium", marginTop: 4 }}>✓ Saved</Text>
          ) : sizeSaving === "saving" ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 }}>
              <ActivityIndicator size="small" color={colors.mutedForeground} />
              <Text style={{ color: colors.mutedForeground, fontSize: 12, fontFamily: "Inter_500Medium" }}>Saving…</Text>
            </View>
          ) : null}

          {/* Expanded Description */}
          <Text style={[s.sectionLabel, { color: colors.mutedForeground, marginTop: 24 }]}>EXPANDED DESCRIPTION</Text>
          <Text style={[s.fieldHint, { color: colors.mutedForeground }]}>
            AI-expanded plain-English version. Edit, then tap Save. Tap the trash icon to clear.
          </Text>
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 4 }}>
            <KeyboardDoneInput
              value={expandedDescription}
              onChangeText={(v) => { setExpandedDescription(v); if (expandedDescSaving !== "idle") setExpandedDescSaving("idle"); }}
              placeholder="No expanded description yet…"
              placeholderTextColor={colors.mutedForeground}
              multiline
              numberOfLines={3}
              maxLength={1000}
              style={[
                s.descInput,
                { flex: 1, backgroundColor: colors.muted, borderColor: expandedDescSaving === "error" ? colors.destructive : colors.border, color: colors.foreground },
              ]}
              autoCorrect
              autoCapitalize="sentences"
            />
            <Pressable
              onPress={handleClearExpandedDesc}
              disabled={expandedDescSaving === "saving" || (!expandedDescription && !item?.expandedDescription)}
              style={{
                padding: 10,
                borderRadius: 6,
                backgroundColor: colors.muted,
                borderWidth: 1,
                borderColor: colors.border,
                marginTop: 2,
                opacity: (expandedDescSaving === "saving" || (!expandedDescription && !item?.expandedDescription)) ? 0.4 : 1,
              }}
              accessibilityLabel="Clear expanded description"
            >
              <Feather name="trash-2" size={16} color={colors.destructive} />
            </Pressable>
          </View>
          {expandedDescSaving === "error" && expandedDescError ? (
            <Text style={[s.fieldHint, { color: colors.destructive, marginTop: 4 }]}>{expandedDescError}</Text>
          ) : null}
          {expandedDescSaving === "saved" ? (
            <Text style={{ color: colors.success, fontSize: 12, fontFamily: "Inter_500Medium", marginTop: 4 }}>✓ Saved</Text>
          ) : expandedDescSaving === "saving" ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 }}>
              <ActivityIndicator size="small" color={colors.mutedForeground} />
              <Text style={{ color: colors.mutedForeground, fontSize: 12, fontFamily: "Inter_500Medium" }}>Saving…</Text>
            </View>
          ) : null}
          <Pressable
            onPress={handleSaveExpandedDesc}
            disabled={expandedDescSaving === "saving" || expandedDescription.trim() === (item?.expandedDescription ?? "")}
            style={[
              s.saveBtn,
              {
                marginTop: 8, marginBottom: 4,
                backgroundColor:
                  (expandedDescSaving === "saving" || expandedDescription.trim() === (item?.expandedDescription ?? ""))
                    ? colors.muted
                    : colors.primary,
              },
            ]}
          >
            <Text
              style={[
                s.saveBtnText,
                {
                  color:
                    (expandedDescSaving === "saving" || expandedDescription.trim() === (item?.expandedDescription ?? ""))
                      ? colors.mutedForeground
                      : colors.primaryForeground,
                },
              ]}
            >
              Save Expanded Description
            </Text>
          </Pressable>

          {/* Bins */}
          <View onLayout={(e) => { sectionYRef.current.bins = e.nativeEvent.layout.y; }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 24 }}>
            <Text style={[s.sectionLabel, { color: colors.mutedForeground }]}>
              BIN LOCATIONS ({bins.length})
            </Text>
            {committedFields.has("bins") ? (
              <Text style={{ color: colors.success, fontSize: 11, fontFamily: "Inter_500Medium" }}>✓ Saved</Text>
            ) : null}
          </View>
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
          {fieldSaveErrors.bins ? (
            <Text style={[s.fieldHint, { color: colors.destructive, marginTop: 4 }]}>{fieldSaveErrors.bins}</Text>
          ) : null}
          </View>

          {/* Barcodes */}
          <View onLayout={(e) => { sectionYRef.current.barcodes = e.nativeEvent.layout.y; }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 24 }}>
            <Text style={[s.sectionLabel, { color: colors.mutedForeground }]}>
              BARCODES ({barcodes.length})
            </Text>
            {committedFields.has("barcodes") ? (
              <Text style={{ color: colors.success, fontSize: 11, fontFamily: "Inter_500Medium" }}>✓ Saved</Text>
            ) : null}
          </View>
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
          {fieldSaveErrors.barcodes ? (
            <Text style={[s.fieldHint, { color: colors.destructive, marginTop: 4 }]}>{fieldSaveErrors.barcodes}</Text>
          ) : null}
          </View>

          {/* Dimensions */}
          <View style={[s.dimHeader, { marginTop: 24 }]}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={[s.sectionLabel, { color: colors.mutedForeground }]}>DIMENSIONS (mm)</Text>
              {committedFields.has("dimensions") ? (
                <Text style={{ color: colors.success, fontSize: 11, fontFamily: "Inter_500Medium" }}>✓ Saved</Text>
              ) : null}
            </View>
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
                style={[s.dimInput, { backgroundColor: colors.muted, borderColor: fieldSaveErrors.dimensions ? colors.destructive : colors.border, color: colors.foreground }]}
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
                style={[s.dimInput, { backgroundColor: colors.muted, borderColor: fieldSaveErrors.dimensions ? colors.destructive : colors.border, color: colors.foreground }]}
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
                style={[s.dimInput, { backgroundColor: colors.muted, borderColor: fieldSaveErrors.dimensions ? colors.destructive : colors.border, color: colors.foreground }]}
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
                style={[s.dimInput, { backgroundColor: colors.muted, borderColor: fieldSaveErrors.dimensions ? colors.destructive : colors.border, color: colors.foreground }]}
              />
            </View>
          </View>
          {fieldSaveErrors.dimensions ? (
            <Text style={[s.fieldHint, { color: colors.destructive, marginTop: 4 }]}>{fieldSaveErrors.dimensions}</Text>
          ) : null}
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
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 24 }}>
            <Text style={[s.sectionLabel, { color: colors.mutedForeground }]}>
              AI KEYWORDS ({keywords.length})
            </Text>
            {committedFields.has("keywords") ? (
              <Text style={{ color: colors.success, fontSize: 11, fontFamily: "Inter_500Medium" }}>✓ Saved</Text>
            ) : null}
          </View>
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
          {fieldSaveErrors.keywords ? (
            <Text style={[s.fieldHint, { color: colors.destructive, marginTop: 4 }]}>{fieldSaveErrors.keywords}</Text>
          ) : null}
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
          {adminToken ? (
            <Pressable
              onPress={handleDeleteItem}
              disabled={isSaving}
              style={[s.deleteBtn, { backgroundColor: colors.destructive + "18", borderColor: colors.destructive + "44", opacity: isSaving ? 0.4 : 1 }]}
              accessibilityLabel="Delete this part"
            >
              <Feather name="trash-2" size={14} color={colors.destructive} />
            </Pressable>
          ) : null}
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
  deleteBtn: { alignItems: "center", justifyContent: "center", borderWidth: 1, borderRadius: 8, paddingVertical: 14, paddingHorizontal: 12 },
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
  photoSlots: { gap: 16, marginBottom: 8 },
});
