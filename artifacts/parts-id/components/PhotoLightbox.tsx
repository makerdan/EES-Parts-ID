import React from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  StatusBar,
} from "react-native";
import { RetryImage } from "@/components/RetryImage";

interface PhotoLightboxProps {
  uri: string | null;
  onClose: () => void;
}

export function PhotoLightbox({ uri, onClose }: PhotoLightboxProps) {
  return (
    <Modal
      visible={uri !== null}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <StatusBar backgroundColor="rgba(0,0,0,0.95)" barStyle="light-content" />
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={styles.imageContainer} pointerEvents="none">
          {uri ? (
            <RetryImage
              uri={uri}
              style={styles.image}
              resizeMode="contain"
            />
          ) : null}
        </View>
        <Pressable style={styles.closeBtn} onPress={onClose} accessibilityLabel="Close photo" accessibilityRole="button">
          <Text style={styles.closeBtnText}>✕</Text>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.93)",
    alignItems: "center",
    justifyContent: "center",
  },
  imageContainer: {
    width: "90%",
    aspectRatio: 1,
    maxHeight: "80%",
  },
  image: {
    width: "100%",
    height: "100%",
  },
  closeBtn: {
    position: "absolute",
    top: 52,
    right: 20,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  closeBtnText: {
    color: "#fff",
    fontSize: 16,
    lineHeight: 18,
  },
});
