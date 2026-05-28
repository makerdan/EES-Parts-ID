/**
 * Floor Plan Upload Screen
 *
 * Admin-only screen that lets admins pick an SVG file from device storage,
 * validates it (must be SVG and contain viewBox "0 0 3592.55 2457.41"), then
 * uploads it via POST /api/admin/floor-plan.
 *
 * A success/error toast is shown after the upload attempt.
 *
 * Route: /floor-plan-upload
 */
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/contexts/AppContext";
import { shouldRedirectNonAdmin } from "@/utils/adminGuard";

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : "";

const REQUIRED_VIEWBOX = "0 0 3592.55 2457.41";

type PickedFile = { name: string; uri: string };

function validateSvg(content: string): string | null {
  if (!content.trimStart().startsWith("<") || !content.includes("<svg")) {
    return "File does not appear to be a valid SVG (no <svg> element found).";
  }
  const vbMatch = content.match(/viewBox\s*=\s*["']([^"']+)["']/i);
  if (!vbMatch) {
    return `SVG is missing a viewBox attribute. Expected: viewBox="${REQUIRED_VIEWBOX}".`;
  }
  if (vbMatch[1].trim() !== REQUIRED_VIEWBOX) {
    return `Wrong viewBox — got "${vbMatch[1].trim()}", expected "${REQUIRED_VIEWBOX}".`;
  }
  return null;
}

