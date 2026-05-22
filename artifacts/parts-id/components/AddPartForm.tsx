import React, { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { InventoryItem } from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : "http://localhost:8080/api";

export interface AddPartFormProps {
  adminToken: string | null;
  onSuccess: (item: InventoryItem) => void;
}

export function AddPartForm({ adminToken, onSuccess }: AddPartFormProps) {
  const colors = useColors();
  const [catalog, setCatalog] = useState("");
  const [vendor, setVendor] = useState("");
  const [binLocation, setBinLocation] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ catalog?: string; vendor?: string; bin?: string }>({});
  const [createdItem, setCreatedItem] = useState<InventoryItem | null>(null);

  const reset = () => {
    setCatalog("");
    setVendor("");
    setBinLocation("");
    setError(null);
    setFieldErrors({});
    setCreatedItem(null);
  };

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
      setCreatedItem(data.item);
      onSuccess(data.item);
    } catch {
      setError("Network error. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  if (createdItem) {
    return (
      <View style={[apfStyles.successCard, { backgroundColor: colors.success + "15", borderColor: colors.success + "44" }]}>
        <View style={apfStyles.successHeader}>
          <View style={[apfStyles.successIcon, { backgroundColor: colors.success + "22" }]}>
            <Text style={{ fontSize: 18 }}>✓</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[apfStyles.successTitle, { color: colors.success }]}>Part Added</Text>
            <Text style={[apfStyles.successSub, { color: colors.foreground }]}>
              {createdItem.vendor} / {createdItem.catalog}
            </Text>
          </View>
          <Pressable
            onPress={reset}
            style={[apfStyles.addAnotherBtn, { borderColor: colors.success + "66", backgroundColor: colors.success + "22" }]}
          >
            <Text style={[apfStyles.addAnotherText, { color: colors.success }]}>+ Add Another</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={[apfStyles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[apfStyles.cardTitle, { color: colors.foreground }]}>Manual Add</Text>
      <Text style={[apfStyles.cardSub, { color: colors.mutedForeground }]}>Register a new part in the inventory</Text>

      <View style={apfStyles.fields}>
        <View style={apfStyles.fieldGroup}>
          <Text style={[apfStyles.label, { color: colors.foreground }]}>Catalog Number</Text>
          <TextInput
            style={[apfStyles.input, { backgroundColor: colors.muted, borderColor: fieldErrors.catalog ? colors.destructive : colors.border, color: colors.foreground }]}
            placeholder="e.g. BR120"
            placeholderTextColor={colors.mutedForeground}
            value={catalog}
            onChangeText={v => { setCatalog(v); if (fieldErrors.catalog) setFieldErrors(p => ({ ...p, catalog: undefined })); }}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="next"
          />
          {fieldErrors.catalog ? (
            <Text style={[apfStyles.fieldError, { color: colors.destructive }]}>{fieldErrors.catalog}</Text>
          ) : null}
        </View>

        <View style={apfStyles.fieldGroup}>
          <Text style={[apfStyles.label, { color: colors.foreground }]}>Vendor Code</Text>
          <TextInput
            style={[apfStyles.input, { backgroundColor: colors.muted, borderColor: fieldErrors.vendor ? colors.destructive : colors.border, color: colors.foreground }]}
            placeholder="e.g. EATON"
            placeholderTextColor={colors.mutedForeground}
            value={vendor}
            onChangeText={v => { setVendor(v); if (fieldErrors.vendor) setFieldErrors(p => ({ ...p, vendor: undefined })); }}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="next"
          />
          {fieldErrors.vendor ? (
            <Text style={[apfStyles.fieldError, { color: colors.destructive }]}>{fieldErrors.vendor}</Text>
          ) : null}
        </View>

        <View style={apfStyles.fieldGroup}>
          <Text style={[apfStyles.label, { color: colors.foreground }]}>Bin Location</Text>
          <TextInput
            style={[apfStyles.input, { backgroundColor: colors.muted, borderColor: fieldErrors.bin ? colors.destructive : colors.border, color: colors.foreground }]}
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
            <Text style={[apfStyles.fieldError, { color: colors.destructive }]}>{fieldErrors.bin}</Text>
          ) : null}
        </View>
      </View>

      {error ? (
        <View style={[apfStyles.errorBanner, { backgroundColor: colors.destructive + "14", borderColor: colors.destructive + "55" }]}>
          <Text style={[apfStyles.errorText, { color: colors.destructive }]}>{error}</Text>
        </View>
      ) : null}

      <Pressable
        onPress={handleSubmit}
        disabled={loading}
        style={[apfStyles.submitBtn, { backgroundColor: loading ? colors.muted : colors.primary, borderColor: loading ? colors.border : colors.primary }]}
      >
        {loading ? (
          <ActivityIndicator color={colors.primaryForeground} size="small" />
        ) : (
          <Text style={[apfStyles.submitBtnText, { color: colors.primaryForeground }]}>Add Part</Text>
        )}
      </Pressable>
    </View>
  );
}

const apfStyles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    gap: 14,
  },
  cardTitle: { fontSize: 15, fontFamily: "Inter_700Bold" },
  cardSub: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: -8 },
  fields: { gap: 12 },
  fieldGroup: { gap: 4 },
  label: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
  },
  fieldError: { fontSize: 12, fontFamily: "Inter_500Medium" },
  errorBanner: {
    borderRadius: 8,
    borderWidth: 1,
    padding: 12,
  },
  errorText: { fontSize: 13, fontFamily: "Inter_500Medium", lineHeight: 18 },
  submitBtn: {
    borderRadius: 8,
    borderWidth: 1,
    paddingVertical: 13,
    alignItems: "center",
  },
  submitBtnText: { fontSize: 15, fontFamily: "Inter_700Bold" },
  successCard: {
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
  },
  successHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  successIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  successTitle: { fontSize: 13, fontFamily: "Inter_700Bold" },
  successSub: { fontSize: 13, fontFamily: "Inter_600SemiBold", marginTop: 1 },
  addAnotherBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  addAnotherText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
});
