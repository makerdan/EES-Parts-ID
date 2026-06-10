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
import { Feather } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useColors } from "@/hooks/useColors";

export interface PartPhotoPickerProps {
  value: string | null;
  onChange: (uri: string | null) => void;
}

export function PartPhotoPicker({ value, onChange }: PartPhotoPickerProps) {
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

  if (Platform.OS === "web") {
    return (
      <Text style={[ppStyles.webHint, { color: colors.mutedForeground }]}>
        Photo capture is only available on device.
      </Text>
    );
  }

  return (
    <View style={ppStyles.row}>
      {value ? (
        <View style={ppStyles.thumbnailWrapper}>
          <Image source={{ uri: value }} style={ppStyles.thumbnail} />
          <Pressable
            onPress={() => onChange(null)}
            style={[ppStyles.removeBtn, { backgroundColor: colors.destructive }]}
            accessibilityLabel="Remove photo"
          >
            <Text style={{ color: "#fff", fontSize: 11 }}>✕</Text>
          </Pressable>
        </View>
      ) : null}
      <Pressable
        onPress={openCamera}
        style={[ppStyles.cameraBtn, { borderColor: colors.border, backgroundColor: colors.muted }]}
        accessibilityLabel={value ? "Retake photo" : "Take photo"}
      >
        <Feather name="camera" size={18} color={colors.foreground} />
        <Text style={[ppStyles.cameraBtnText, { color: colors.foreground }]}>
          {value ? "Retake" : "Take Photo"}
        </Text>
      </Pressable>
    </View>
  );
}

const ppStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 2,
  },
  thumbnailWrapper: { position: "relative" },
  thumbnail: { width: 64, height: 64, borderRadius: 8 },
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
  cameraBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  cameraBtnText: { fontSize: 14, fontFamily: "Inter_500Medium" },
  webHint: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
    marginTop: 4,
  },
});
