/**
 * Admin Inbox Screen
 *
 * Lists all contact messages submitted by users. Tapping a row expands it
 * and marks it read. Shows an unread count in the header.
 * Admin-only — redirects to tabs if not authenticated.
 *
 * Route: /admin-inbox
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

import { useApiHealth } from "@/contexts/ApiHealthContext";
import { useApp } from "@/contexts/AppContext";
import { useColors } from "@/hooks/useColors";
import { shouldRedirectNonAdmin } from "@/utils/adminGuard";
import { API_BASE } from "@/utils/apiBase";
import { useTrackScreen } from "@/utils/useTrackScreen";

type MessageRow = {
  id: number;
  senderToken: string;
  subject: string;
  body: string;
  createdAt: string;
  readAt: string | null;
};

const MARK_READ_ERROR_MESSAGE =
  "Could not mark message as read. It remains unread. Please try again.";

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

function MessageItem({
  row,
  colors,
  adminToken,
  onMarkRead,
}: {
  row: MessageRow;
  colors: ReturnType<typeof useColors>;
  adminToken: string;
  onMarkRead: (id: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [readError, setReadError] = useState(false);
  const isUnread = !row.readAt;

  const markRead = async () => {
    try {
      const response = await fetch(`${API_BASE}/contact/${row.id}/read`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!response.ok) throw new Error(`Server error ${response.status}`);
      onMarkRead(row.id);
      setReadError(false);
    } catch {
      setReadError(true);
    }
  };

  const handlePress = () => {
    setExpanded((v) => !v);
    if (isUnread) void markRead();
  };

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={`${row.subject}, ${isUnread ? "unread" : "read"} message, ${expanded ? "collapse" : "expand"} message`}
      accessibilityHint={
        isUnread
          ? "Expanding this message will mark it as read."
          : "Activates to expand or collapse this message."
      }
      accessibilityState={{ expanded }}
      style={[
        styles.row,
        {
          backgroundColor: colors.card,
          borderColor: isUnread ? colors.primary + "55" : colors.border,
          borderLeftWidth: isUnread ? 3 : 1,
        },
      ]}
    >
      <View style={styles.rowHeader}>
        <View style={{ flex: 1, gap: 2 }}>
          <View style={styles.subjectRow}>
            {isUnread ? (
              <View style={[styles.unreadDot, { backgroundColor: colors.primary }]} />
            ) : null}
            <Text
              style={[styles.subject, { color: colors.foreground, fontFamily: isUnread ? "Inter_700Bold" : "Inter_600SemiBold" }]}
              numberOfLines={expanded ? undefined : 1}
            >
              {row.subject}
            </Text>
          </View>
          <Text style={[styles.sender, { color: colors.mutedForeground }]}>
            {row.senderToken === "anonymous" ? "Anonymous" : row.senderToken} · {timeAgo(row.createdAt)}
          </Text>
        </View>
        <Feather
          name={expanded ? "chevron-up" : "chevron-down"}
          size={15}
          color={colors.mutedForeground}
        />
      </View>
      {expanded ? (
        <>
          <Text style={[styles.body, { color: colors.foreground, borderTopColor: colors.border }]}>
            {row.body}
          </Text>
          {readError ? (
            <View style={[styles.readError, { backgroundColor: colors.destructive + "12" }]}>
              <Text
                style={[styles.readErrorText, { color: colors.destructive }]}
                accessibilityRole="alert"
              >
                {MARK_READ_ERROR_MESSAGE}
              </Text>
              <View style={styles.readErrorActions}>
                <Pressable
                  onPress={() => void markRead()}
                  accessibilityRole="button"
                  accessibilityLabel="Retry marking message as read"
                  style={[styles.readErrorButton, { borderColor: colors.destructive }]}
                >
                  <Text style={[styles.readErrorButtonText, { color: colors.destructive }]}>
                    Retry
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setReadError(false)}
                  accessibilityRole="button"
                  accessibilityLabel="Dismiss mark as read error"
                  style={styles.dismissErrorButton}
                >
                  <Text style={[styles.dismissErrorText, { color: colors.mutedForeground }]}>
                    Dismiss
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : null}
        </>
      ) : null}
    </Pressable>
  );
}

export default function AdminInboxScreen() {
  "use no memo";

  useTrackScreen("Admin Inbox");
  const colors = useColors();
  const router = useRouter();
  const { isAdmin, adminToken, isLoading } = useApp();

  const [rows, setRows] = useState<Array<MessageRow>>([]);
  const { reportNetworkFailure } = useApiHealth();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const unreadCount = rows.filter((r) => !r.readAt).length;

  const fetchMessages = useCallback(async (isRefresh = false) => {
    if (!adminToken) return;
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    if (isRefresh) setRefreshError(null);
    else setError(null);
    try {
      const res = await fetch(`${API_BASE}/contact`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const data = (await res.json()) as Array<MessageRow>;
      setRows(data);
    } catch (err) {
      if (err instanceof TypeError) reportNetworkFailure();
      const message = err instanceof Error ? err.message : "Failed to load inbox";
      if (isRefresh) setRefreshError(message);
      else setError(message);
    } finally {
      if (isRefresh) setRefreshing(false);
      else setLoading(false);
    }
  }, [adminToken, reportNetworkFailure]);

  useEffect(() => {
    if (shouldRedirectNonAdmin(isLoading, isAdmin)) {
      router.replace("/(tabs)");
      return;
    }
    if (!isLoading && isAdmin) {
      fetchMessages();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, adminToken, isAdmin, fetchMessages, router]);

  const handleMarkRead = useCallback((id: number) => {
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, readAt: new Date().toISOString() } : r))
    );
  }, []);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable onPress={() => router.back()} style={styles.backBtn} accessibilityLabel="Go back">
          <Feather name="arrow-left" size={20} color={colors.foreground} />
        </Pressable>
        <View style={styles.headerCenter}>
          <View style={styles.titleRow}>
            <Text style={[styles.headerTitle, { color: colors.foreground }]}>User Inbox</Text>
            {unreadCount > 0 ? (
              <View style={[styles.badge, { backgroundColor: colors.primary }]}>
                <Text style={[styles.badgeText, { color: colors.primaryForeground }]}>
                  {unreadCount}
                </Text>
              </View>
            ) : null}
          </View>
          <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>
            {rows.length} message{rows.length !== 1 ? "s" : ""}
          </Text>
        </View>
        <Pressable
          onPress={() => fetchMessages(true)}
          style={styles.refreshBtn}
          accessibilityRole="button"
          accessibilityLabel="Refresh inbox"
          accessibilityState={{ busy: refreshing }}
        >
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
          <Pressable onPress={() => fetchMessages()} style={[styles.retryBtn, { borderColor: colors.border }]}>
            <Text style={[styles.retryText, { color: colors.primary }]}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.list}
          removeClippedSubviews={true}
          maxToRenderPerBatch={10}
          windowSize={10}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => fetchMessages(true)}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
          ListHeaderComponent={
            refreshError ? (
              <View
                style={[styles.refreshError, { backgroundColor: colors.destructive + "12" }]}
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
              >
                <Text style={[styles.refreshErrorText, { color: colors.destructive }]}>
                  Could not refresh the inbox. Your loaded messages are still shown.
                </Text>
                <Pressable
                  onPress={() => fetchMessages(true)}
                  accessibilityRole="button"
                  accessibilityLabel="Retry inbox refresh"
                  style={[styles.refreshRetryBtn, { borderColor: colors.destructive }]}
                >
                  <Text style={[styles.refreshRetryText, { color: colors.destructive }]}>
                    Retry
                  </Text>
                </Pressable>
              </View>
            ) : null
          }
          renderItem={({ item }) =>
            adminToken ? (
              <MessageItem
                row={item}
                colors={colors}
                adminToken={adminToken}
                onMarkRead={handleMarkRead}
              />
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.centered}>
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                No messages yet.{"\n"}Users can contact you from the Reference screen.
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
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  headerTitle: { fontSize: 18, fontFamily: "Inter_700Bold" },
  headerSub: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 1 },
  badge: {
    borderRadius: 10,
    paddingHorizontal: 7,
    paddingVertical: 2,
    minWidth: 20,
    alignItems: "center",
  },
  badgeText: { fontSize: 11, fontFamily: "Inter_700Bold" },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 12 },
  errorText: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center" },
  emptyText: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 22 },
  retryBtn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 20, paddingVertical: 8 },
  retryText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  refreshError: {
    borderRadius: 8,
    padding: 10,
    marginBottom: 4,
    gap: 8,
  },
  refreshErrorText: { fontSize: 12, fontFamily: "Inter_600SemiBold", lineHeight: 18 },
  refreshRetryBtn: { alignSelf: "flex-start", borderWidth: 1, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 6 },
  refreshRetryText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  list: { flexGrow: 1, padding: 12, gap: 8 },
  row: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 8,
  },
  rowHeader: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  subjectRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  unreadDot: { width: 7, height: 7, borderRadius: 3.5, flexShrink: 0 },
  subject: { flex: 1, fontSize: 14, lineHeight: 20 },
  sender: { fontSize: 11, fontFamily: "Inter_400Regular" },
  body: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    lineHeight: 21,
    paddingTop: 10,
    marginTop: 2,
    borderTopWidth: 1,
  },
  readError: { borderRadius: 8, padding: 10, gap: 8 },
  readErrorText: { fontSize: 12, fontFamily: "Inter_600SemiBold", lineHeight: 18 },
  readErrorActions: { flexDirection: "row", alignItems: "center", gap: 12 },
  readErrorButton: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 6 },
  readErrorButtonText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  dismissErrorButton: { paddingVertical: 6 },
  dismissErrorText: { fontSize: 12, fontFamily: "Inter_400Regular" },
});
