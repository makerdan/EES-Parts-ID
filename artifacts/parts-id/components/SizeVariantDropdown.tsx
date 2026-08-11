import type { InventoryItem } from "@workspace/api-client-react";
import React, { useEffect, useRef, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import type { useColors } from "@/hooks/useColors";

export function getSizeLabel(
  size: string | null | undefined,
  description: string | null | undefined,
): string {
  if (size && size.trim()) return size.trim();
  const desc = (description ?? "").trim();
  if (!desc) return "—";
  return desc.length > 20 ? desc.slice(0, 20).trim() + "…" : desc;
}

interface SizeVariantDropdownProps {
  variants: Array<InventoryItem>;
  onSelect: (item: InventoryItem) => void;
  colors: ReturnType<typeof useColors>;
  fontScale?: number;
}

export function SizeVariantDropdown({
  variants,
  onSelect,
  colors,
  fontScale = 1.0,
}: SizeVariantDropdownProps) {
  const [open, setOpen] = useState(false);
  const [panelPos, setPanelPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<View>(null);
  const fs = (base: number) => Math.round(base * fontScale);

  // F-060: Escape key dismissal on web — must be declared before any early return
  // so hooks are always called in the same order on every render.
  useEffect(() => {
    if (!open || Platform.OS !== "web") return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // Access window safely in web environments
    (globalThis as unknown as { window?: Window }).window?.addEventListener("keydown", handler);
    return () => {
      (globalThis as unknown as { window?: Window }).window?.removeEventListener("keydown", handler);
    };
  }, [open]);

  // F-065: hide trigger entirely when there are no variants (after all hooks)
  if (variants.length === 0) return null;

  const sorted = [...variants].sort((a, b) =>
    b.catalog.localeCompare(a.catalog, undefined, { numeric: true, sensitivity: "base" }),
  );

  const handleOpen = (e: { stopPropagation?: () => void }) => {
    e?.stopPropagation?.();
    if (open) {
      setOpen(false);
      return;
    }
    // Measure trigger position so the Modal panel can be anchored below it.
    // Falls back to a safe default if measurement is unavailable (e.g. on web).
    if (triggerRef.current && typeof triggerRef.current.measure === "function") {
      triggerRef.current.measure((
        _x: number,
        _y: number,
        width: number,
        height: number,
        pageX: number,
        pageY: number,
      ) => {
        setPanelPos({ top: pageY + height + 4, left: pageX, width: Math.max(width, 220) });
        setOpen(true);
      });
    } else {
      setPanelPos(null); // web fallback — centered in modal
      setOpen(true);
    }
  };

  const panelStyle = panelPos
    ? [dropStyles.panel, { backgroundColor: colors.card, borderColor: colors.border, position: "absolute" as const, top: panelPos.top, left: panelPos.left, width: panelPos.width }]
    : [dropStyles.panel, { backgroundColor: colors.card, borderColor: colors.border, alignSelf: "center" as const, width: 300 }];

  return (
    <View style={dropStyles.container}>
      {/* Trigger button */}
      <View ref={triggerRef} collapsable={false}>
        <Pressable
          onPress={handleOpen}
          style={[dropStyles.trigger, { backgroundColor: colors.muted, borderColor: colors.border }]}
          accessibilityRole="button"
          accessibilityLabel={`Other sizes, ${variants.length} available`}
        >
          <Text style={[dropStyles.triggerText, { color: colors.primary, fontSize: fs(12) }]}>
            {`Other Sizes ${open ? "▴" : "▾"} (${variants.length})`}
          </Text>
        </Pressable>
      </View>

      {/* F-060: full-screen transparent backdrop via Modal — closes on outside tap,
          handles Android hardware Back via onRequestClose, and Escape on web via useEffect. */}
      <Modal
        visible={open}
        transparent
        animationType="none"
        onRequestClose={() => setOpen(false)}
        statusBarTranslucent
      >
        {/* Backdrop — tapping anywhere outside the panel closes it */}
        <Pressable
          style={StyleSheet.absoluteFillObject}
          onPress={() => setOpen(false)}
          accessibilityLabel="Close size picker"
        >
          {/* Panel — stop propagation so tapping inside doesn't close the dropdown */}
          <Pressable onPress={(e) => e.stopPropagation?.()} style={panelStyle}>
            <ScrollView
              scrollEnabled
              nestedScrollEnabled
              style={dropStyles.scroll}
              keyboardShouldPersistTaps="handled"
            >
              {sorted.map((v) => {
                const sizeLabel = getSizeLabel(
                  (v as unknown as { size?: string | null }).size,
                  v.description,
                );
                const primaryBin = v.binLocations && v.binLocations.length > 0
                  ? v.binLocations[0]
                  : "—";
                return (
                  <Pressable
                    key={v.id}
                    onPress={(e) => {
                      e?.stopPropagation?.();
                      onSelect(v);
                      setOpen(false);
                    }}
                    style={({ pressed }) => [
                      dropStyles.row,
                      { borderBottomColor: colors.border },
                      pressed ? { backgroundColor: colors.muted } : null,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={`Select ${v.catalog}, size ${sizeLabel}, bin ${primaryBin}`}
                  >
                    <Text style={[dropStyles.rowCatalog, { color: colors.primary, fontSize: fs(12) }]} numberOfLines={1}>
                      {v.catalog}
                    </Text>
                    <Text style={[dropStyles.rowSeparator, { color: colors.mutedForeground }]}>·</Text>
                    <Text style={[dropStyles.rowSize, { color: colors.foreground, fontSize: fs(12) }]} numberOfLines={1}>
                      {sizeLabel}
                    </Text>
                    <Text style={[dropStyles.rowSeparator, { color: colors.mutedForeground }]}>·</Text>
                    <Text style={[dropStyles.rowBin, { color: colors.mutedForeground, fontSize: fs(11) }]} numberOfLines={1}>
                      {primaryBin}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const dropStyles = StyleSheet.create({
  container: {
    marginTop: 6,
    marginBottom: 2,
  },
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
  },
  triggerText: {
    fontFamily: "Inter_600SemiBold",
  },
  panel: {
    borderRadius: 8,
    borderWidth: 1,
    overflow: "hidden",
    maxHeight: 220,
    // Shadow so the panel lifts above surrounding content
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 8,
  },
  scroll: {
    flexGrow: 0,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 6,
  },
  rowCatalog: {
    fontFamily: "Inter_600SemiBold",
    flex: 2,
  },
  rowSeparator: {
    fontFamily: "Inter_400Regular",
  },
  rowSize: {
    fontFamily: "Inter_500Medium",
    flex: 3,
  },
  rowBin: {
    fontFamily: "Inter_400Regular",
    flex: 2,
    textAlign: "right",
  },
});
