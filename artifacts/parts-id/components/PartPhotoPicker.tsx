import { Feather } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import React, { useCallback } from "react";
import {
  Alert,
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useColors } from "@/hooks/useColors";

export interface PartPhotoPickerProps {
  value: string | null;
  onChange: (uri: string | null) => void;
  slot?: 1 | 2;
  label?: string;
  isAiSourced?: boolean;
  onPressPhoto?: () => void;
}

export function PartPhotoPicker({ value, onChange, label, isAiSourced, onPressPhoto }: PartPhotoPickerProps) {
  const colors = useColors();

  const openCamera = useCallback(async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== "granted") {
      Alert.alert(
        "Camera access needed",
        "Please allow camera access in your device settings to take a photo.",
        [{ text: "OK" }]
      );
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: "images",
      quality: 0.6,
      allowsEditing: false,
    });
    if (!result.canceled && result.assets.length > 0) {
      onChange(result.assets[0].uri);
    }
  }, [onChange]);

  const openLibrary = useCallback(async () => {
    if (Platform.OS !== "web") {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== "granted") {
        Alert.alert(
          "Photo library access needed",
          "Please allow photo library access in your device settings to upload a photo.",
          [{ text: "OK" }]
        );
        return;
      }
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: "images",
      quality: 0.6,
      allowsEditing: false,
    });
    if (!result.canceled && result.assets.length > 0) {
      onChange(result.assets[0].uri);
    }
  }, [onChange]);

  const thumbnail = value ? (
    <View style={ppStyles.thumbnailOuter}>
      <View style={ppStyles.thumbnailWrapper}>
        <Pressable
          onPress={onPressPhoto}
          disabled={!onPressPhoto}
          accessibilityLabel="View full photo"
          accessibilityRole={onPressPhoto ? "button" : undefined}
        >
          <Image source={{ uri: value }} style={ppStyles.thumbnail} />
        </Pressable>
        <Pressable
          onPress={() => onChange(null)}
          style={[ppStyles.removeBtn, { backgroundColor: colors.destructive }]}
          accessibilityLabel="Remove photo"
        >
          <Text style={{ color: "#fff", fontSize: 11 }}>✕</Text>
        </Pressable>
      </View>
      {isAiSourced ? (
        <View style={[ppStyles.aiBadge, { backgroundColor: colors.primary + "1A", borderColor: colors.primary + "55" }]}>
          <Text style={[ppStyles.aiBadgeText, { color: colors.primary }]}>AI sourced</Text>
        </View>
      ) : null}
    </View>
  ) : (
    <View style={[ppStyles.placeholder, { backgroundColor: colors.muted, borderColor: colors.border }]}>
      <Feather name="image" size={22} color={colors.mutedForeground} />
      <Text style={[ppStyles.placeholderText, { color: colors.mutedForeground }]}>No photo</Text>
    </View>
  );

  return (
    <View style={ppStyles.container}>
      {label ? (
        <Text style={[ppStyles.slotLabel, { color: colors.mutedForeground }]}>{label}</Text>
      ) : null}
      {Platform.OS === "web" ? (
        <View style={ppStyles.row}>
          {thumbnail}
          <Pressable
            onPress={openLibrary}
            style={[ppStyles.actionBtn, { borderColor: colors.border, backgroundColor: colors.muted }]}
            accessibilityLabel={value ? "Replace photo" : "Upload photo"}
          >
            <Feather name="upload" size={16} color={colors.foreground} />
            <Text style={[ppStyles.actionBtnText, { color: colors.foreground }]}>
              {value ? "Replace" : "Upload Photo"}
            </Text>
          </Pressable>
        </View>
      ) : (
        <View style={ppStyles.row}>
          {thumbnail}
          <Pressable
            onPress={openCamera}
            style={[ppStyles.actionBtn, { borderColor: colors.border, backgroundColor: colors.muted }]}
            accessibilityLabel={value ? "Retake photo" : "Take photo"}
          >
            <Feather name="camera" size={16} color={colors.foreground} />
            <Text style={[ppStyles.actionBtnText, { color: colors.foreground }]}>
              {value ? "Retake" : "Take Photo"}
            </Text>
          </Pressable>
          <Pressable
            onPress={openLibrary}
            style={[ppStyles.actionBtn, { borderColor: colors.border, backgroundColor: colors.muted }]}
            accessibilityLabel="Upload from library"
          >
            <Feather name="upload" size={16} color={colors.foreground} />
            <Text style={[ppStyles.actionBtnText, { color: colors.foreground }]}>Upload</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const ppStyles = StyleSheet.create({
  container: {
    gap: 6,
  },
  slotLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 2,
  },
  thumbnailOuter: {
    alignItems: "center",
    gap: 4,
  },
  thumbnailWrapper: { position: "relative" },
  thumbnail: { width: 64, height: 64, borderRadius: 8 },
  aiBadge: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  aiBadgeText: {
    fontSize: 9,
    fontFamily: "Inter_600SemiBold",
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  removeBtn: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  actionBtnText: { fontSize: 14, fontFamily: "Inter_500Medium" },
  placeholder: {
    width: 64,
    height: 64,
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
  },
  placeholderText: { fontSize: 9, fontFamily: "Inter_400Regular" },
});
