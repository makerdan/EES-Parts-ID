import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Image,
  Modal,
  PanResponder,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";

interface PhotoLightboxProps {
  uris: Array<string>;
  initialIndex?: number;
  onClose: () => void;
}

export function PhotoLightbox({ uris, initialIndex = 0, onClose }: PhotoLightboxProps) {
  const [index, setIndex] = useState(initialIndex);
  const [brokenSet, setBrokenSet] = useState<ReadonlySet<number>>(() => new Set());

  useEffect(() => {
    setIndex(Math.min(Math.max(0, initialIndex), Math.max(0, uris.length - 1)));
    setBrokenSet(new Set());
  }, [initialIndex, uris]);

  const markBroken = useCallback((idx: number) => {
    setBrokenSet(prev => new Set([...prev, idx]));
  }, []);

  const visible = uris.length > 0;
  const current = uris[index] ?? null;
  const hasPrev = index > 0;
  const hasNext = index < uris.length - 1;

  // Use refs so the PanResponder closure doesn't go stale when index changes.
  const indexRef = useRef(index);
  useEffect(() => { indexRef.current = index; }, [index]);
  const urisLenRef = useRef(uris.length);
  useEffect(() => { urisLenRef.current = uris.length; }, [uris.length]);

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => urisLenRef.current > 1,
    onMoveShouldSetPanResponder: (_e, gs) =>
      Math.abs(gs.dx) > Math.abs(gs.dy) && Math.abs(gs.dx) > 8,
    onPanResponderRelease: (_e, gs) => {
      if (gs.dx < -50 && indexRef.current < urisLenRef.current - 1) {
        setIndex(i => i + 1);
      } else if (gs.dx > 50 && indexRef.current > 0) {
        setIndex(i => i - 1);
      }
    },
  }), []);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <StatusBar backgroundColor="rgba(0,0,0,0.95)" barStyle="light-content" />
      <Pressable style={styles.backdrop} onPress={onClose} {...panResponder.panHandlers}>
        <View style={styles.imageContainer} pointerEvents="none">
          {current ? (
            brokenSet.has(index) ? (
              <View style={styles.unavailable}>
                <Text style={styles.unavailableText}>Photo unavailable</Text>
              </View>
            ) : (
              <Image
                source={{ uri: current }}
                style={styles.image}
                resizeMode="contain"
                onError={() => markBroken(index)}
              />
            )
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
  unavailable: {
    width: "100%",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: 8,
  },
  unavailableText: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 14,
    fontFamily: "Inter_500Medium",
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