export default function FloorPlanUploadScreen() {
  const colors = useColors();
  const router = useRouter();
  const { isLoading, adminToken, showToast } = useApp();

  const adminTokenRef = useRef(adminToken);
  useEffect(() => { adminTokenRef.current = adminToken; }, [adminToken]);

  const [pickedFile, setPickedFile] = useState<PickedFile | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    if (shouldRedirectNonAdmin(isLoading, adminToken)) {
      router.replace("/(tabs)");
    }
  }, [isLoading, adminToken, router]);

  const handlePick = async () => {
    setValidationError(null);
    setSuccessMsg(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ["image/svg+xml", "text/xml", "text/plain", "application/xml", "*/*"],
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      if (Platform.OS !== "web") {
        const ext = (asset.name.split(".").pop() ?? "").toLowerCase();
        if (ext !== "svg") {
          setValidationError("Please choose an .svg file.");
          return;
        }
      }
      setPickedFile({ name: asset.name, uri: asset.uri });
    } catch {
      showToast("Could not open file picker.", "error");
    }
  };

  const handleUpload = async () => {
    if (!pickedFile) return;
    setValidationError(null);
    setSuccessMsg(null);
    setUploading(true);
    try {
      const response = await fetch(pickedFile.uri);
      if (!response.ok) throw new Error("Could not read file.");
      const content = await response.text();

      const err = validateSvg(content);
      if (err) {
        setValidationError(err);
        showToast(err, "error");
        setUploading(false);
        return;
      }

      const token = adminTokenRef.current;
      if (!token) {
        showToast("Admin session expired — please log in again.", "error");
        setUploading(false);
        return;
      }

      const res = await fetch(`${API_BASE}/admin/floor-plan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ svg: content }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Upload failed" })) as { error?: string };
        const msg = body.error ?? "Upload failed";
        setValidationError(msg);
        showToast(msg, "error");
      } else {
        const msg = "Floor plan uploaded — the app will use the new plan on next launch.";
        setSuccessMsg(msg);
        showToast(msg, "success");
        setPickedFile(null);
      }
    } catch {
      const msg = "Network error — check your connection and try again.";
      setValidationError(msg);
      showToast(msg, "error");
    } finally {
      setUploading(false);
    }
  };

  if (isLoading) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
        <ActivityIndicator style={{ flex: 1 }} color={colors.primary} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable onPress={() => router.back()} style={styles.backBtn} accessibilityLabel="Go back">
          <Feather name="arrow-left" size={20} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>Floor Plan</Text>
        <View style={{ width: 34 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {/* Info card */}
        <View style={[styles.infoCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.infoTitle, { color: colors.foreground }]}>Upload Warehouse Floor Plan</Text>
          <Text style={[styles.infoBody, { color: colors.mutedForeground }]}>
            Replace the warehouse map with a new SVG file. The app fetches the updated plan on next launch — no app update required.
          </Text>
          <View style={[styles.requirementRow, { backgroundColor: colors.muted, borderColor: colors.border }]}>
            <Feather name="info" size={13} color={colors.mutedForeground} style={{ marginTop: 1 }} />
            <Text style={[styles.requirementText, { color: colors.mutedForeground }]}>
              File must be an SVG with{" "}
              <Text style={{ fontFamily: "Inter_600SemiBold" }}>viewBox="{REQUIRED_VIEWBOX}"</Text>
            </Text>
          </View>
        </View>

        {/* File picker */}
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.cardLabel, { color: colors.foreground }]}>SVG File</Text>

          <Pressable
            onPress={handlePick}
            style={[
              styles.pickBtn,
              {
                borderColor: validationError ? colors.destructive : colors.primary,
                backgroundColor: pickedFile ? colors.primary + "12" : "transparent",
              },
            ]}
          >
            <Feather
              name={pickedFile ? "file-text" : "upload"}
              size={16}
              color={pickedFile ? colors.primary : colors.mutedForeground}
            />
            <Text
              style={[
                styles.pickBtnText,
                { color: pickedFile ? colors.primary : colors.mutedForeground },
              ]}
              numberOfLines={1}
            >
              {pickedFile ? pickedFile.name : "Choose SVG File…"}
            </Text>
            {pickedFile ? (
              <Pressable
                onPress={(e) => { e.stopPropagation(); setPickedFile(null); setValidationError(null); setSuccessMsg(null); }}
                hitSlop={8}
                accessibilityLabel="Clear selected file"
              >
                <Feather name="x" size={14} color={colors.mutedForeground} />
              </Pressable>
            ) : null}
          </Pressable>

          {validationError ? (
            <View style={[styles.errorBanner, { backgroundColor: colors.destructive + "15", borderColor: colors.destructive + "55" }]}>
              <Feather name="alert-triangle" size={13} color={colors.destructive} style={{ marginTop: 1 }} />
              <Text style={[styles.bannerText, { color: colors.destructive }]}>{validationError}</Text>
            </View>
          ) : null}

          {successMsg ? (
            <View style={[styles.successBanner, { backgroundColor: "#10b98115", borderColor: "#10b98155" }]}>
              <Feather name="check-circle" size={13} color="#059669" style={{ marginTop: 1 }} />
              <Text style={[styles.bannerText, { color: "#059669" }]}>{successMsg}</Text>
            </View>
          ) : null}

          <Pressable
            onPress={handleUpload}
            disabled={!pickedFile || uploading}
            style={[
              styles.uploadBtn,
              {
                backgroundColor: !pickedFile || uploading ? colors.muted : colors.primary,
              },
            ]}
          >
            {uploading ? (
              <ActivityIndicator size="small" color={colors.primaryForeground} />
            ) : (
              <>
                <Feather name="upload-cloud" size={16} color={!pickedFile ? colors.mutedForeground : colors.primaryForeground} />
                <Text
                  style={[
                    styles.uploadBtnText,
                    { color: !pickedFile ? colors.mutedForeground : colors.primaryForeground },
                  ]}
                >
                  Upload Floor Plan
                </Text>
              </>
            )}
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  headerTitle: { fontSize: 18, fontFamily: "Inter_700Bold" },
  backBtn: { padding: 7 },
  content: { padding: 16, gap: 14 },
  infoCard: {
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    gap: 10,
  },
  infoTitle: { fontSize: 16, fontFamily: "Inter_700Bold" },
  infoBody: { fontSize: 14, fontFamily: "Inter_400Regular", lineHeight: 20 },
  requirementRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 7,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  requirementText: { fontSize: 12, fontFamily: "Inter_400Regular", flex: 1, lineHeight: 17 },
  card: {
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    gap: 12,
  },
  cardLabel: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  pickBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1.5,
    borderRadius: 8,
    borderStyle: "dashed",
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  pickBtnText: { flex: 1, fontSize: 14, fontFamily: "Inter_500Medium" },
  errorBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 7,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  successBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 7,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  bannerText: { fontSize: 13, fontFamily: "Inter_500Medium", flex: 1, lineHeight: 18 },
  uploadBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 8,
    paddingVertical: 13,
  },
  uploadBtnText: { fontSize: 15, fontFamily: "Inter_700Bold" },
});
