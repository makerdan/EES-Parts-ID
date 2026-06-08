import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { KeyboardDoneInput } from "@/components/KeyboardDoneInput";
import * as Clipboard from "expo-clipboard";
import type { InventoryItem } from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";
import { DismissKeyboard } from "@/components/DismissKeyboard";

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : "http://localhost:8080/api";

export interface AddPartModalProps {
  visible: boolean;
  adminToken: string | null;
  defaultBin?: string;
  onClose: () => void;
  onSuccess: () => void;
  /** Called when the admin taps "Add details" after a successful quick-add. */
  onAddDetails?: (item: InventoryItem) => void;
}

export function AddPartModal({
  visible,
  adminToken,
  defaultBin = "",
  onClose,
  onSuccess,
  onAddDetails,
}: AddPartModalProps) {
  "use no memo";
  const colors = useColors();
  const [catalog, setCatalog] = useState("");
  const [vendor, setVendor] = useState("");
  const [binLocation, setBinLocation] = useState(defaultBin);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ catalog?: string; vendor?: string; bin?: string }>({});
  const [createdItem, setCreatedItem] = useState<InventoryItem | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopyBin = async () => {
    if (!createdItem?.binLocations?.length) return;
    await Clipboard.setStringAsync(createdItem.binLocations[0]);
    setCopied(true);
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
  };

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (visible) {
      setCatalog("");
      setVendor("");
      setBinLocation(defaultBin);
      setError(null);
      setFieldErrors({});
      setCreatedItem(null);
    }
  }, [visible, defaultBin]);

  const validate = () => {
    const errs: typeof fieldErrors = {};
    if (!catalog.trim()) errs.catalog = "Catalog number is required";
    if (!vendor.trim()) errs.vendor = "Vendor code is required";
    if (!binLocation.trim()) errs.bin = "Bin location is required";
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = async () => {
    setError(null);
    if (!validate()) return;
    if (!adminToken) {
      setError("Admin session not found. Please unlock admin access first.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/inventory/add-part`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          vendor: vendor.trim(),
          catalog: catalog.trim(),
          binLocation: binLocation.trim(),
        }),
      });

      if (res.status === 409) {
        const data = await res.json() as { error?: string };
        setError(data.error ?? "A part with this vendor and catalog number already exists.");
        return;
      }
      if (res.status === 401) {
        setError("Admin session expired. Please unlock admin access again.");
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setError(data.error ?? "Failed to add part. Please try again.");
        return;
      }

      const data = await res.json() as { item: InventoryItem };
      onSuccess();
      if (onAddDetails) {
        setCreatedItem(data.item);
      } else {
        onClose();
      }
    } catch {
      setError("Network error. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleDone = () => {
    setCopied(false);
    setCreatedItem(null);
    onClose();
  };

  const handleAddDetails = () => {
    if (createdItem && onAddDetails) {
      onAddDetails(createdItem);
    }
    setCopied(false);
    setCreatedItem(null);
    onClose();
  };

  const handleAddAnother = () => {
    setCopied(false);
    setCatalog("");
    setVendor("");
    setBinLocation(defaultBin);
    setError(null);
    setFieldErrors({});
    setCreatedItem(null);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={createdItem ? handleDone : onClose}
    >
      <KeyboardAvoidingView
        style={{ flex: 1, backgroundColor: colors.overlay }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <DismissKeyboard style={styles.overlayInner}>
        <View style={[styles.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>

          {createdItem ? (
            /* ── Success state ── */
            <>
              <View style={styles.successHeader}>
                <View style={[styles.successIcon, { backgroundColor: colors.success + "22" }]}>
                  <Text style={{ fontSize: 22 }}>✓</Text>
                </View>
                <Text style={[styles.title, { color: colors.foreground }]}>Part Added</Text>
              </View>
              <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
                {createdItem.vendor} / {createdItem.catalog} registered at{" "}
                <Text style={{ fontWeight: "700", color: colors.foreground }}>{binLocation}</Text>
              </Text>
              {createdItem.binLocations?.length ? (
                <Pressable
                  onPress={handleCopyBin}
                  style={({ pressed }) => [
                    styles.binChip,
                    { backgroundColor: colors.muted, borderColor: copied ? colors.success : colors.border, opacity: pressed ? 0.7 : 1 },
                  ]}
                >
                  <Text style={[styles.binChipLabel, { color: colors.mutedForeground }]}>Bin</Text>
                  <Text style={[styles.binChipValue, { color: colors.foreground }]}>{createdItem.binLocations[0]}</Text>
                  <Text style={[styles.binChipHint, { color: copied ? colors.success : colors.mutedForeground }]}>
                    {copied ? "Copied!" : "Tap to copy"}
                  </Text>
                </Pressable>
              ) : null}
              {onAddDetails ? (
                <Text style={[styles.detailsHint, { color: colors.mutedForeground }]}>
                  Would you like to enrich it with a description, additional bins, or keywords?
                </Text>
              ) : null}
              {defaultBin && onAddDetails ? (
                /* Three-action layout: stack primaries below Done */
                <View style={styles.actionsColumn}>
                  <View style={styles.actions}>
                    <Pressable
                      onPress={handleAddAnother}
                      style={[styles.submitBtn, { backgroundColor: colors.primary, borderColor: colors.primary }]}
                    >
                      <Text style={[styles.submitBtnText, { color: colors.primaryForeground }]}>Add Another</Text>
                    </Pressable>
                    <Pressable
                      onPress={handleAddDetails}
                      style={[styles.submitBtn, { backgroundColor: colors.primary, borderColor: colors.primary }]}
                    >
                      <Text style={[styles.submitBtnText, { color: colors.primaryForeground }]}>Add Details</Text>
                    </Pressable>
                  </View>
                  <Pressable
                    onPress={handleDone}
                    style={[styles.cancelBtn, { borderColor: colors.border, backgroundColor: colors.muted }]}
                  >
                    <Text style={[styles.cancelBtnText, { color: colors.foreground }]}>Done</Text>
                  </Pressable>
                </View>
              ) : (
                <View style={styles.actions}>
                  <Pressable
                    onPress={handleDone}
                    style={[styles.cancelBtn, { borderColor: colors.border, backgroundColor: colors.muted }]}
                  >
                    <Text style={[styles.cancelBtnText, { color: colors.foreground }]}>Done</Text>
                  </Pressable>
                  {defaultBin ? (
                    <Pressable
                      onPress={handleAddAnother}
                      style={[styles.submitBtn, { backgroundColor: colors.primary, borderColor: colors.primary }]}
                    >
                      <Text style={[styles.submitBtnText, { color: colors.primaryForeground }]}>Add Another</Text>
                    </Pressable>
                  ) : null}
                  {onAddDetails ? (
                    <Pressable
                      onPress={handleAddDetails}
                      style={[styles.submitBtn, { backgroundColor: colors.primary, borderColor: colors.primary }]}
                    >
                      <Text style={[styles.submitBtnText, { color: colors.primaryForeground }]}>Add Details</Text>
                    </Pressable>
                  ) : null}
                </View>
              )}
            </>
          ) : (
            /* ── Entry form ── */
            <>
              <Text style={[styles.title, { color: colors.foreground }]}>Add Part</Text>
              <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
                Register a new part in the inventory
              </Text>

              <View style={styles.fields}>
                <View style={styles.fieldGroup}>
                  <Text style={[styles.label, { color: colors.foreground }]}>Catalog Number</Text>
                  <KeyboardDoneInput
                    style={[
                      styles.input,
                      { backgroundColor: colors.muted, borderColor: fieldErrors.catalog ? colors.destructive : colors.border, color: colors.foreground },
                    ]}
                    placeholder="e.g. BR120"
                    placeholderTextColor={colors.mutedForeground}
                    value={catalog}
                    onChangeText={v => { setCatalog(v); if (fieldErrors.catalog) setFieldErrors(p => ({ ...p, catalog: undefined })); }}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    returnKeyType="next"
                  />
                  {fieldErrors.catalog ? (
                    <Text style={[styles.fieldError, { color: colors.destructive }]}>{fieldErrors.catalog}</Text>
                  ) : null}
                </View>

                <View style={styles.fieldGroup}>
                  <Text style={[styles.label, { color: colors.foreground }]}>Vendor Code</Text>
                  <KeyboardDoneInput
                    style={[
                      styles.input,
                      { backgroundColor: colors.muted, borderColor: fieldErrors.vendor ? colors.destructive : colors.border, color: colors.foreground },
                    ]}
                    placeholder="e.g. EATON"
                    placeholderTextColor={colors.mutedForeground}
                    value={vendor}
                    onChangeText={v => { setVendor(v); if (fieldErrors.vendor) setFieldErrors(p => ({ ...p, vendor: undefined })); }}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    returnKeyType="next"
                  />
                  {fieldErrors.vendor ? (
                    <Text style={[styles.fieldError, { color: colors.destructive }]}>{fieldErrors.vendor}</Text>
                  ) : null}
                </View>

                <View style={styles.fieldGroup}>
                  <Text style={[styles.label, { color: colors.foreground }]}>Bin Location</Text>
                  <KeyboardDoneInput
                    style={[
                      styles.input,
                      { backgroundColor: colors.muted, borderColor: fieldErrors.bin ? colors.destructive : colors.border, color: colors.foreground },
                    ]}
                    placeholder="e.g. 01-05-210"
                    placeholderTextColor={colors.mutedForeground}
                    value={binLocation}
                    onChangeText={v => { setBinLocation(v); if (fieldErrors.bin) setFieldErrors(p => ({ ...p, bin: undefined })); }}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="done"
                    onSubmitEditing={handleSubmit}
                  />
                  {fieldErrors.bin ? (
                    <Text style={[styles.fieldError, { color: colors.destructive }]}>{fieldErrors.bin}</Text>
                  ) : null}
                </View>
              </View>

              {error ? (
                <View style={[styles.errorBanner, { backgroundColor: colors.destructive + "14", borderColor: colors.destructive + "55" }]}>
                  <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text>
                </View>
              ) : null}

              <View style={styles.actions}>
                <Pressable
                  onPress={onClose}
                  disabled={loading}
                  style={[styles.cancelBtn, { borderColor: colors.border, backgroundColor: colors.muted }]}
                >
                  <Text style={[styles.cancelBtnText, { color: colors.foreground }]}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={handleSubmit}
                  disabled={loading}
                  style={[styles.submitBtn, { backgroundColor: loading ? colors.muted : colors.primary, borderColor: loading ? colors.border : colors.primary }]}
                >
                  {loading ? (
                    <ActivityIndicator color={colors.primaryForeground} size="small" />
                  ) : (
                    <Text style={[styles.submitBtnText, { color: colors.primaryForeground }]}>Add Part</Text>
                  )}
                </Pressable>
              </View>
            </>
          )}
        </View>
        </DismissKeyboard>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlayInner: {
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  sheet: {
    width: "100%",
    maxWidth: 420,
    borderRadius: 16,
    borderWidth: 1,
    padding: 24,
    gap: 16,
  },
  successHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  successIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
  },
  subtitle: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    marginTop: -8,
  },
  detailsHint: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
    marginTop: -4,
  },
  fields: {
    gap: 14,
  },
  fieldGroup: {
    gap: 4,
  },
  label: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
  },
  fieldError: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  errorBanner: {
    borderRadius: 8,
    borderWidth: 1,
    padding: 12,
  },
  errorText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    lineHeight: 18,
  },
  actions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  actionsColumn: {
    gap: 8,
    marginTop: 4,
  },
  binChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  binChipLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  binChipValue: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  binChipHint: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
  },
  cancelBtn: {
    flex: 1,
    borderRadius: 8,
    borderWidth: 1,
    paddingVertical: 12,
    alignItems: "center",
  },
  cancelBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  submitBtn: {
    flex: 2,
    borderRadius: 8,
    borderWidth: 1,
    paddingVertical: 12,
    alignItems: "center",
  },
  submitBtnText: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
  },
});
