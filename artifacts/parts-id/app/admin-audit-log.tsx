/**
 * Admin Audit Log Screen
 *
 * Displays a reverse-chronological list of privileged admin actions
 * (approve, ban, promote, demote). Admin-only.
 *
 * Route: /admin-audit-log
 */
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useApp } from "@/contexts/AppContext";
import { useColors } from "@/hooks/useColors";
import { shouldRedirectNonAdmin } from "@/utils/adminGuard";
import { API_BASE } from "@/utils/apiBase";
import { useTrackScreen } from "@/utils/useTrackScreen";

type AuditRow = {
  id: number;
  adminClerkUserId: string;
  targetClerkUserId: string;
  action: "approve" | "ban" | "promote" | "demote";
  createdAt: string;
};

const ACTION_CONFIG: Record<AuditRow["action"], { label: string; bg: string; fg: string }> = {
  approve: { label: "Approved", bg: "#10b98120", fg: "#10b981" },
  ban:     { label: "Banned",   bg: "#ef444420", fg: "#ef4444" },
  promote: { label: "Promoted", bg: "#6366f120", fg: "#6366f1" },
  demote:  { label: "Demoted",  bg: "#f59e0b20", fg: "#f59e0b" },
};

function truncate(id: string, len = 14): string {
  if (id.length <= len) return id;
  return `${id.slice(0, len)}…`;
}

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

function AuditItem({ row, colors }: { row: AuditRow; colors: ReturnType<typeof useColors> }) {
  const cfg = ACTION_CONFIG[row.action] ?? { label: row.action, bg: "#88888820", fg: "#888888" };
  return (
    <View style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={[styles.badge, { backgroundColor: cfg.bg }]}>
        <Text style={[styles.badgeText, { color: cfg.fg }]}>{cfg.label}</Text>
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <View style={styles.idRow}>
          <Text style={[styles.label, { color: colors.mutedForeground }]}>Admin</Text>
          <Text style={[styles.idText, { color: colors.foreground }]} numberOfLines={1}>
            {truncate(row.adminClerkUserId)}
          </Text>
        </View>
        <View style={styles.idRow}>
          <Text style={[styles.label, { color: colors.mutedForeground }]}>Target</Text>
          <Text style={[styles.idText, { color: colors.foreground }]} numberOfLines={1}>
            {truncate(row.targetClerkUserId)}
          </Text>
        </View>
      </View>
      <Text style={[styles.time, { color: colors.mutedForeground }]}>{timeAgo(row.createdAt)}</Text>
    </View>
  );
}

export default function AdminAuditLogScreen() {
  useTrackScreen("Admin Audit Log");
  const colors = useColors();
  const router = useRouter();
  const { isAdmin, adminToken, isLoading } = useApp();

  const [rows, setRows] = useState<Array<AuditRow>>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchLog = useCallback(async (isRefresh = false) => {
    if (!adminToken) return;
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/admin/audit-log`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const data = (await res.json()) as Array<AuditRow>;
      setRows(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load audit log");
    } finally {
      if (isRefresh) setRefreshing(false);
      else setLoading(false);
    }
  }, [adminToken]);

  useEffect(() => {
    if (shouldRedirectNonAdmin(isLoading, isAdmin)) {
      router.replace("/(tabs)");
      return;
    }
    if (!isLoading && isAdmin) {
      fetchLog();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, adminToken, isAdmin, fetchLog, router]);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable onPress={() => router.back()} style={styles.backBtn} accessibilityLabel="Go back">
          <Feather name="arrow-left" size={20} color={colors.foreground} />
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>Audit Log</Text>
          <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>
            {rows.length} event{rows.length !== 1 ? "s" : ""}
          </Text>
        </View>
        <Pressable onPress={() => fetchLog()} style={styles.refreshBtn} accessibilityLabel="Refresh">
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
          <Pressable onPress={() => fetchLog()} style={[styles.retryBtn, { borderColor: colors.border }]}>
            <Text style={[styles.retryText, { color: colors.primary }]}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.list}
          removeClippedSubviews={true}
          maxToRenderPerBatch={20}
          windowSize={10}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => fetchLog(true)}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
          renderItem={({ item }) => <AuditItem row={item} colors={colors} />}
          ListEmptyComponent={
            <View style={styles.centered}>
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                No admin actions recorded yet.
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
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
  },
  badge: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    alignSelf: "flex-start",
    minWidth: 70,
    alignItems: "center",
  },
  badgeText: { fontSize: 11, fontFamily: "Inter_700Bold" },
  idRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  label: { fontSize: 10, fontFamily: "Inter_600SemiBold", width: 38 },
  idText: { fontSize: 12, fontFamily: "Inter_400Regular", flex: 1 },
  time: { fontSize: 11, fontFamily: "Inter_400Regular", flexShrink: 0 },
});
