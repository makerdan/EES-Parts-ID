import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { KeyboardDoneInput } from "@/components/KeyboardDoneInput";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system";
import { Feather } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { PartPhotoPicker } from "@/components/PartPhotoPicker";
import type { InventoryItem } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateInventoryList } from "@/utils/listEditorHandlers";
import { useColors } from "@/hooks/useColors";

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : "http://localhost:8080/api";

const STEP_OPTIONS = [1, 2, 5, 10] as const;
type Step = (typeof STEP_OPTIONS)[number];

const STORAGE_PREFIX_KEY = "shelfEntry_prefix";
const STORAGE_STEP_KEY = "shelfEntry_step";

interface ShelfCatalogEntryProps {
  visible: boolean;
  adminToken: string | null;
  onClose: () => void;
}

interface CapturedPhoto {
  uri: string;
}

interface DuplicateState {
  item: InventoryItem;
  pendingBin: string;
  pendingPhoto: CapturedPhoto | null;
  pendingPhoto2: CapturedPhoto | null;
  pendingMode: "next" | "done";
}

export function ShelfCatalogEntry({ visible, adminToken, onClose }: ShelfCatalogEntryProps) {
  "use no memo";
  const colors = useColors();
  const queryClient = useQueryClient();

  const [shelfPrefix, setShelfPrefix] = useState("");
  const [startPosition, setStartPosition] = useState("");
  const [step, setStep] = useState<Step>(1);
  const [position, setPosition] = useState("");
  const [positionEditing, setPositionEditing] = useState(false);

  const [catalog, setCatalog] = useState("");
  const [vendor, setVendor] = useState("");
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  const [photo2, setPhoto2] = useState<CapturedPhoto | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successCount, setSuccessCount] = useState(0);
  const [photoCount, setPhotoCount] = useState(0);

  const [duplicate, setDuplicate] = useState<DuplicateState | null>(null);
  const [duplicateLoading, setDuplicateLoading] = useState(false);

  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  const [prefixScannerOpen, setPrefixScannerOpen] = useState(false);
  const prefixScanLock = useRef(false);

  const positionRef = useRef(position);
  useEffect(() => { positionRef.current = position; }, [position]);

  const hydratedRef = useRef(false);

  const binCode = shelfPrefix.trim() && position.trim()
    ? `${shelfPrefix.trim()}-${position.trim()}`
    : "";

  const loadShelfPreferences = useCallback(async () => {
    if (adminToken) {
      try {
        const res = await fetch(`${API_BASE}/admin/shelf-preferences`, {
          headers: { Authorization: `Bearer ${adminToken}` },
        });
        if (res.ok) {
          const data = await res.json() as { shelfPrefix: string | null; shelfStep: number | null };
          const hasServerPrefix = data.shelfPrefix !== null && data.shelfPrefix !== undefined;
          const hasServerStep = data.shelfStep !== null && data.shelfStep !== undefined
            && (STEP_OPTIONS as readonly number[]).includes(data.shelfStep);
          if (hasServerPrefix || hasServerStep) {
            if (hasServerPrefix) {
              setShelfPrefix(data.shelfPrefix as string);
              AsyncStorage.setItem(STORAGE_PREFIX_KEY, data.shelfPrefix as string).catch(() => {});
            }
            if (hasServerStep) {
              setStep(data.shelfStep as Step);
              AsyncStorage.setItem(STORAGE_STEP_KEY, String(data.shelfStep)).catch(() => {});
            }
            hydratedRef.current = true;
            return;
          }
          // Server had no saved preferences yet — fall through to AsyncStorage
        }
      } catch {
        // fall through to AsyncStorage
      }
    }
    AsyncStorage.multiGet([STORAGE_PREFIX_KEY, STORAGE_STEP_KEY]).then(pairs => {
      const savedPrefix = pairs[0][1];
      const savedStep = pairs[1][1];
      if (savedPrefix !== null && savedPrefix !== undefined) setShelfPrefix(savedPrefix);
      if (savedStep !== null && savedStep !== undefined) {
        const parsed = parseInt(savedStep, 10) as Step;
        if ((STEP_OPTIONS as readonly number[]).includes(parsed)) setStep(parsed);
      }
      hydratedRef.current = true;
    }).catch(() => {
      hydratedRef.current = true;
    });
  }, [adminToken]);

  const saveShelfPreferences = useCallback((prefix: string, stepVal: Step) => {
    if (!adminToken) return;
    fetch(`${API_BASE}/admin/shelf-preferences`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ shelfPrefix: prefix, shelfStep: stepVal }),
    }).catch(() => {});
  }, [adminToken]);

  useEffect(() => {
    if (!visible) {
      hydratedRef.current = false;
      setStartPosition("");
      setPosition("");
      setPositionEditing(false);
      setCatalog("");
      setVendor("");
      setPhoto(null);
      setPhoto2(null);
      setError(null);
      setSuccessCount(0);
      setPhotoCount(0);
      setDuplicate(null);
      setPrefixScannerOpen(false);
      prefixScanLock.current = false;
    } else {
      loadShelfPreferences();
    }
  }, [visible, loadShelfPreferences]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    AsyncStorage.setItem(STORAGE_PREFIX_KEY, shelfPrefix).catch(() => {});
    saveShelfPreferences(shelfPrefix, step);
  }, [shelfPrefix]);// eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!hydratedRef.current) return;
    AsyncStorage.setItem(STORAGE_STEP_KEY, String(step)).catch(() => {});
    saveShelfPreferences(shelfPrefix, step);
  }, [step]);// eslint-disable-line react-hooks/exhaustive-deps

  const handleStartPositionChange = useCallback((val: string) => {
    const digits = val.replace(/\D/g, "").slice(0, 3);
    setStartPosition(digits);
    if (!positionEditing) {
      setPosition(digits);
    }
  }, [positionEditing]);

  const handlePositionTap = useCallback(() => {
    setPositionEditing(true);
  }, []);

  const resetItemFields = useCallback(() => {
    setCatalog("");
    setVendor("");
    setPhoto(null);
    setPhoto2(null);
    setError(null);
    setDuplicate(null);
  }, []);

  const advanceCounter = useCallback(() => {
    setPosition(prev => {
      const num = parseInt(prev || startPosition || "0", 10);
      const next = num + step;
      if (next > 999) return prev;
      return String(next);
    });
    setPositionEditing(false);
    setStartPosition(prev => {
      const num = parseInt(positionRef.current || prev || "0", 10);
      const next = num + step;
      return next > 999 ? prev : String(next);
    });
  }, [step, startPosition]);

  const currentBin = binCode;

  const positionOverLimit = (() => {
    const num = parseInt(position, 10);
    return !isNaN(num) && num + step > 999;
  })();

  const uploadPhoto = useCallback(async (itemId: number, capturedPhoto: CapturedPhoto, slot: 1 | 2 = 1) => {
    try {
      const res = await fetch(`${API_BASE}/inventory/${itemId}/photo`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ imageBase64: await FileSystem.readAsStringAsync(capturedPhoto.uri, { encoding: "base64" }), mimeType: "image/jpeg", slot }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      console.warn("Photo upload failed:", err);
      throw err;
    }
  }, [adminToken]);

  const invalidateInventory = useCallback(async () => {
    await invalidateInventoryList({ queryClient });
  }, [queryClient]);

  const handleSubmit = useCallback(async (mode: "next" | "done") => {
    if (submitting) return;
    setError(null);

    const catalogTrimmed = catalog.trim();
    const vendorTrimmed = vendor.trim();
    const binTrimmed = currentBin.trim();

    if (!shelfPrefix.trim()) { setError("Set a shelf prefix first (e.g. 08-01)"); return; }
    if (!position.trim()) { setError("Set a starting position first"); return; }
    if (!catalogTrimmed) { setError("Catalog number is required"); return; }
    if (!vendorTrimmed) { setError("Vendor code is required"); return; }
    if (!binTrimmed) { setError("Shelf prefix and position are required"); return; }
    if (!adminToken) { setError("Admin session expired. Re-unlock and try again."); return; }

    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/inventory/add-part`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          vendor: vendorTrimmed,
          catalog: catalogTrimmed,
          binLocation: binTrimmed,
        }),
      });

      if (res.status === 409) {
        const data = await res.json() as { error?: string; existingItem?: InventoryItem };
        const existingItem = data.existingItem ?? null;
        if (existingItem) {
          setDuplicate({ item: existingItem, pendingBin: binTrimmed, pendingPhoto: photo, pendingPhoto2: photo2, pendingMode: mode });
        } else {
          setError(data.error ?? "Item already exists.");
        }
        return;
      }

      if (res.status === 401) {
        setError("Admin session expired. Re-unlock and try again.");
        return;
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setError(data.error ?? "Failed to add item. Check connection and try again.");
        return;
      }

      const data = await res.json() as { item: InventoryItem };
      const createdItem = data.item;

      if (photo || photo2) {
        const uploads: Promise<void>[] = [];
        if (photo) uploads.push(uploadPhoto(createdItem.id, photo, 1));
        if (photo2) uploads.push(uploadPhoto(createdItem.id, photo2, 2));
        const results = await Promise.allSettled(uploads);
        if (results.some(r => r.status === "rejected")) {
          setError("Item added but one or more photo uploads failed — check connection.");
        }
      }

      await invalidateInventory();
      setSuccessCount(c => c + 1);
      if (photo || photo2) setPhotoCount(c => c + 1);
      resetItemFields();

      if (mode === "next") {
        advanceCounter();
      } else {
        onClose();
      }
    } catch {
      setError("Network error. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }, [submitting, catalog, vendor, currentBin, adminToken, photo, photo2, position, shelfPrefix, uploadPhoto, invalidateInventory, resetItemFields, advanceCounter, onClose]);

  const handleConfirmDuplicate = useCallback(async () => {
    if (!duplicate || !adminToken) return;
    setDuplicateLoading(true);
    try {
      const existingBins = duplicate.item.binLocations ?? [];
      const newBins = existingBins.includes(duplicate.pendingBin)
        ? existingBins
        : [...existingBins, duplicate.pendingBin];

      const res = await fetch(`${API_BASE}/inventory/${duplicate.item.id}/bins`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ binLocations: newBins }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setError(data.error ?? "Failed to update bin location.");
        setDuplicate(null);
        return;
      }

      if (duplicate.pendingPhoto || duplicate.pendingPhoto2) {
        const uploads: Promise<void>[] = [];
        if (duplicate.pendingPhoto) uploads.push(uploadPhoto(duplicate.item.id, duplicate.pendingPhoto, 1));
        if (duplicate.pendingPhoto2) uploads.push(uploadPhoto(duplicate.item.id, duplicate.pendingPhoto2, 2));
        const results = await Promise.allSettled(uploads);
        if (results.some(r => r.status === "rejected")) {
          setError("Bin updated but one or more photo uploads failed — check connection.");
        }
      }

      await invalidateInventory();
      setSuccessCount(c => c + 1);
      if (duplicate.pendingPhoto || duplicate.pendingPhoto2) setPhotoCount(c => c + 1);
      const resolvedMode = duplicate.pendingMode;
      setDuplicate(null);
      resetItemFields();
      if (resolvedMode === "next") {
        advanceCounter();
      } else {
        onClose();
      }
    } catch {
      setError("Network error. Check connection and try again.");
      setDuplicate(null);
    } finally {
      setDuplicateLoading(false);
    }
  }, [duplicate, adminToken, uploadPhoto, invalidateInventory, resetItemFields, advanceCounter, onClose]);

  const formatPrefix = useCallback((val: string) => {
    const alnum = val.replace(/[^0-9A-Za-z]/g, "").toUpperCase().slice(0, 4);
    if (alnum.length <= 2) return alnum;
    return `${alnum.slice(0, 2)}-${alnum.slice(2)}`;
  }, []);

  const openPrefixScanner = useCallback(async () => {
    if (!cameraPermission?.granted) {
      const result = await requestCameraPermission();
      if (!result.granted) return;
    }
    prefixScanLock.current = false;
    setPrefixScannerOpen(true);
  }, [cameraPermission, requestCameraPermission]);

  const handlePrefixScanned = useCallback(({ data }: { data: string }) => {
    if (prefixScanLock.current) return;
    prefixScanLock.current = true;
    const alnum = data.replace(/[^0-9A-Za-z]/g, "").toUpperCase().slice(0, 4);
    const formatted = alnum.length <= 2 ? alnum : `${alnum.slice(0, 2)}-${alnum.slice(2)}`;
    setShelfPrefix(formatted);
    setPrefixScannerOpen(false);
  }, []);

  if (!visible) return null;

  return (
    <>
      <Modal
        visible={visible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={onClose}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={[styles.container, { backgroundColor: colors.background }]}
        >
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.title, { color: colors.foreground }]}>Shelf Entry</Text>
              <Text style={[styles.sub, { color: colors.mutedForeground }]}>
                {successCount > 0
                  ? `${successCount} item${successCount !== 1 ? "s" : ""} added${photoCount > 0 ? ` 📷 ${photoCount}` : ""}`
                  : "Rapid per-shelf cataloging"}
              </Text>
            </View>
            <Pressable onPress={onClose} style={[styles.closeBtn, { backgroundColor: colors.muted }]}>
              <Text style={{ color: colors.foreground, fontSize: 14 }}>✕</Text>
            </Pressable>
          </View>

          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            {/* ── Shelf Header ───────────────────────────── */}
            <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>SHELF SETUP</Text>
              <Text style={[styles.hint, { color: colors.mutedForeground }]}>
                Set once per shelf — stays the same while you work down the aisle.
              </Text>

              <View style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.fieldLabel, { color: colors.foreground }]}>Shelf Prefix</Text>
                  <View style={styles.prefixRow}>
                    <KeyboardDoneInput
                      value={shelfPrefix}
                      onChangeText={v => setShelfPrefix(formatPrefix(v))}
                      placeholder="e.g. 08-01"
                      placeholderTextColor={colors.mutedForeground}
                      autoCorrect={false}
                      autoCapitalize="characters"
                      style={[
                        styles.input,
                        styles.prefixInput,
                        { backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground },
                      ]}
                    />
                    {Platform.OS !== "web" ? (
                      <Pressable
                        onPress={openPrefixScanner}
                        style={[styles.prefixScanBtn, { backgroundColor: colors.muted, borderColor: colors.border }]}
                        accessibilityLabel="Scan shelf prefix barcode"
                      >
                        <Feather name="maximize" size={18} color={colors.foreground} />
                      </Pressable>
                    ) : null}
                  </View>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.fieldLabel, { color: colors.foreground }]}>Start Position</Text>
                  <KeyboardDoneInput
                    value={startPosition}
                    onChangeText={handleStartPositionChange}
                    placeholder="801"
                    placeholderTextColor={colors.mutedForeground}
                    keyboardType="number-pad"
                    maxLength={3}
                    autoCorrect={false}
                    style={[
                      styles.input,
                      { backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground },
                    ]}
                  />
                </View>
              </View>

              <Text style={[styles.fieldLabel, { color: colors.foreground, marginTop: 12 }]}>Increment Step</Text>
              <View style={styles.stepRow}>
                {STEP_OPTIONS.map(s => (
                  <Pressable
                    key={s}
                    onPress={() => setStep(s)}
                    style={[
                      styles.stepBtn,
                      {
                        backgroundColor: step === s ? colors.primary : colors.muted,
                        borderColor: step === s ? colors.primary : colors.border,
                      },
                    ]}
                  >
                    <Text style={[styles.stepBtnText, { color: step === s ? colors.primaryForeground : colors.foreground }]}>
                      +{s}
                    </Text>
                  </Pressable>
                ))}
              </View>

              <View style={[styles.previewRow, { backgroundColor: colors.accent, borderColor: colors.primary + "44" }]}>
                <Text style={[styles.previewLabel, { color: colors.mutedForeground }]}>Next bin code</Text>
                <Text style={[styles.previewCode, { color: binCode ? colors.primary : colors.mutedForeground }]}>
                  {binCode || "—"}
                </Text>
              </View>

              {positionOverLimit ? (
                <View style={[styles.warnBanner, { backgroundColor: colors.warning + "18", borderColor: colors.warning + "44" }]}>
                  <Text style={[styles.warnText, { color: colors.warning }]}>
                    ⚠ Next position would exceed 999 — reset start position before continuing.
                  </Text>
                </View>
              ) : null}
            </View>

            {/* ── Item Entry ─────────────────────────────── */}
            <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>ITEM #{successCount + 1}</Text>

              <Text style={[styles.fieldLabel, { color: colors.foreground }]}>Shelf Position</Text>
              {positionEditing ? (
                <KeyboardDoneInput
                  value={position}
                  onChangeText={setPosition}
                  keyboardType="number-pad"
                  maxLength={3}
                  autoCorrect={false}
                  autoFocus
                  onBlur={() => setPositionEditing(false)}
                  style={[
                    styles.input,
                    { backgroundColor: colors.muted, borderColor: colors.primary, color: colors.foreground },
                  ]}
                />
              ) : (
                <Pressable
                  onPress={handlePositionTap}
                  style={[
                    styles.positionDisplay,
                    { backgroundColor: colors.muted, borderColor: colors.border },
                  ]}
                >
                  <Text style={[styles.positionText, { color: position ? colors.foreground : colors.mutedForeground }]}>
                    {position || "—"}
                  </Text>
                  <Feather name="edit-2" size={13} color={colors.mutedForeground} />
                </Pressable>
              )}
              <Text style={[styles.miniHint, { color: colors.mutedForeground }]}>
                Auto-increments by +{step}. Tap to override.
              </Text>

              <Text style={[styles.fieldLabel, { color: colors.foreground, marginTop: 14 }]}>Catalog Number</Text>
              <KeyboardDoneInput
                value={catalog}
                onChangeText={v => { setCatalog(v.toUpperCase()); setError(null); setDuplicate(null); }}
                placeholder="e.g. BR120"
                placeholderTextColor={colors.mutedForeground}
                autoCorrect={false}
                autoCapitalize="characters"
                returnKeyType="next"
                style={[
                  styles.input,
                  { backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground },
                ]}
              />

              <Text style={[styles.fieldLabel, { color: colors.foreground, marginTop: 14 }]}>Vendor Code</Text>
              <KeyboardDoneInput
                value={vendor}
                onChangeText={v => { setVendor(v.toUpperCase()); setError(null); }}
                placeholder="e.g. EATON"
                placeholderTextColor={colors.mutedForeground}
                autoCorrect={false}
                autoCapitalize="characters"
                returnKeyType="done"
                style={[
                  styles.input,
                  { backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground },
                ]}
              />

              {/* Photos (optional) */}
              <Text style={[styles.fieldLabel, { color: colors.foreground, marginTop: 14 }]}>Photos (optional)</Text>
              <PartPhotoPicker
                value={photo?.uri ?? null}
                onChange={(uri) => setPhoto(uri ? { uri } : null)}
                slot={1}
                label="Box / Label"
              />
              <PartPhotoPicker
                value={photo2?.uri ?? null}
                onChange={(uri) => setPhoto2(uri ? { uri } : null)}
                slot={2}
                label="Detail / Wire Frame"
              />

              {/* Duplicate detection prompt */}
              {duplicate ? (
                <View style={[styles.duplicateBanner, { backgroundColor: colors.warning + "15", borderColor: colors.warning + "55" }]}>
                  <Text style={[styles.duplicateTitle, { color: colors.warning }]}>
                    ⚠ Item already exists
                  </Text>
                  <Text style={[styles.duplicateBody, { color: colors.foreground }]}>
                    {duplicate.item.vendor} / {duplicate.item.catalog} is already in inventory.
                    Add bin <Text style={{ fontFamily: "Inter_700Bold" }}>{duplicate.pendingBin}</Text> to it instead?
                  </Text>
                  <View style={styles.duplicateActions}>
                    <Pressable
                      onPress={() => { setDuplicate(null); setError(null); }}
                      style={[styles.dupCancelBtn, { borderColor: colors.border }]}
                    >
                      <Text style={[styles.dupCancelText, { color: colors.foreground }]}>Cancel</Text>
                    </Pressable>
                    <Pressable
                      onPress={handleConfirmDuplicate}
                      disabled={duplicateLoading}
                      style={[styles.dupConfirmBtn, { backgroundColor: colors.primary }]}
                    >
                      {duplicateLoading ? (
                        <ActivityIndicator size="small" color={colors.primaryForeground} />
                      ) : (
                        <Text style={[styles.dupConfirmText, { color: colors.primaryForeground }]}>
                          Add Bin Location
                        </Text>
                      )}
                    </Pressable>
                  </View>
                </View>
              ) : null}

              {error ? (
                <View style={[styles.errorBanner, { backgroundColor: colors.destructive + "14", borderColor: colors.destructive + "55" }]}>
                  <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text>
                </View>
              ) : null}
            </View>
          </ScrollView>

          {/* Footer CTAs */}
          <View style={[styles.footer, { borderTopColor: colors.border }]}>
            <Pressable
              onPress={onClose}
              style={[styles.cancelBtn, { borderColor: colors.border }]}
            >
              <Text style={[styles.cancelBtnText, { color: colors.foreground }]}>Close</Text>
            </Pressable>
            <Pressable
              onPress={() => handleSubmit("next")}
              disabled={submitting || !!duplicate || positionOverLimit}
              style={[
                styles.addNextBtn,
                { borderColor: submitting || !!duplicate || positionOverLimit ? colors.border : colors.primary },
              ]}
            >
              {submitting ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <Text style={[styles.addNextText, { color: submitting || !!duplicate || positionOverLimit ? colors.mutedForeground : colors.primary }]}>
                  Add &amp; Next →
                </Text>
              )}
            </Pressable>
            <Pressable
              onPress={() => handleSubmit("done")}
              disabled={submitting || !!duplicate}
              style={[
                styles.addDoneBtn,
                { backgroundColor: submitting || !!duplicate ? colors.muted : colors.primary },
              ]}
            >
              {submitting ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : (
                <Text style={[styles.addDoneText, { color: submitting || !!duplicate ? colors.mutedForeground : colors.primaryForeground }]}>
                  Add &amp; Done
                </Text>
              )}
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Prefix scanner modal */}
      {Platform.OS !== "web" ? (
        <Modal
          visible={prefixScannerOpen}
          animationType="slide"
          onRequestClose={() => setPrefixScannerOpen(false)}
        >
          <View style={styles.cameraModal}>
            <CameraView
              style={StyleSheet.absoluteFill}
              onBarcodeScanned={handlePrefixScanned}
              barcodeScannerSettings={{
                barcodeTypes: ["ean13", "ean8", "code128", "code39", "upc_a", "upc_e", "qr"],
              }}
            />
            <View style={styles.cameraOverlay}>
              <View style={[styles.cameraHeader, { backgroundColor: "rgba(0,0,0,0.45)" }]}>
                <Pressable onPress={() => setPrefixScannerOpen(false)} style={styles.cameraCloseBtn}>
                  <Feather name="x" size={20} color="#fff" />
                </Pressable>
                <Text style={styles.cameraTitle}>Scan Shelf Label</Text>
                <View style={{ width: 40 }} />
              </View>
              <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                <Text style={{ color: "rgba(255,255,255,0.75)", fontSize: 13, textAlign: "center", paddingHorizontal: 24 }}>
                  Point at the shelf label barcode — first 4 characters become the prefix
                </Text>
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
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  scrollContent: { padding: 16, gap: 16, paddingBottom: 32 },
  section: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
  },
  sectionLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  hint: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
    lineHeight: 17,
    marginBottom: 14,
  },
  miniHint: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
    marginTop: 4,
  },
  fieldLabel: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 6,
  },
  row: { flexDirection: "row", gap: 12 },
  prefixRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  prefixInput: { flex: 1, marginBottom: 0 },
  prefixScanBtn: { width: 44, height: 44, borderRadius: 8, borderWidth: 1, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
  },
  stepRow: { flexDirection: "row", gap: 8, marginBottom: 14 },
  stepBtn: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
  },
  stepBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  previewRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  previewLabel: { fontSize: 12, fontFamily: "Inter_500Medium" },
  previewCode: { fontSize: 18, fontFamily: "Inter_700Bold", letterSpacing: 0.5 },
  warnBanner: {
    borderRadius: 8,
    borderWidth: 1,
    padding: 10,
    marginTop: 10,
  },
  warnText: { fontSize: 12, fontFamily: "Inter_500Medium", lineHeight: 17 },
  positionDisplay: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  positionText: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  duplicateBanner: {
    borderRadius: 8,
    borderWidth: 1,
    padding: 14,
    marginTop: 14,
    gap: 8,
  },
  duplicateTitle: { fontSize: 13, fontFamily: "Inter_700Bold" },
  duplicateBody: { fontSize: 13, fontFamily: "Inter_400Regular", lineHeight: 19 },
  duplicateActions: { flexDirection: "row", gap: 10, marginTop: 4 },
  dupCancelBtn: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
  },
  dupCancelText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  dupConfirmBtn: {
    flex: 2,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
  },
  dupConfirmText: { fontSize: 13, fontFamily: "Inter_700Bold" },
  errorBanner: {
    borderRadius: 8,
    borderWidth: 1,
    padding: 12,
    marginTop: 12,
  },
  errorText: { fontSize: 13, fontFamily: "Inter_500Medium", lineHeight: 18 },
  footer: {
    flexDirection: "row",
    padding: 16,
    borderTopWidth: 1,
    gap: 8,
  },
  cancelBtn: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  addNextBtn: {
    flex: 2,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  addNextText: { fontSize: 14, fontFamily: "Inter_700Bold" },
  addDoneBtn: {
    flex: 2,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  addDoneText: { fontSize: 14, fontFamily: "Inter_700Bold" },
  cameraModal: { flex: 1, backgroundColor: "#000" },
  cameraOverlay: {
    flex: 1,
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
});
