import React, { useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { KeyboardDoneInput } from "@/components/KeyboardDoneInput";
import { Feather } from "@expo/vector-icons";
import type { InventoryItem } from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/contexts/AppContext";
import { MeasurePartScreen } from "@/components/MeasurePartScreen";
import type { PartDimensions } from "@/components/MeasurePartScreen";

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

export interface AddPartFormProps {
  adminToken: string | null;
  onSuccess: (item: InventoryItem) => void;
}

export function AddPartForm({ adminToken, onSuccess }: AddPartFormProps) {
  const colors = useColors();
  const { settings: { dimensionUnit } } = useApp();
  const [catalog, setCatalog] = useState("");
  const [vendor, setVendor] = useState("");
  const [binLocation, setBinLocation] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ catalog?: string; vendor?: string; bin?: string }>({});
  const [createdItem, setCreatedItem] = useState<InventoryItem | null>(null);

  // Dimensions
  const [dimLength, setDimLength] = useState("");
  const [dimWidth, setDimWidth] = useState("");
  const [dimHeight, setDimHeight] = useState("");
  const [dimDiameter, setDimDiameter] = useState("");
  const [measureOpen, setMeasureOpen] = useState(false);

  const reset = () => {
    setCatalog("");
    setVendor("");
    setBinLocation("");
    setError(null);
    setFieldErrors({});
    setCreatedItem(null);
    setDimLength("");
    setDimWidth("");
    setDimHeight("");
    setDimDiameter("");
  };

  const validate = () => {
    const errs: typeof fieldErrors = {};
    if (!catalog.trim()) errs.catalog = "Catalog number is required";
    if (!vendor.trim()) errs.vendor = "Vendor code is required";
    if (!binLocation.trim()) errs.bin = "Bin location is required";
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleMeasureConfirm = (dims: PartDimensions) => {
    setMeasureOpen(false);
    setDimLength(fmtDim(dims.length));
    setDimWidth(fmtDim(dims.width));
    setDimHeight(fmtDim(dims.height));
    setDimDiameter(fmtDim(dims.diameter));
  };

  const handleSubmit = async () => {
    if (loading) return;
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
      const newItem = data.item;

      // If dimensions were entered, persist them in a second call.
      // If the PATCH fails, roll back by deleting the just-created part so we
      // never leave a dimension-less orphan in the database.
      const hasDims = dimLength || dimWidth || dimHeight || dimDiameter;
      if (hasDims) {
        const dimRes = await fetch(`${API_BASE}/inventory/${newItem.id}/dimensions`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            length: parseDimField(dimLength),
            width: parseDimField(dimWidth),
            height: parseDimField(dimHeight),
            diameter: parseDimField(dimDiameter),
          }),
        });
        if (!dimRes.ok) {
          const dimErr = await dimRes.json().catch(() => ({})) as { error?: string };
          // Roll back: delete the created part to avoid leaving an orphan without dimensions.
          try {
            await fetch(`${API_BASE}/inventory/${newItem.id}`, {
              method: "DELETE",
              headers: { Authorization: `Bearer ${adminToken}` },
            });
          } catch {
            // Best-effort cleanup — ignore if it also fails.
          }
          setError(dimErr.error ?? "Could not save dimensions. The part was not created. Please try again.");
          return;
        }
      }

      setCreatedItem(newItem);
      onSuccess(newItem);
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
          <KeyboardDoneInput
            style={[apfStyles.input, { backgroundColor: colors.muted, borderColor: fieldErrors.catalog ? colors.destructive : colors.border, color: colors.foreground }]}
            placeholder="e.g. BR120"
            placeholderTextColor={colors.mutedForeground}
            value={catalog}
            onChangeText={v => { setCatalog(v); if (fieldErrors.catalog) setFieldErrors(p => ({ ...p, catalog: undefined })); }}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="next"
            maxLength={40}
          />
          {fieldErrors.catalog ? (
            <Text style={[apfStyles.fieldError, { color: colors.destructive }]}>{fieldErrors.catalog}</Text>
          ) : null}
        </View>

        <View style={apfStyles.fieldGroup}>
          <Text style={[apfStyles.label, { color: colors.foreground }]}>Vendor Code</Text>
          <KeyboardDoneInput
            style={[apfStyles.input, { backgroundColor: colors.muted, borderColor: fieldErrors.vendor ? colors.destructive : colors.border, color: colors.foreground }]}
            placeholder="e.g. EATON"
            placeholderTextColor={colors.mutedForeground}
            value={vendor}
            onChangeText={v => { setVendor(v); if (fieldErrors.vendor) setFieldErrors(p => ({ ...p, vendor: undefined })); }}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="next"
            maxLength={40}
          />
          {fieldErrors.vendor ? (
            <Text style={[apfStyles.fieldError, { color: colors.destructive }]}>{fieldErrors.vendor}</Text>
          ) : null}
        </View>

        <View style={apfStyles.fieldGroup}>
          <Text style={[apfStyles.label, { color: colors.foreground }]}>Bin Location</Text>
          <KeyboardDoneInput
            style={[apfStyles.input, { backgroundColor: colors.muted, borderColor: fieldErrors.bin ? colors.destructive : colors.border, color: colors.foreground }]}
            placeholder="e.g. 01-05-210"
            placeholderTextColor={colors.mutedForeground}
            value={binLocation}
            onChangeText={v => { setBinLocation(v); if (fieldErrors.bin) setFieldErrors(p => ({ ...p, bin: undefined })); }}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={handleSubmit}
            maxLength={30}
          />
          {fieldErrors.bin ? (
            <Text style={[apfStyles.fieldError, { color: colors.destructive }]}>{fieldErrors.bin}</Text>
          ) : null}
        </View>

        {/* Dimensions (optional) */}
        <View style={apfStyles.fieldGroup}>
          <View style={apfStyles.dimLabelRow}>
            <Text style={[apfStyles.label, { color: colors.foreground }]}>{`Dimensions (${dimensionUnit}) — optional`}</Text>
            {Platform.OS === "ios" ? (
              <Pressable
                onPress={() => setMeasureOpen(true)}
                style={[apfStyles.measureBtn, { backgroundColor: colors.primary + "18", borderColor: colors.primary + "55" }]}
              >
                <Feather name="maximize" size={12} color={colors.primary} />
                <Text style={[apfStyles.measureBtnText, { color: colors.primary }]}>Estimate</Text>
              </Pressable>
            ) : null}
          </View>
          <View style={apfStyles.dimGrid}>
            <View style={apfStyles.dimHalf}>
              <Text style={[apfStyles.dimFieldLabel, { color: colors.mutedForeground }]}>Length</Text>
              <KeyboardDoneInput
                style={[apfStyles.dimInput, { backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground }]}
                placeholder="–"
                placeholderTextColor={colors.mutedForeground}
                value={dimLength}
                onChangeText={v => setDimLength(v.replace(/[^0-9.]/g, ""))}
                keyboardType="numeric"
              />
            </View>
            <View style={apfStyles.dimHalf}>
              <Text style={[apfStyles.dimFieldLabel, { color: colors.mutedForeground }]}>Width</Text>
              <KeyboardDoneInput
                style={[apfStyles.dimInput, { backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground }]}
                placeholder="–"
                placeholderTextColor={colors.mutedForeground}
                value={dimWidth}
                onChangeText={v => setDimWidth(v.replace(/[^0-9.]/g, ""))}
                keyboardType="numeric"
              />
            </View>
            <View style={apfStyles.dimHalf}>
              <Text style={[apfStyles.dimFieldLabel, { color: colors.mutedForeground }]}>Height</Text>
              <KeyboardDoneInput
                style={[apfStyles.dimInput, { backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground }]}
                placeholder="–"
                placeholderTextColor={colors.mutedForeground}
                value={dimHeight}
                onChangeText={v => setDimHeight(v.replace(/[^0-9.]/g, ""))}
                keyboardType="numeric"
              />
            </View>
            <View style={apfStyles.dimHalf}>
              <Text style={[apfStyles.dimFieldLabel, { color: colors.mutedForeground }]}>Diameter</Text>
              <KeyboardDoneInput
                style={[apfStyles.dimInput, { backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground }]}
                placeholder="–"
                placeholderTextColor={colors.mutedForeground}
                value={dimDiameter}
                onChangeText={v => setDimDiameter(v.replace(/[^0-9.]/g, ""))}
                keyboardType="numeric"
              />
            </View>
          </View>
          {(dimLength || dimWidth || dimHeight || dimDiameter) ? (
            <Text style={[apfStyles.dimSummary, { color: colors.primary }]}>
              {[
                dimLength && dimWidth && dimHeight && `${dimLength} × ${dimWidth} × ${dimHeight} ${dimensionUnit}`,
                dimDiameter && `⌀ ${dimDiameter} ${dimensionUnit}`,
              ].filter(Boolean).join("   ")}
            </Text>
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

      {/* Measure modal — iOS only (LiDAR or AI Vision estimate) */}
      {Platform.OS === "ios" ? (
        <MeasurePartScreen
          visible={measureOpen}
          onClose={() => setMeasureOpen(false)}
          onConfirm={handleMeasureConfirm}
          adminToken={adminToken ?? ""}
        />
      ) : null}
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
  // Dimensions
  dimLabelRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  measureBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
  },
  measureBtnText: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  dimGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  dimHalf: { width: "47%" },
  dimFieldLabel: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 3,
  },
  dimInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  dimSummary: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    marginTop: 6,
    textAlign: "center",
    letterSpacing: 0.3,
  },
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
