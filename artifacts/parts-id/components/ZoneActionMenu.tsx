/**
 * ZoneActionMenu — compact action panel that appears when a zone is selected
 * on the Warehouse Map. Shows the zone label and a "GoTo Section" CTA.
 *
 * Rendered as an absolute-positioned overlay anchored to the bottom of the
 * map area. The parent is responsible for providing a transparent dismiss
 * overlay behind this component.
 */
import { Feather } from "@expo/vector-icons";
import React from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useColors } from "@/hooks/useColors";
import type { ApiWarehouseZone } from "@/hooks/useWarehouseZones";

interface ZoneActionMenuProps {
  zone: ApiWarehouseZone;
  onGoToSection: () => void;
  onDismiss: () => void;
}

export function ZoneActionMenu({ zone, onGoToSection, onDismiss }: ZoneActionMenuProps) {
  const colors = useColors();

  return (
    <View
      style={[
        menuStyles.container,
        { backgroundColor: colors.card, borderTopColor: colors.border },
      ]}
    >
      <View style={[menuStyles.handle, { backgroundColor: colors.border }]} />

      <View style={menuStyles.header}>
        <View>
          <Text style={[menuStyles.zoneLabel, { color: colors.foreground }]}>
            Aisle {zone.aisleId}
          </Text>
          {zone.sectionNum !== null && zone.sectionNum > 0 && (
            <Text style={[menuStyles.parityHint, { color: colors.mutedForeground }]}>
              Section {zone.sectionNum}
            </Text>
          )}
        </View>
        <Pressable
          onPress={onDismiss}
          hitSlop={10}
          style={[menuStyles.dismissBtn, { borderColor: colors.border }]}
          accessibilityLabel="Dismiss zone menu"
          accessibilityRole="button"
        >
          <Feather name="x" size={14} color={colors.mutedForeground} />
        </Pressable>
      </View>

      <Pressable
        onPress={onGoToSection}
        style={({ pressed }) => [
          menuStyles.actionRow,
          {
            backgroundColor: pressed ? colors.primary + "18" : colors.primary + "0d",
            borderColor: colors.primary + "44",
          },
        ]}
        accessibilityLabel={`Go to sections list for aisle ${zone.aisleId}`}
        accessibilityRole="button"
      >
        <View style={[menuStyles.iconWrap, { backgroundColor: colors.primary + "22" }]}>
          <Feather name="navigation" size={15} color={colors.primary} />
        </View>
        <Text style={[menuStyles.actionLabel, { color: colors.primary }]}>
          GoTo Section
        </Text>
        <Feather name="chevron-right" size={16} color={colors.primary + "99"} />
      </Pressable>
    </View>
  );
}

const menuStyles = StyleSheet.create({
  container: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 2,
    borderTopWidth: 1,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    paddingHorizontal: 14,
    paddingBottom: 20,
    boxShadow: "0 -3px 10px rgba(0,0,0,0.10)",
  },
  handle: {
    width: 32,
    height: 3,
    borderRadius: 2,
    alignSelf: "center",
    marginTop: 10,
    marginBottom: 12,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  zoneLabel: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
  },
  parityHint: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  dismissBtn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 13,
    gap: 10,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  actionLabel: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
});
