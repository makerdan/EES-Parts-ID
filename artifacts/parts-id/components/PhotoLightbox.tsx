import React, { useState, useEffect } from "react";
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
  uris: string[];
  initialIndex?: number;
  onClose: () => void;
}

export function PhotoLightbox({ uris, initialIndex = 0, onClose }: PhotoLightboxProps) {
  const [index, setIndex] = useState(initialIndex);

  useEffect(() => {
    setIndex(Math.min(Math.max(0, initialIndex), Math.max(0, uris.length - 1)));
  }, [initialIndex, uris]);

  const visible = uris.length > 0;
  const current = uris[index] ?? null;
  const hasPrev = index > 0;
  const hasNext = index < uris.length - 1;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <StatusBar backgroundColor="rgba(0,0,0,0.95)" barStyle="light-content" />
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={styles.imageContainer} pointerEvents="none">
          {current ? (
            <RetryImage
              uri={current}
              style={styles.image}
              resizeMode="contain"
            />
          ) : null}
        </View>

        {uris.length > 1 ? (
          <View style={styles.dotsRow} pointerEvents="none">
            {uris.map((_, i) => (
              <View
                key={i}
                style={[styles.dot, i === index ? styles.dotActive : styles.dotInactive]}
              />
            ))}
          </View>
        ) : null}

        {hasPrev ? (
          <Pressable
            style={[styles.navBtn, styles.navLeft]}
            onPress={(e) => { e.stopPropagation?.(); setIndex(index - 1); }}
            accessibilityLabel="Previous photo"
            accessibilityRole="button"
          >
            <Text style={styles.navBtnText}>‹</Text>
          </Pressable>
        ) : null}

        {hasNext ? (
          <Pressable
            style={[styles.navBtn, styles.navRight]}
            onPress={(e) => { e.stopPropagation?.(); setIndex(index + 1); }}
            accessibilityLabel="Next photo"
            accessibilityRole="button"
          >
            <Text style={styles.navBtnText}>›</Text>
          </Pressable>
        ) : null}

        {uris.length > 1 ? (
          <View style={styles.slotLabel} pointerEvents="none">
            <Text style={styles.slotLabelText}>
              {index === 0 ? "Box / Label" : "Detail / Wire Frame"}
            </Text>
          </View>
        ) : null}

        <Pressable
          style={styles.closeBtn}
          onPress={onClose}
          accessibilityLabel="Close photo"
          accessibilityRole="button"
        >
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
  dotsRow: {
    flexDirection: "row",
    gap: 6,
    marginTop: 14,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  dotActive: { backgroundColor: "#fff" },
  dotInactive: { backgroundColor: "rgba(255,255,255,0.35)" },
  slotLabel: {
    marginTop: 6,
  },
  slotLabelText: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  navBtn: {
    position: "absolute",
    top: "40%",
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  navLeft: { left: 12 },
  navRight: { right: 12 },
  navBtnText: {
    color: "#fff",
    fontSize: 28,
    lineHeight: 32,
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
