import type { InventoryItem } from "@workspace/api-client-react";
import React, { useState } from "react";
import {
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
  const fs = (base: number) => Math.round(base * fontScale);

  const sorted = [...variants].sort((a, b) =>
    b.catalog.localeCompare(a.catalog, undefined, { numeric: true, sensitivity: "base" }),
  );

  return (
    <View style={dropStyles.container}>
      <Pressable
        onPress={(e) => {
          e?.stopPropagation?.();
          setOpen((prev) => !prev);
        }}
        style={[dropStyles.trigger, { backgroundColor: colors.muted, borderColor: colors.border }]}
        accessibilityRole="button"
        accessibilityLabel={`Other sizes, ${variants.length} available`}
      >
        <Text style={[dropStyles.triggerText, { color: colors.primary, fontSize: fs(12) }]}>
          {`Other Sizes ${open ? "▴" : "▾"} (${variants.length})`}
        </Text>
      </Pressable>

      {open ? (
        <View style={[dropStyles.panel, { backgroundColor: colors.card, borderColor: colors.border }]}>
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
        </View>
      ) : null}
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
    marginTop: 4,
    borderRadius: 8,
    borderWidth: 1,
    overflow: "hidden",
    maxHeight: 220,
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
