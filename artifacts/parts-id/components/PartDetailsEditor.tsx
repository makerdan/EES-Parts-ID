import { Feather } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQueryClient } from "@tanstack/react-query";
import type { InventoryItem, InventoryListResponse, SearchInventoryResponse } from "@workspace/api-client-react";
import {
  updateItemBins,
  updateItemKeywords,
  useUpdateItemBins,
  useUpdateItemKeywords,
} from "@workspace/api-client-react";
import { getListInventoryQueryKey } from "@workspace/api-client-react";
import * as Clipboard from "expo-clipboard";
import * as FileSystem from "expo-file-system/legacy";
import { isLiDARSupported } from "lidar-measure";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { ConfirmDialog, InfoDialog } from "@/components/ConfirmDialog";
import { DismissKeyboard } from "@/components/DismissKeyboard";
import { KeyboardDoneInput } from "@/components/KeyboardDoneInput";
import type { PartDimensions } from "@/components/MeasurePartScreen";
import { MeasurePartScreen } from "@/components/MeasurePartScreen";
import { PartPhotoPicker } from "@/components/PartPhotoPicker";
import { PhotoLightbox } from "@/components/PhotoLightbox";
import { useColors } from "@/hooks/useColors";
import { API_BASE } from "@/utils/apiBase";
import { BIN_FORMAT_HINT,isBinLocationValid } from "@/utils/binValidation";
import {
  evictDeletedItemFromAllCaches,
  invalidateAllCachesAfterSave,
  invalidateListCache,
  INVENTORY_REFRESH_WARNING,
} from "@/utils/editItemCache";
import {
  applySuccessfulInventoryFields,
  inventorySaveErrorMessage,
  type InventorySaveOp,
  isAbortError,
  resolveInventorySaveResults,
  runInventoryWrite,
} from "@/utils/inventoryWrite";

interface CapturedPhoto {
  uri: string;
}

