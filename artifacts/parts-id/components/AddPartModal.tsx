import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useColors } from "@/hooks/useColors";

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : "http://localhost:8080/api";

export interface AddPartModalProps {
  visible: boolean;
  adminToken: string | null;
  defaultBin?: string;
  onClose: () => void;
  onSuccess: () => void;
}

export function AddPartModal({
  visible,
  adminToken,
  defaultBin = "",
  onClose,
  onSuccess,
}: AddPartModalProps) {
  const colors = useColors();
  const [catalog, setCatalog] = useState("");
  const [vendor, setVendor] = useState("");
  const [binLocation, setBinLocation] = useState(defaultBin);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ catalog?: string; vendor?: string; bin?: string }>({});

  useEffect(() => {
    if (visible) {
      setCatalog("");
      setVendor("");
      setBinLocation(defaultBin);
      setError(null);
      setFieldErrors({});
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

      onSuccess();
      onClose();
    } catch {
      setError("Network error. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <View style={[styles.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.title, { color: colors.foreground }]}>Add Part</Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
            Register a new part in the inventory
          </Text>

          <View style={styles.fields}>
            <View style={styles.fieldGroup}>
              <Text style={[styles.label, { color: colors.foreground }]}>Catalog Number</Text>
              <TextInput
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
              <TextInput
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
              <TextInput
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
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "#00000066",
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
  title: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
  },
  subtitle: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    marginTop: -8,
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
