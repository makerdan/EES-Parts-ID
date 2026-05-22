/**
 * AI Answer Log Screen
 *
 * Lists recent Q&A pairs from the reference assistant, showing the question,
 * matched inventory item count, and timestamp. Tap a row to expand the full answer.
 * Admin-only.
 *
 * Route: /ai-log
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/contexts/AppContext";

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : "";

type LogRow = {
  id: number;
  question: string;
  answer: string;
  matchedItemCount: number;
  createdAt: string;
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function LogItem({ row, colors }: { row: LogRow; colors: ReturnType<typeof useColors> }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Pressable
      onPress={() => setExpanded((v) => !v)}
      style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border }]}
    >
      <View style={styles.rowHeader}>
        <Text style={[styles.question, { color: colors.foreground }]} numberOfLines={expanded ? undefined : 2}>
          {row.question}
        </Text>
        <Feather
          name={expanded ? "chevron-up" : "chevron-down"}
          size={15}
          color={colors.mutedForeground}
        />
      </View>
      <View style={styles.rowMeta}>
        <View style={[styles.matchBadge, { backgroundColor: row.matchedItemCount > 0 ? colors.primary + "22" : colors.muted }]}>
          <Text style={[styles.matchBadgeText, { color: row.matchedItemCount > 0 ? colors.primary : colors.mutedForeground }]}>
            {row.matchedItemCount} item{row.matchedItemCount !== 1 ? "s" : ""} matched
          </Text>
        </View>
        <Text style={[styles.timestamp, { color: colors.mutedForeground }]}>{timeAgo(row.createdAt)}</Text>
      </View>
      {expanded && (
        <Text style={[styles.answer, { color: colors.mutedForeground, borderTopColor: colors.border }]}>
          {row.answer}
        </Text>
      )}
    </Pressable>
  );
}

export default function AiLogScreen() {
  const colors = useColors();
  const router = useRouter();
  const { isAdmin, adminToken } = useApp();

  const [rows, setRows] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchLog = useCallback(async () => {
    if (!adminToken) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/reference/ask-log`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const data = (await res.json()) as LogRow[];
      setRows(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load log");
    } finally {
      setLoading(false);
    }
  }, [adminToken]);

  useEffect(() => {
    if (!isAdmin) {
      router.replace("/(tabs)");
      return;
    }
    fetchLog();
  }, [isAdmin, fetchLog, router]);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable onPress={() => router.back()} style={styles.backBtn} accessibilityLabel="Go back">
          <Feather name="arrow-left" size={20} color={colors.foreground} />
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>AI Answer Log</Text>
          <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>Last 100 questions</Text>
        </View>
        <Pressable onPress={fetchLog} style={styles.refreshBtn} accessibilityLabel="Refresh">
          <Feather name="refresh-cw" size={17} color={colors.mutedForeground} />
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <Text style={[styles.errorText, { color: colors.destructive }]}>⚠ {error}</Text>
          <Pressable onPress={fetchLog} style={[styles.retryBtn, { borderColor: colors.border }]}>
            <Text style={[styles.retryText, { color: colors.primary }]}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => <LogItem row={item} colors={colors} />}
          ListEmptyComponent={
            <View style={styles.centered}>
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                No questions logged yet.{"\n"}Ask the AI something to see it here.
              </Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    gap: 12,
  },
  backBtn: { padding: 4 },
  refreshBtn: { padding: 4 },
  headerCenter: { flex: 1 },
  headerTitle: { fontSize: 18, fontFamily: "Inter_700Bold" },
  headerSub: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 1 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 12 },
  errorText: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center" },
  emptyText: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 22 },
  retryBtn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 20, paddingVertical: 8 },
  retryText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  list: { padding: 12, gap: 8 },
  row: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 8,
  },
  rowHeader: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  question: { flex: 1, fontSize: 14, fontFamily: "Inter_600SemiBold", lineHeight: 20 },
  rowMeta: { flexDirection: "row", alignItems: "center", gap: 8 },
  matchBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  matchBadgeText: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  timestamp: { fontSize: 11, fontFamily: "Inter_400Regular" },
  answer: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
    paddingTop: 10,
    marginTop: 2,
    borderTopWidth: 1,
    color: "#555",
  },
});
