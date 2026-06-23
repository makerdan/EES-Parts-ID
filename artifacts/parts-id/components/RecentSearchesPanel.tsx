import { Feather } from "@expo/vector-icons";
import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { useColors } from "@/hooks/useColors";
import type { ViewedEntry } from "@/utils/searchHistory";

interface RecentSearchesPanelProps {
  queryHistory: Array<string>;
  viewedHistory: Array<ViewedEntry>;
  onSelectQuery: (q: string) => void;
  onSelectPart: (id: number) => void;
  onClearQueries: () => void;
  onClearViewed: () => void;
}

export function RecentSearchesPanel({
  queryHistory,
  viewedHistory,
  onSelectQuery,
  onSelectPart,
  onClearQueries,
  onClearViewed,
}: RecentSearchesPanelProps) {
  const colors = useColors();

  const hasQueries = queryHistory.length > 0;
  const hasViewed = viewedHistory.length > 0;

  if (!hasQueries && !hasViewed) return null;

  return (
    <View style={styles.container}>
      {hasQueries && (
        <View style={[styles.section, { borderColor: colors.border }]}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>
              Recent Searches
            </Text>
            <Pressable
              onPress={onClearQueries}
              hitSlop={8}
              style={[styles.clearBtn, { borderColor: colors.border }]}
              accessibilityLabel="Clear recent searches"
            >
              <Text style={[styles.clearBtnText, { color: colors.mutedForeground }]}>
                Clear
              </Text>
            </Pressable>
          </View>
          <ScrollView scrollEnabled={false}>
            {queryHistory.map((q) => (
              <Pressable
                key={q}
                onPress={() => onSelectQuery(q)}
                style={({ pressed }) => [
                  styles.row,
                  { backgroundColor: pressed ? colors.muted : "transparent" },
                ]}
                accessibilityLabel={`Re-run search: ${q}`}
              >
                <Feather
                  name="clock"
                  size={14}
                  color={colors.mutedForeground}
                  style={styles.rowIcon}
                />
                <Text
                  style={[styles.rowText, { color: colors.foreground }]}
                  numberOfLines={1}
                >
                  {q}
                </Text>
                <Feather
                  name="chevron-right"
                  size={14}
                  color={colors.mutedForeground}
                />
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}

      {hasViewed && (
        <View style={[styles.section, { borderColor: colors.border }]}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>
              Recently Viewed
            </Text>
            <Pressable
              onPress={onClearViewed}
              hitSlop={8}
              style={[styles.clearBtn, { borderColor: colors.border }]}
              accessibilityLabel="Clear recently viewed"
            >
              <Text style={[styles.clearBtnText, { color: colors.mutedForeground }]}>
                Clear
              </Text>
            </Pressable>
          </View>
          <ScrollView scrollEnabled={false}>
            {viewedHistory.map((entry) => (
              <Pressable
                key={entry.id}
                onPress={() => onSelectPart(entry.id)}
                style={({ pressed }) => [
                  styles.row,
                  { backgroundColor: pressed ? colors.muted : "transparent" },
                ]}
                accessibilityLabel={`View part: ${entry.catalog}`}
              >
                <Feather
                  name="box"
                  size={14}
                  color={colors.mutedForeground}
                  style={styles.rowIcon}
                />
                <View style={styles.partRowContent}>
                  <Text
                    style={[styles.partCatalog, { color: colors.foreground }]}
                    numberOfLines={1}
                  >
                    {entry.catalog}
                  </Text>
                  {entry.name !== entry.catalog && entry.name.trim().length > 0 && (
                    <Text
                      style={[styles.partName, { color: colors.mutedForeground }]}
                      numberOfLines={1}
                    >
                      {entry.name}
                    </Text>
                  )}
                </View>
                <Feather
                  name="chevron-right"
                  size={14}
                  color={colors.mutedForeground}
                />
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: 12,
    gap: 12,
  },
  section: {
    borderWidth: 1,
    borderRadius: 10,
    overflow: "hidden",
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.2,
  },
  clearBtn: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  clearBtnText: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(128,128,128,0.2)",
  },
  rowIcon: {
    marginRight: 10,
    flexShrink: 0,
  },
  rowText: {
    flex: 1,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  partRowContent: {
    flex: 1,
    marginRight: 4,
  },
  partCatalog: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
  partName: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    marginTop: 1,
  },
});