if (__DEV__ && !API_BASE) {
  // eslint-disable-next-line no-console
  console.error(
    "[PartDetailsEditor] No API base URL configured — all API calls will fail. " +
    "Set EXPO_PUBLIC_DOMAIN or EXPO_PUBLIC_API_BASE before starting the dev server.",
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
  /**
   * Called after an item is successfully deleted so the host screen can prune
   * the deleted item from its own offline structures (e.g. the Fuse.js barcode
   * index held in the Search screen), which are not touched by
   * evictDeletedItemFromAllCaches.
   */
  onItemDeleted?: (itemId: number) => void;
  /** Called after any successful field save so the host can update its local index. */
  onItemSaved?: (item: InventoryItem) => void;
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
export function PartDetailsEditor({ item, adminToken, onClose, onShowOnMap, onItemDeleted, onItemSaved }: PartDetailsEditorProps) {
  "use no memo";
  const colors = useColors();
  const queryClient = useQueryClient();
  const writeControllersRef = useRef(new Set<AbortController>());
  const mountedRef = useRef(true);
  const saveInFlightRef = useRef(false);
  const fetchWrite = useCallback(
    (url: string, init: RequestInit) =>
      runInventoryWrite(writeControllersRef.current, signal => fetch(url, { ...init, signal })),
    [],
  );
  const updateBinsMutation = useUpdateItemBins({
    mutation: {
      mutationFn: ({ id, data }) =>
        runInventoryWrite(writeControllersRef.current, signal => updateItemBins(id, data, { signal })),
    },
  });
  const updateKeywordsMutation = useUpdateItemKeywords({
    mutation: {
      mutationFn: ({ id, data }) =>
        runInventoryWrite(writeControllersRef.current, signal => updateItemKeywords(id, data, { signal })),
    },
  });
  const [description, setDescription] = useState(item?.description ?? "");
  // The editor mounts once while its route item is still resolving. This
  // zero is only the pre-item loading value; InventoryItem responses require
  // both order fields once `item` is available.
  const [op, setOp] = useState(String(item?.orderPurchase ?? 0));
  const [oq, setOq] = useState(String(item?.orderQuantity ?? 0));
  const [bins, setBins] = useState<Array<string>>(item?.binLocations ?? []);
  const [newBin, setNewBin] = useState("");
  const [keywords, setKeywords] = useState<Array<string>>(item?.aiKeywords ?? []);
  const [newKeyword, setNewKeyword] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [refreshWarning, setRefreshWarning] = useState<string | null>(null);
  const [fieldSaveErrors, setFieldSaveErrors] = useState<{
    description?: string;
    bins?: string;
    keywords?: string;
    dimensions?: string;
    opoq?: string;
    photo?: string;
    photo2?: string;
  }>({});
  const [committedFields, setCommittedFields] = useState<Set<string>>(new Set());

  // Expanded description state (admin-only field, saved independently)
  const [expandedDescText, setExpandedDescText] = useState(item?.expandedDescription ?? "");
  const [expandedDescSaving, setExpandedDescSaving] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [expandedDescError, setExpandedDescError] = useState<string | null>(null);

  // Dimensions state
  const existingDims = item?.dimensions;
  const [dimLength, setDimLength] = useState(fmtDim(existingDims?.length));
  const [dimWidth, setDimWidth] = useState(fmtDim(existingDims?.width));
  const [dimHeight, setDimHeight] = useState(fmtDim(existingDims?.height));
  const [dimDiameter, setDimDiameter] = useState(fmtDim(existingDims?.diameter));
  const [measureOpen, setMeasureOpen] = useState(false);
  const [lidarAvailable, setLidarAvailable] = useState(false);
  const pendingMeasureDimsRef = useRef<PartDimensions | null>(null);
  const [discardDialogVisible, setDiscardDialogVisible] = useState(false);
  const [saveInFlightDialogVisible, setSaveInFlightDialogVisible] = useState(false);
  const savedDescriptionRef = useRef(item?.description ?? "");
  // These refs share the same nullable-item loading boundary as the state
  // above; all later reads use the required InventoryItem fields directly.
  const savedOpRef = useRef(item?.orderPurchase ?? 0);
  const savedOqRef = useRef(item?.orderQuantity ?? 0);
  const savedBinsRef = useRef<Array<string>>(item?.binLocations ?? []);
  const savedKeywordsRef = useRef<Array<string>>(item?.aiKeywords ?? []);
  const savedDimsRef = useRef<PartDimensions>({
    length: existingDims?.length ?? null,
    width: existingDims?.width ?? null,
    height: existingDims?.height ?? null,
    diameter: existingDims?.diameter ?? null,
  });
  const savedExpandedDescRef = useRef(item?.expandedDescription ?? "");
  const savedPhotoUriRef = useRef<string | null>(item?.imageUrl ?? null);
  const savedPhotoUri2Ref = useRef<string | null>(item?.imageUrl2 ?? null);
  const dimensionSaveInFlightRef = useRef(false);
  const expandedDescSaveInFlightRef = useRef(false);
  const allowCloseRef = useRef(false);
  const hasChangesRef = useRef(false);
  const pendingCloseRef = useRef<(() => void) | null>(null);

  const requestClose = useCallback((exit: () => void = onClose) => {
    if (allowCloseRef.current) {
      allowCloseRef.current = false;
      exit();
      return;
    }
    if (
      saveInFlightRef.current ||
      dimensionSaveInFlightRef.current ||
      expandedDescSaveInFlightRef.current
    ) {
      setSaveInFlightDialogVisible(true);
      return;
    }
    if (!hasChangesRef.current) {
      exit();
      return;
    }
    pendingCloseRef.current = exit;
    setDiscardDialogVisible(true);
  }, [onClose]);

  const keepEditing = useCallback(() => {
    pendingCloseRef.current = null;
    setDiscardDialogVisible(false);
    setSaveInFlightDialogVisible(false);
  }, []);

  const discardChanges = useCallback(() => {
    const exit = pendingCloseRef.current;
    pendingCloseRef.current = null;
    setDiscardDialogVisible(false);
    if (exit) exit();
  }, []);

  useEffect(() => {
    setLidarAvailable(isLiDARSupported());
  }, []);

  // Photo state — slot 1 (Box / Label)
  const [newPhotoData, setNewPhotoData] = useState<CapturedPhoto | null>(null);
  const [removeCurrentPhoto, setRemoveCurrentPhoto] = useState(false);
  // Photo state — slot 2 (Detail / Wire Frame)
  const [newPhotoData2, setNewPhotoData2] = useState<CapturedPhoto | null>(null);
  const [removeCurrentPhoto2, setRemoveCurrentPhoto2] = useState(false);
  // Lightbox state for previewing photos full-screen
  const [lightboxUris, setLightboxUris] = useState<Array<string>>([]);
  const [lightboxIndex, setLightboxIndex] = useState(0);

  const itemRef = useRef(item);
  useEffect(() => { itemRef.current = item; }, [item]);
  const reportItemSaved = useCallback((patch: Partial<InventoryItem>) => {
    const current = itemRef.current;
    if (!current || !onItemSaved) return;
    const updatedItem = { ...current, ...patch };
    itemRef.current = updatedItem;
    onItemSaved(updatedItem);
  }, [onItemSaved]);

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

  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const controllers = writeControllersRef.current;
    return () => {
      mountedRef.current = false;
      for (const controller of controllers) controller.abort();
      controllers.clear();
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      if (copyBinTimeoutRef.current) clearTimeout(copyBinTimeoutRef.current);
      saveInFlightRef.current = false;
      dimensionSaveInFlightRef.current = false;
      expandedDescSaveInFlightRef.current = false;
    };
  }, []);

  const handlePhotoChange = useCallback((uri: string | null) => {
    if (uri) {
      setNewPhotoData({ uri });
      setRemoveCurrentPhoto(false);
    } else {
      setNewPhotoData(null);
      setRemoveCurrentPhoto(true);
    }
    setSaveStatus("idle");
  }, []);

  const handlePhotoChange2 = useCallback((uri: string | null) => {
    if (uri) {
      setNewPhotoData2({ uri });
      setRemoveCurrentPhoto2(false);
    } else {
      setNewPhotoData2(null);
      setRemoveCurrentPhoto2(true);
    }
    setSaveStatus("idle");
  }, []);

  useEffect(() => {
    const current = item;
    if (!current) return;
    itemRef.current = current;
    const dims = current.dimensions;
    const incomingDescription = current.description ?? "";
    const incomingBins = current.binLocations ?? [];
    const incomingKeywords = current.aiKeywords ?? [];
    const incomingExpandedDescription = current.expandedDescription ?? "";
    const incomingDims = {
      length: dims?.length ?? null,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      diameter: dims?.diameter ?? null,
    };
    const descriptionDirty = description.trim() !== savedDescriptionRef.current.trim();
    const opDirty = Number(op.trim() || "0") !== savedOpRef.current;
    const oqDirty = Number(oq.trim() || "0") !== savedOqRef.current;
    const binsDirty = JSON.stringify(bins) !== JSON.stringify(savedBinsRef.current);
    const keywordsDirty = JSON.stringify(keywords) !== JSON.stringify(savedKeywordsRef.current);
    const dimensionsDirty = JSON.stringify({
      length: parseDimField(dimLength),
      width: parseDimField(dimWidth),
      height: parseDimField(dimHeight),
      diameter: parseDimField(dimDiameter),
    }) !== JSON.stringify(savedDimsRef.current);
    const expandedDescriptionDirty = expandedDescText.trim() !== savedExpandedDescRef.current.trim();
    const photoDirty = newPhotoData !== null || removeCurrentPhoto;
    const photo2Dirty = newPhotoData2 !== null || removeCurrentPhoto2;
    const hadDirtyFields = descriptionDirty || opDirty || oqDirty || binsDirty || keywordsDirty ||
      dimensionsDirty || expandedDescriptionDirty || photoDirty || photo2Dirty;

    if (!descriptionDirty) {
      savedDescriptionRef.current = incomingDescription;
      setDescription(incomingDescription);
    }
    if (!opDirty) {
      savedOpRef.current = current.orderPurchase;
      setOp(String(current.orderPurchase));
    }
    if (!oqDirty) {
      savedOqRef.current = current.orderQuantity;
      setOq(String(current.orderQuantity));
    }
    if (!binsDirty) {
      savedBinsRef.current = [...incomingBins];
      setBins(incomingBins);
    }
    if (!keywordsDirty) {
      savedKeywordsRef.current = [...incomingKeywords];
      setKeywords(incomingKeywords);
    }
    if (!dimensionsDirty) {
      savedDimsRef.current = incomingDims;
      setDimLength(fmtDim(dims?.length));
      setDimWidth(fmtDim(dims?.width));
      setDimHeight(fmtDim(dims?.height));
      setDimDiameter(fmtDim(dims?.diameter));
    }
    if (!expandedDescriptionDirty) {
      savedExpandedDescRef.current = incomingExpandedDescription;
      setExpandedDescText(incomingExpandedDescription);
    }
    if (!photoDirty) savedPhotoUriRef.current = current.imageUrl ?? null;
    if (!photo2Dirty) savedPhotoUri2Ref.current = current.imageUrl2 ?? null;

    if (!hadDirtyFields) {
      setNewBin("");
      setNewKeyword("");
      setNewPhotoData(null);
      setRemoveCurrentPhoto(false);
      setNewPhotoData2(null);
      setRemoveCurrentPhoto2(false);
      setSaveStatus("idle");
      setErrorMsg(null);
      setRefreshWarning(null);
      setFieldSaveErrors({});
      setCommittedFields(new Set());
      setCopiedBin(null);
      if (copyBinTimeoutRef.current) { clearTimeout(copyBinTimeoutRef.current); copyBinTimeoutRef.current = null; }
      setExpandedDescSaving("idle");
      setExpandedDescError(null);
    }
  // This reconciliation intentionally runs only when the host supplies a new
  // item snapshot; including local editor state would make every keystroke look
  // like an external refresh.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item]);

  const addBin = () => {
    const trimmed = newBin.trim();
    if (!trimmed) { setNewBin(""); return; }
    if (bins.some((b) => b.toLowerCase() === trimmed.toLowerCase())) { setNewBin(""); return; }
    setBins([...bins, trimmed]);
    setNewBin("");
    setSaveStatus("idle");
  };

  const removeBin = (bin: string) => {
    Alert.alert(
      "Remove Bin",
      `Remove bin location "${bin}"?`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: () => { setBins(bins.filter((b) => b !== bin)); setSaveStatus("idle"); } },
      ],
    );
  };

  const addKeyword = () => {
    const trimmed = newKeyword.trim().toLowerCase();
    if (!trimmed || keywords.includes(trimmed)) { setNewKeyword(""); return; }
    setKeywords([...keywords, trimmed]);
    setNewKeyword("");
    setSaveStatus("idle");
  };

  const removeKeyword = (kw: string) => {
    Alert.alert(
      "Remove Keyword",
      `Remove keyword "${kw}"?`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: () => { setKeywords(keywords.filter((k) => k !== kw)); setSaveStatus("idle"); } },
      ],
    );
  };

  const handleMeasureConfirm = useCallback(async (dims: PartDimensions) => {
    const current = itemRef.current;
    if (!current || !adminToken || dimensionSaveInFlightRef.current) return;
    pendingMeasureDimsRef.current = dims;
    dimensionSaveInFlightRef.current = true;
    setMeasureOpen(false);

    setDimLength(fmtDim(dims.length));
    setDimWidth(fmtDim(dims.width));
    setDimHeight(fmtDim(dims.height));
    setDimDiameter(fmtDim(dims.diameter));
    setSaveStatus("idle");
    setFieldSaveErrors(prev => {
      // exactOptionalPropertyTypes: drop the key to "unset" the field error
      const { dimensions: _dimensions, ...rest } = prev;
      return rest;
    });
    setRefreshWarning(null);
    try {
      const res = await fetchWrite(`${API_BASE}/inventory/${current.id}/dimensions`, {
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
      pendingMeasureDimsRef.current = null;
      savedDimsRef.current = {
        length: dims.length ?? null,
        width: dims.width ?? null,
        height: dims.height ?? null,
        diameter: dims.diameter ?? null,
      };
      reportItemSaved({ dimensions: dims });
      const cacheResult = await invalidateAllCachesAfterSave({
        queryClient,
        asyncStorage: AsyncStorage,
        itemId: current.id,
        updatedItem: { ...current, dimensions: dims },
      });
      if (cacheResult && !cacheResult.ok && mountedRef.current) setRefreshWarning(INVENTORY_REFRESH_WARNING);
    } catch (err) {
      if (isAbortError(err) && !mountedRef.current) return;
      if (mountedRef.current) {
        setFieldSaveErrors(prev => ({
          ...prev,
          dimensions: inventorySaveErrorMessage(err, "Could not save dimensions", { preserveServerMessage: false }),
        }));
      }
    } finally {
      dimensionSaveInFlightRef.current = false;
    }
  }, [adminToken, queryClient, fetchWrite, reportItemSaved]);

  const retryDimensionsSave = () => {
    const pendingDims = pendingMeasureDimsRef.current;
    if (pendingDims) void handleMeasureConfirm(pendingDims);
    else void handleSave();
  };

  const handleSaveExpandedDesc = async () => {
    const current = itemRef.current;
    if (!current || !adminToken) return;
    if (expandedDescSaveInFlightRef.current) return;
    expandedDescSaveInFlightRef.current = true;
    setExpandedDescSaving("saving");
    setExpandedDescError(null);
    setRefreshWarning(null);
    try {
      const res = await fetchWrite(`${API_BASE}/inventory/${current.id}/expanded-description`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ expandedDescription: expandedDescText.trim() || null }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const savedText = expandedDescText.trim() || null;
      savedExpandedDescRef.current = savedText ?? "";
      reportItemSaved({ expandedDescription: savedText });
      const cacheResult = await invalidateAllCachesAfterSave({
        queryClient,
        asyncStorage: AsyncStorage,
        itemId: current.id,
        updatedItem: { ...current, expandedDescription: savedText },
      });
      if (cacheResult && !cacheResult.ok && mountedRef.current) setRefreshWarning(INVENTORY_REFRESH_WARNING);
      setExpandedDescSaving("saved");
    } catch (err) {
      if (isAbortError(err) && !mountedRef.current) return;
      if (mountedRef.current) {
        setExpandedDescError(inventorySaveErrorMessage(err));
        setExpandedDescSaving("error");
      }
    } finally {
      expandedDescSaveInFlightRef.current = false;
    }
  };

  const handleClearExpandedDesc = async () => {
    const current = itemRef.current;
    if (!current || !adminToken) return;
    if (expandedDescSaveInFlightRef.current) return;
    expandedDescSaveInFlightRef.current = true;
    const previousText = expandedDescText;
    setExpandedDescText("");
    setExpandedDescSaving("saving");
    setExpandedDescError(null);
    setRefreshWarning(null);
    try {
      const res = await fetchWrite(`${API_BASE}/inventory/${current.id}/expanded-description`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ expandedDescription: null }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      savedExpandedDescRef.current = "";
      reportItemSaved({ expandedDescription: null });
      const cacheResult = await invalidateAllCachesAfterSave({
        queryClient,
        asyncStorage: AsyncStorage,
        itemId: current.id,
        updatedItem: { ...current, expandedDescription: null },
      });
      if (cacheResult && !cacheResult.ok && mountedRef.current) setRefreshWarning(INVENTORY_REFRESH_WARNING);
      setExpandedDescSaving("saved");
    } catch (err) {
      if (isAbortError(err) && !mountedRef.current) return;
      setExpandedDescText(previousText);
      if (mountedRef.current) {
        setExpandedDescError(inventorySaveErrorMessage(err, "Could not clear expanded description"));
        setExpandedDescSaving("error");
      }
    } finally {
      expandedDescSaveInFlightRef.current = false;
    }
  };

  const handleDeleteItem = useCallback(() => {
    const current = itemRef.current;
    if (!current || !adminToken) return;
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
              const res = await fetchWrite(`${API_BASE}/inventory/${current.id}`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${adminToken}` },
              });
              if (!res.ok) {
                const data = await res.json().catch(() => ({})) as { error?: string };
                Alert.alert("Delete Failed", data.error ?? `Could not delete part (HTTP ${res.status}).`);
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
              // Let the host screen prune the item from its offline Fuse.js
              // barcode index, which evictDeletedItemFromAllCaches does not touch.
              onItemDeleted?.(current.id);
              allowCloseRef.current = true;
              requestClose();
            } catch {
              Alert.alert("Delete Failed", "Could not delete the part. Check your connection and try again.");
            }
          },
        },
      ],
    );
  }, [adminToken, queryClient, onItemDeleted, fetchWrite, requestClose]);

  const saveInventory = async () => {
    const current = itemRef.current;
    if (!current || !adminToken) {
      setErrorMsg("Admin session expired. Re-unlock and try again.");
      setSaveStatus("error");
      return;
    }
    setSaveStatus("saving");
    setErrorMsg(null);
    setFieldSaveErrors({});

    const listKeyPrefix = getListInventoryQueryKey()[0];

    // onMutate: snapshot current cache state BEFORE any ops are built so the
    // snapshot reflects true pre-mutation data, even for TanStack mutations that
    // apply synchronous optimistic updates in their own onMutate callbacks.
    const inventorySnapshot = queryClient.getQueriesData<InventoryListResponse>(
      { predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === listKeyPrefix },
    );
    const searchSnapshot = queryClient.getQueriesData<SearchInventoryResponse>(
      { predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === "searchInventory" },
    );

    const ops: Array<InventorySaveOp> = [];

    // ?? "" handles newly-added items where description is null — null becomes ""
    // so a first-time description edit is correctly detected as a change.
    if (description.trim() !== (current.description ?? "").trim()) {
      ops.push({
        field: "description",
        restoreFn: () => setDescription(current.description ?? ""),
        promise: fetchWrite(`${API_BASE}/inventory/${current.id}/description`, {
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

    const parsedOp = Number(op.trim() || "0");
    const parsedOq = Number(oq.trim() || "0");
    if (![parsedOp, parsedOq].every((value) => Number.isSafeInteger(value) && value >= 0)) {
      setFieldSaveErrors({ opoq: "OP and OQ must be non-negative whole numbers." });
      setSaveStatus("error");
      return;
    }
    if (parsedOp !== current.orderPurchase || parsedOq !== current.orderQuantity) {
      ops.push({
        field: "opoq",
        restoreFn: () => {
          setOp(String(current.orderPurchase));
          setOq(String(current.orderQuantity));
        },
        promise: fetchWrite(`${API_BASE}/inventory/${current.id}/order`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
          body: JSON.stringify({ orderPurchase: parsedOp, orderQuantity: parsedOq }),
        }).then(async (res) => {
          if (!res.ok) {
            const data = await res.json().catch(() => ({})) as { error?: string };
            throw new Error(data.error ?? `HTTP ${res.status}`);
          }
        }),
      });
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

    const binsChanged = JSON.stringify(finalBins) !== JSON.stringify(current.binLocations ?? []);
    if (binsChanged) {
      ops.push({
        field: "bins",
        restoreFn: () => setBins(current.binLocations ?? []),
        promise: updateBinsMutation.mutateAsync({ id: current.id, data: { binLocations: finalBins } }),
      });
    }

    const kwChanged = JSON.stringify(finalKeywords) !== JSON.stringify(current.aiKeywords ?? []);
    if (kwChanged) {
      ops.push({
        field: "keywords",
        restoreFn: () => setKeywords(current.aiKeywords ?? []),
        promise: updateKeywordsMutation.mutateAsync({ id: current.id, data: { keywords: finalKeywords } }),
      });
    }

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

    if (dimsChanged) {
      ops.push({
        field: "dimensions",
        // Keep failed dimension values visible for the field-level retry.
        restoreFn: () => undefined,
        promise: fetchWrite(`${API_BASE}/inventory/${current.id}/dimensions`, {
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
    let capturedImageUrl2: string | null | undefined = undefined;

    if (newPhotoData) {
      const photoUri = newPhotoData.uri;
      const prevPhotoData = newPhotoData;
      ops.push({
        field: "photo",
        restoreFn: () => { setNewPhotoData(prevPhotoData); setRemoveCurrentPhoto(false); },
        promise: (async () => {
          const base64 = await FileSystem.readAsStringAsync(photoUri, {
            encoding: "base64",
          });
          const res = await fetchWrite(`${API_BASE}/inventory/${current.id}/photo`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
            body: JSON.stringify({ imageBase64: base64, mimeType: "image/jpeg", slot: 1 }),
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({})) as { error?: string };
            throw new Error(data.error ?? `HTTP ${res.status}`);
          }
          const data = await res.json() as { imageUrl?: string | null };
          capturedImageUrl = data.imageUrl ?? null;
        })(),
      });
    } else if (removeCurrentPhoto && current.imageUrl) {
      ops.push({
        field: "photo",
        restoreFn: () => setRemoveCurrentPhoto(false),
            promise: fetchWrite(`${API_BASE}/inventory/${current.id}/photo`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
          body: JSON.stringify({ remove: true, slot: 1 }),
        }).then(async (res) => {
          if (!res.ok) {
            const data = await res.json().catch(() => ({})) as { error?: string };
            throw new Error(data.error ?? `HTTP ${res.status}`);
          }
          capturedImageUrl = null;
        }),
      });
    }

    if (newPhotoData2) {
      const photoUri2 = newPhotoData2.uri;
      const prevPhotoData2 = newPhotoData2;
      ops.push({
        field: "photo2",
        restoreFn: () => { setNewPhotoData2(prevPhotoData2); setRemoveCurrentPhoto2(false); },
        promise: (async () => {
          const base64 = await FileSystem.readAsStringAsync(photoUri2, {
            encoding: "base64",
          });
          const res = await fetchWrite(`${API_BASE}/inventory/${current.id}/photo`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
            body: JSON.stringify({ imageBase64: base64, mimeType: "image/jpeg", slot: 2 }),
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({})) as { error?: string };
            throw new Error(data.error ?? `HTTP ${res.status}`);
          }
          const data = await res.json() as { imageUrl2?: string | null };
          capturedImageUrl2 = data.imageUrl2 ?? null;
        })(),
      });
    } else if (removeCurrentPhoto2 && current.imageUrl2) {
      ops.push({
        field: "photo2",
        restoreFn: () => setRemoveCurrentPhoto2(false),
            promise: fetchWrite(`${API_BASE}/inventory/${current.id}/photo`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
          body: JSON.stringify({ remove: true, slot: 2 }),
        }).then(async (res) => {
          if (!res.ok) {
            const data = await res.json().catch(() => ({})) as { error?: string };
            throw new Error(data.error ?? `HTTP ${res.status}`);
          }
          capturedImageUrl2 = null;
        }),
      });
    }

    if (ops.length === 0) {
      setSaveStatus("idle");
      return;
    }

    const results = await Promise.allSettled(ops.map((o) => o.promise));
    if (!mountedRef.current) return;
    const resolution = resolveInventorySaveResults(ops, results);
    const { anyFailed, fieldErrors: newFieldErrors, succeededFields } = resolution;

    if (anyFailed) {
      // onError: restore the full cache snapshot to roll back any optimistic
      // patches that TanStack mutations (bins, keywords) applied before they
      // failed. Restore rejected form fields to the server truth; the user can
      // edit them again before retrying.
      for (const [key, data] of inventorySnapshot) {
        queryClient.setQueryData(key, data);
      }
      for (const [key, data] of searchSnapshot) {
        queryClient.setQueryData(key, data);
      }

      // Re-apply patches for fields that SUCCEEDED so the list / search view
      // reflects what is now on the server, even though the overall save failed.
      // Only the failed fields need retry — succeeded fields are already committed.
      let partialUpdatedItem: InventoryItem | null = null;
      if (succeededFields.size > 0) {
        partialUpdatedItem = applySuccessfulInventoryFields(current, succeededFields, {
          description: { description: description.trim() },
          bins: { binLocations: finalBins },
          keywords: { aiKeywords: finalKeywords },
          dimensions: { dimensions: newDims },
          opoq: { orderPurchase: parsedOp, orderQuantity: parsedOq },
          ...(capturedImageUrl !== undefined ? { photo: { imageUrl: capturedImageUrl, thumbnailUrl: null } } : {}),
          ...(capturedImageUrl2 !== undefined ? { photo2: { imageUrl2: capturedImageUrl2, thumbnailUrl2: null } } : {}),
        });
      }

      setCommittedFields(prev => {
        const next = new Set(prev);
        succeededFields.forEach(f => next.add(f));
        return next;
      });
      if (succeededFields.has("description")) savedDescriptionRef.current = description.trim();
      if (succeededFields.has("opoq")) {
        savedOpRef.current = parsedOp;
        savedOqRef.current = parsedOq;
      }
      if (succeededFields.has("bins")) savedBinsRef.current = [...finalBins];
      if (succeededFields.has("keywords")) savedKeywordsRef.current = [...finalKeywords];
      if (succeededFields.has("dimensions")) savedDimsRef.current = { ...newDims };
      if (succeededFields.has("photo")) savedPhotoUriRef.current = capturedImageUrl ?? null;
      if (succeededFields.has("photo2")) savedPhotoUri2Ref.current = capturedImageUrl2 ?? null;
      if (succeededFields.has("description")) reportItemSaved({ description: description.trim() });
      if (succeededFields.has("opoq")) reportItemSaved({ orderPurchase: parsedOp, orderQuantity: parsedOq });
      if (succeededFields.has("bins")) reportItemSaved({ binLocations: finalBins });
      if (succeededFields.has("keywords")) reportItemSaved({ aiKeywords: finalKeywords });
      if (succeededFields.has("dimensions")) reportItemSaved({ dimensions: newDims });
      if (succeededFields.has("photo") && capturedImageUrl !== undefined) {
        reportItemSaved({ imageUrl: capturedImageUrl, thumbnailUrl: null });
      }
      if (succeededFields.has("photo2") && capturedImageUrl2 !== undefined) {
        reportItemSaved({ imageUrl2: capturedImageUrl2, thumbnailUrl2: null });
      }
      if (partialUpdatedItem) {
        const cacheResult = await invalidateAllCachesAfterSave({
          queryClient,
          asyncStorage: AsyncStorage,
          itemId: current.id,
          updatedItem: partialUpdatedItem,
        });
        if (cacheResult && !cacheResult.ok) setRefreshWarning(INVENTORY_REFRESH_WARNING);
      }

      setErrorMsg(resolution.message);

      setFieldSaveErrors(newFieldErrors);
      setSaveStatus("error");
    } else {
      const updatedItem: InventoryItem = {
        ...current,
        description: description.trim(),
        binLocations: finalBins,
        aiKeywords: finalKeywords,
        dimensions: dimsChanged ? newDims : (current.dimensions ?? null),
        orderPurchase: parsedOp,
        orderQuantity: parsedOq,
        ...(capturedImageUrl !== undefined ? { imageUrl: capturedImageUrl, thumbnailUrl: null } : {}),
        ...(capturedImageUrl2 !== undefined ? { imageUrl2: capturedImageUrl2, thumbnailUrl2: null } : {}),
      };
      setNewPhotoData(null);
      setNewPhotoData2(null);
      setRemoveCurrentPhoto(false);
      setRemoveCurrentPhoto2(false);
      savedDescriptionRef.current = description.trim();
      savedOpRef.current = parsedOp;
      savedOqRef.current = parsedOq;
      savedBinsRef.current = [...finalBins];
      savedKeywordsRef.current = [...finalKeywords];
      savedDimsRef.current = { ...newDims };
      savedPhotoUriRef.current = capturedImageUrl ?? null;
      savedPhotoUri2Ref.current = capturedImageUrl2 ?? null;
      reportItemSaved({
        description: description.trim(),
        binLocations: finalBins,
        aiKeywords: finalKeywords,
        dimensions: newDims,
        orderPurchase: parsedOp,
        orderQuantity: parsedOq,
        ...(capturedImageUrl !== undefined ? { imageUrl: capturedImageUrl, thumbnailUrl: null } : {}),
        ...(capturedImageUrl2 !== undefined ? { imageUrl2: capturedImageUrl2, thumbnailUrl2: null } : {}),
      });
      const cacheResult = await invalidateAllCachesAfterSave({
        queryClient,
        asyncStorage: AsyncStorage,
        itemId: current.id,
        updatedItem,
      });
      if (cacheResult && !cacheResult.ok) setRefreshWarning(INVENTORY_REFRESH_WARNING);
      await invalidateListCache({ queryClient }).catch(() => undefined);
      setSaveStatus("saved");
      if (!cacheResult || cacheResult.ok) {
        allowCloseRef.current = true;
        if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
        closeTimerRef.current = setTimeout(() => {
          closeTimerRef.current = null;
          requestClose();
        }, 500);
      }
    }

    // Failed server writes still refresh the query caches, but a refresh failure
    // must not turn a committed field write into a false server-save failure.
    if (anyFailed) {
      await Promise.all([
        invalidateListCache({ queryClient }).catch(() => undefined),
        queryClient.invalidateQueries({ queryKey: ["searchInventory"] }).catch(() => undefined),
      ]);
    }
  };

  const handleSave = async () => {
    if (saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    try {
      await saveInventory();
    } finally {
      saveInFlightRef.current = false;
    }
  };
  const retryFieldSave = () => { void handleSave(); };
  const retryExpandedDescription = () => {
    if (!expandedDescText.trim() && itemRef.current?.expandedDescription) {
      void handleClearExpandedDesc();
    } else {
      void handleSaveExpandedDesc();
    }
  };

  if (!item) return null;

  const isSaving = saveStatus === "saving";
  const isSaved = saveStatus === "saved";
  const isCloseBlocked =
    isSaving ||
    expandedDescSaving === "saving" ||
    saveInFlightRef.current ||
    dimensionSaveInFlightRef.current ||
    expandedDescSaveInFlightRef.current;

  const hasChanges =
    description.trim() !== savedDescriptionRef.current.trim() ||
    Number(op.trim() || "0") !== savedOpRef.current ||
    Number(oq.trim() || "0") !== savedOqRef.current ||
    JSON.stringify(bins) !== JSON.stringify(savedBinsRef.current) ||
    JSON.stringify(keywords) !== JSON.stringify(savedKeywordsRef.current) ||
    parseDimField(dimLength) !== savedDimsRef.current.length ||
    parseDimField(dimWidth) !== savedDimsRef.current.width ||
    parseDimField(dimHeight) !== savedDimsRef.current.height ||
    parseDimField(dimDiameter) !== savedDimsRef.current.diameter ||
    expandedDescText.trim() !== savedExpandedDescRef.current.trim() ||
    (newPhotoData?.uri ?? (removeCurrentPhoto ? null : item.imageUrl ?? null)) !== savedPhotoUriRef.current ||
    (newPhotoData2?.uri ?? (removeCurrentPhoto2 ? null : item.imageUrl2 ?? null)) !== savedPhotoUri2Ref.current;

  hasChangesRef.current = hasChanges;

  const currentPhotoUri = removeCurrentPhoto
    ? null
    : (newPhotoData?.uri ?? item.imageUrl ?? null);

  const currentPhotoUri2 = removeCurrentPhoto2
    ? null
    : (newPhotoData2?.uri ?? item.imageUrl2 ?? null);

  const isSlot1AiSourced = !!(item as unknown as { imageSource?: string | null }).imageSource;

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
        onRequestClose={() => requestClose()}
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
              onPress={() => requestClose()}
              disabled={isCloseBlocked}
              style={[styles.closeBtn, { backgroundColor: colors.muted, opacity: isCloseBlocked ? 0.45 : 1 }]}
              accessibilityLabel="Close editor"
              accessibilityRole="button"
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

            {/* Photos */}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>PHOTOS</Text>
              {(committedFields.has("photo") || committedFields.has("photo2")) ? (
                <Text style={{ color: colors.success, fontSize: 11, fontFamily: "Inter_500Medium" }}>✓ Saved</Text>
              ) : null}
            </View>
            <Text style={[styles.fieldHint, { color: colors.mutedForeground }]}>
              {Platform.OS !== "web"
                ? "Retake or remove item photos."
                : "Remove or replace item photos (capture requires a device)."}
            </Text>
            <View style={styles.photoSlots}>
              <PartPhotoPicker
                slot={1}
                label="Box / Label"
                value={currentPhotoUri}
                onChange={handlePhotoChange}
                isAiSourced={isSlot1AiSourced}
                {...(currentPhotoUri ? {
                  onPressPhoto: () => {
                    const uris = [currentPhotoUri, ...(currentPhotoUri2 ? [currentPhotoUri2] : [])];
                    setLightboxUris(uris);
                    setLightboxIndex(0);
                  },
                } : {})}
              />
              {fieldSaveErrors.photo ? (
                <View style={styles.fieldErrorRow}>
                  <Text style={[styles.fieldErrorText, { color: colors.destructive }]}>{fieldSaveErrors.photo}</Text>
                  <Pressable onPress={retryFieldSave} accessibilityRole="button" accessibilityLabel="Retry saving photo">
                    <Text style={[styles.retryText, { color: colors.destructive }]}>Retry</Text>
                  </Pressable>
                </View>
              ) : null}
              <PartPhotoPicker
                slot={2}
                label="Detail / Wire Frame"
                value={currentPhotoUri2}
                onChange={handlePhotoChange2}
                {...(currentPhotoUri2 ? {
                  onPressPhoto: () => {
                    const uris = [...(currentPhotoUri ? [currentPhotoUri] : []), currentPhotoUri2];
                    setLightboxUris(uris);
                    setLightboxIndex(currentPhotoUri ? 1 : 0);
                  },
                } : {})}
              />
              {fieldSaveErrors.photo2 ? (
                <View style={styles.fieldErrorRow}>
                  <Text style={[styles.fieldErrorText, { color: colors.destructive }]}>{fieldSaveErrors.photo2}</Text>
                  <Pressable onPress={retryFieldSave} accessibilityRole="button" accessibilityLabel="Retry saving second photo">
                    <Text style={[styles.retryText, { color: colors.destructive }]}>Retry</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>

            {/* Description */}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 20 }}>
              <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>DESCRIPTION</Text>
              {committedFields.has("description") ? (
                <Text style={{ color: colors.success, fontSize: 11, fontFamily: "Inter_500Medium" }}>✓ Saved</Text>
              ) : null}
            </View>
            <KeyboardDoneInput
              value={description}
              onChangeText={setDescription}
              placeholder="Brief description of the part…"
              placeholderTextColor={colors.mutedForeground}
              multiline
              numberOfLines={3}
              maxLength={500}
              style={[
                styles.descInput,
                { backgroundColor: colors.muted, borderColor: fieldSaveErrors.description ? colors.destructive : colors.border, color: colors.foreground },
              ]}
              autoCorrect
              autoCapitalize="sentences"
              returnKeyType="default"
            />
            {fieldSaveErrors.description ? (
              <View style={styles.fieldErrorRow}>
                <Text style={[styles.fieldErrorText, { color: colors.destructive }]}>{fieldSaveErrors.description}</Text>
                <Pressable onPress={retryFieldSave} accessibilityRole="button" accessibilityLabel="Retry saving description">
                  <Text style={[styles.retryText, { color: colors.destructive }]}>Retry</Text>
                </Pressable>
              </View>
            ) : null}

            {/* Inventory controls */}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 20 }}>
              <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>INVENTORY CONTROLS</Text>
              {committedFields.has("opoq") ? (
                <Text style={{ color: colors.success, fontSize: 11, fontFamily: "Inter_500Medium" }}>✓ Saved</Text>
              ) : null}
            </View>
            <Text style={[styles.fieldHint, { color: colors.mutedForeground }]}>
              OP and OQ are non-negative whole numbers.
            </Text>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
              {([
                ["OP", op, setOp],
                ["OQ", oq, setOq],
              ] as const).map(([label, value, setter]) => (
                <View key={label} style={{ flex: 1 }}>
                  <Text style={[styles.dimLabel, { color: colors.mutedForeground }]}>{label}</Text>
                  <KeyboardDoneInput
                    value={value}
                    onChangeText={(v) => { setter(v.replace(/[^0-9]/g, "")); setSaveStatus("idle"); }}
                    placeholder="0"
                    placeholderTextColor={colors.mutedForeground}
                    keyboardType="number-pad"
                    style={[styles.dimInput, { backgroundColor: colors.muted, borderColor: fieldSaveErrors.opoq ? colors.destructive : colors.border, color: colors.foreground }]}
                  />
                </View>
              ))}
            </View>
            {fieldSaveErrors.opoq ? (
              <View style={styles.fieldErrorRow}>
                <Text style={[styles.fieldErrorText, { color: colors.destructive }]}>{fieldSaveErrors.opoq}</Text>
                <Pressable onPress={retryFieldSave} accessibilityRole="button" accessibilityLabel="Retry saving OP and OQ">
                  <Text style={[styles.retryText, { color: colors.destructive }]}>Retry</Text>
                </Pressable>
              </View>
            ) : null}

            {/* Expanded Description (admin enrichment — saved independently) */}
            <Text style={[styles.sectionLabel, { color: colors.mutedForeground, marginTop: 20 }]}>EXPANDED DESCRIPTION</Text>
            <Text style={[styles.fieldHint, { color: colors.mutedForeground }]}>
              AI-expanded plain-English version. Edit, then tap Save. Tap the trash icon to clear.
            </Text>
            <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 4 }}>
              <KeyboardDoneInput
                value={expandedDescText}
                onChangeText={(v) => { setExpandedDescText(v); if (expandedDescSaving !== "idle") setExpandedDescSaving("idle"); }}
                placeholder="No expanded description yet…"
                placeholderTextColor={colors.mutedForeground}
                multiline
                numberOfLines={3}
                maxLength={1000}
                style={[
                  styles.descInput,
                  { flex: 1, backgroundColor: colors.muted, borderColor: expandedDescSaving === "error" ? colors.destructive : colors.border, color: colors.foreground },
                ]}
                autoCorrect
                autoCapitalize="sentences"
                returnKeyType="default"
              />
              <Pressable
                onPress={handleClearExpandedDesc}
                disabled={expandedDescSaving === "saving" || (!expandedDescText && !item.expandedDescription)}
                style={{
                  padding: 10,
                  borderRadius: 6,
                  backgroundColor: colors.muted,
                  borderWidth: 1,
                  borderColor: colors.border,
                  marginTop: 2,
                  opacity: (expandedDescSaving === "saving" || (!expandedDescText && !item.expandedDescription)) ? 0.4 : 1,
                }}
                accessibilityLabel="Clear expanded description"
              >
                <Feather name="trash-2" size={16} color={colors.destructive} />
              </Pressable>
            </View>
            {expandedDescSaving === "error" && expandedDescError ? (
              <View style={styles.fieldErrorRow}>
                <Text style={[styles.fieldErrorText, { color: colors.destructive }]}>{expandedDescError}</Text>
                <Pressable onPress={retryExpandedDescription} accessibilityRole="button" accessibilityLabel="Retry saving expanded description">
                  <Text style={[styles.retryText, { color: colors.destructive }]}>Retry</Text>
                </Pressable>
              </View>
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
              disabled={expandedDescSaving === "saving" || expandedDescText.trim() === (item.expandedDescription ?? "")}
              style={[
                styles.saveBtn,
                {
                  marginTop: 8, marginBottom: 4,
                  backgroundColor:
                    (expandedDescSaving === "saving" || expandedDescText.trim() === (item.expandedDescription ?? ""))
                      ? colors.muted
                      : colors.primary,
                },
              ]}
            >
              <Text
                style={[
                  styles.saveBtnText,
                  {
                    color:
                      (expandedDescSaving === "saving" || expandedDescText.trim() === (item.expandedDescription ?? ""))
                        ? colors.mutedForeground
                        : colors.primaryForeground,
                  },
                ]}
              >
                Save Expanded Description
              </Text>
            </Pressable>

            {/* Bin Locations */}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 20 }}>
              <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
                BIN LOCATIONS ({bins.length})
              </Text>
              {committedFields.has("bins") ? (
                <Text style={{ color: colors.success, fontSize: 11, fontFamily: "Inter_500Medium" }}>✓ Saved</Text>
              ) : null}
            </View>
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
                    disabled={isSaving}
                    style={[styles.chipRemoveBtn, isSaving && { opacity: 0.4 }]}
                    accessibilityLabel={`Remove bin ${b}`}
                  >
                    <Text style={[styles.chipRemove, { color: colors.mutedForeground }]}>✕</Text>
                  </Pressable>
                </View>
              ))}
            </View>
            {fieldSaveErrors.bins ? (
              <View style={styles.fieldErrorRow}>
                <Text style={[styles.fieldErrorText, { color: colors.destructive }]}>{fieldSaveErrors.bins}</Text>
                <Pressable onPress={retryFieldSave} accessibilityRole="button" accessibilityLabel="Retry saving bins">
                  <Text style={[styles.retryText, { color: colors.destructive }]}>Retry</Text>
                </Pressable>
              </View>
            ) : null}
            {bins.length === 0 && (
              <Text style={[styles.emptyHint, { color: colors.mutedForeground }]}>
                No additional bins. The initial bin was added on creation.
              </Text>
            )}
            <View style={[styles.addRow, { marginTop: 10 }]}>
              <KeyboardDoneInput
                value={newBin}
                onChangeText={setNewBin}
                placeholder="e.g. A1-04"
                placeholderTextColor={colors.mutedForeground}
                maxLength={30}
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
            {newBin.trim() && !isBinLocationValid(newBin) ? (
              <Text style={[styles.fieldHint, { color: colors.warning, marginTop: 4 }]}>
                ⚠ {BIN_FORMAT_HINT}
              </Text>
            ) : null}

            {/* Keywords */}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 24 }}>
              <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
                KEYWORDS ({keywords.length})
              </Text>
              {committedFields.has("keywords") ? (
                <Text style={{ color: colors.success, fontSize: 11, fontFamily: "Inter_500Medium" }}>✓ Saved</Text>
              ) : null}
            </View>
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
              <View style={styles.fieldErrorRow}>
                <Text style={[styles.fieldErrorText, { color: colors.destructive }]}>{fieldSaveErrors.keywords}</Text>
                <Pressable onPress={retryFieldSave} accessibilityRole="button" accessibilityLabel="Retry saving keywords">
                  <Text style={[styles.retryText, { color: colors.destructive }]}>Retry</Text>
                </Pressable>
              </View>
            ) : null}
            {keywords.length === 0 && (
              <Text style={[styles.emptyHint, { color: colors.mutedForeground }]}>
                No keywords yet. Add some below.
              </Text>
            )}
            <View style={[styles.addRow, { marginTop: 10 }]}>
              <KeyboardDoneInput
                value={newKeyword}
                onChangeText={setNewKeyword}
                placeholder="Type keyword and press Add…"
                placeholderTextColor={colors.mutedForeground}
                maxLength={60}
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
                {committedFields.has("dimensions") ? (
                  <Text style={{ color: colors.success, fontSize: 11, fontFamily: "Inter_500Medium" }}>✓ Saved</Text>
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
                <KeyboardDoneInput
                  value={dimLength}
                  onChangeText={v => { pendingMeasureDimsRef.current = null; setDimLength(v.replace(/[^0-9.]/g, "")); setSaveStatus("idle"); }}
                  placeholder="–"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="numeric"
                  style={[styles.dimInput, { backgroundColor: colors.muted, borderColor: fieldSaveErrors.dimensions ? colors.destructive : colors.border, color: colors.foreground }]}
                />
              </View>
              <View style={styles.dimField}>
                <Text style={[styles.dimLabel, { color: colors.mutedForeground }]}>Width</Text>
                <KeyboardDoneInput
                  value={dimWidth}
                  onChangeText={v => { pendingMeasureDimsRef.current = null; setDimWidth(v.replace(/[^0-9.]/g, "")); setSaveStatus("idle"); }}
                  placeholder="–"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="numeric"
                  style={[styles.dimInput, { backgroundColor: colors.muted, borderColor: fieldSaveErrors.dimensions ? colors.destructive : colors.border, color: colors.foreground }]}
                />
              </View>
              <View style={styles.dimField}>
                <Text style={[styles.dimLabel, { color: colors.mutedForeground }]}>Height</Text>
                <KeyboardDoneInput
                  value={dimHeight}
                  onChangeText={v => { pendingMeasureDimsRef.current = null; setDimHeight(v.replace(/[^0-9.]/g, "")); setSaveStatus("idle"); }}
                  placeholder="–"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="numeric"
                  style={[styles.dimInput, { backgroundColor: colors.muted, borderColor: fieldSaveErrors.dimensions ? colors.destructive : colors.border, color: colors.foreground }]}
                />
              </View>
              <View style={styles.dimField}>
                <Text style={[styles.dimLabel, { color: colors.mutedForeground }]}>Diameter</Text>
                <KeyboardDoneInput
                  value={dimDiameter}
                  onChangeText={v => { pendingMeasureDimsRef.current = null; setDimDiameter(v.replace(/[^0-9.]/g, "")); setSaveStatus("idle"); }}
                  placeholder="–"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="numeric"
                  style={[styles.dimInput, { backgroundColor: colors.muted, borderColor: fieldSaveErrors.dimensions ? colors.destructive : colors.border, color: colors.foreground }]}
                />
              </View>
            </View>
            {fieldSaveErrors.dimensions ? (
            <View style={styles.fieldErrorRow}>
                <Text style={[styles.fieldErrorText, { color: colors.destructive }]}>{fieldSaveErrors.dimensions}</Text>
                <Pressable onPress={retryDimensionsSave} accessibilityRole="button" accessibilityLabel="Retry saving dimensions">
                  <Text style={[styles.retryText, { color: colors.destructive }]}>Retry</Text>
                </Pressable>
              </View>
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
            {refreshWarning ? (
              <View style={[styles.errorBanner, { backgroundColor: colors.warning + "18", borderColor: colors.warning + "66" }]}>
                <Text style={[styles.errorText, { color: colors.warning }]}>{refreshWarning}</Text>
              </View>
            ) : null}
          </ScrollView>

          <View style={[styles.footer, { borderTopColor: colors.border }]}>
            {onShowOnMap && item ? (
              <Pressable
                onPress={() => requestClose(() => {
                  onClose();
                  onShowOnMap(item);
                })}
                style={[styles.mapBtn, { backgroundColor: colors.accentForeground + "18", borderColor: colors.accentForeground + "44" }]}
                accessibilityLabel="Show this part on the map"
              >
                <Feather name="map-pin" size={14} color={colors.accentForeground} />
                <Text style={[styles.mapBtnText, { color: colors.accentForeground }]}>Map it!</Text>
              </Pressable>
            ) : null}
            {adminToken ? (
              <Pressable
                onPress={handleDeleteItem}
                disabled={isSaving}
                style={[styles.deleteBtn, { backgroundColor: colors.destructive + "18", borderColor: colors.destructive + "44", opacity: isSaving ? 0.4 : 1 }]}
                accessibilityLabel="Delete this part"
              >
                <Feather name="trash-2" size={14} color={colors.destructive} />
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => requestClose()}
              disabled={isCloseBlocked}
              style={[styles.cancelBtn, { borderColor: colors.border, opacity: isCloseBlocked ? 0.45 : 1 }]}
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

      <ConfirmDialog
        visible={discardDialogVisible}
        title="Discard changes?"
        message="Your edits will be lost."
        confirmLabel="Discard"
        cancelLabel="Keep Editing"
        destructive
        onConfirm={discardChanges}
        onCancel={keepEditing}
      />

      <InfoDialog
        visible={saveInFlightDialogVisible}
        title="Save in progress"
        message="Please wait for the current save to finish before closing this editor."
        dismissLabel="Keep Editing"
        onDismiss={keepEditing}
      />

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

      <PhotoLightbox
        uris={lightboxUris}
        initialIndex={lightboxIndex}
        onClose={() => { setLightboxUris([]); setLightboxIndex(0); }}
      />

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
  photoSlots: { gap: 12 },
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
  fieldErrorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  retryText: {
    fontSize: 12,
    fontFamily: "Inter_700Bold",
    textDecorationLine: "underline",
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
  deleteBtn: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 14,
    paddingHorizontal: 12,
  },
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
