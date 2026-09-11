/**
 * Admin Audit Log Screen
 *
 * Displays a reverse-chronological list of privileged admin actions
 * (approve, ban, promote, demote). Admin-only. Supports paginated load-more.
 *
 * Route: /admin-audit-log
 */
import { Feather } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
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

type AuditRow = {
  id: number;
  adminClerkUserId: string;
  targetClerkUserId: string;
  action: "approve" | "ban" | "promote" | "demote";
  createdAt: string;
};


type AuditLogPage = {
  rows: Array<AuditRow>;
  nextCursor: number | null;
};

const PAGE_SIZE = 50;

function mergeAuditRows(existingRows: Array<AuditRow>, incomingRows: Array<AuditRow>): Array<AuditRow> {
  const seenIds = new Set(existingRows.map((row) => row.id));
  const mergedRows = [...existingRows];

  for (const row of incomingRows) {
    if (seenIds.has(row.id)) continue;
    seenIds.add(row.id);
    mergedRows.push(row);
  }

  return mergedRows;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

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

type IdentifierField = "admin" | "target";
type CopyStatus = { field: IdentifierField; kind: "copied" | "failed" } | null;

function AuditItem({ row, colors }: { row: AuditRow; colors: ReturnType<typeof useColors> }) {
  const cfg = ACTION_CONFIG[row.action] ?? { label: row.action, bg: "#88888820", fg: "#888888" };
  const [copyStatus, setCopyStatus] = useState<CopyStatus>(null);
  const mountedRef = useRef(true);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const copyIdentifier = useCallback(async (field: IdentifierField, value: string) => {
    setCopyStatus(null);
    try {
      await Clipboard.setStringAsync(value);
      if (mountedRef.current) setCopyStatus({ field, kind: "copied" });
    } catch {
      if (mountedRef.current) setCopyStatus({ field, kind: "failed" });
    }
  }, []);

  const renderIdentifier = (field: IdentifierField, label: string, value: string) => {
    const fieldLabel = field === "admin" ? "administrator" : "target";
    const status = copyStatus?.field === field ? copyStatus.kind : null;
    return (
      <View style={styles.idRow}>
        <Text style={[styles.label, { color: colors.mutedForeground }]}>{label}</Text>
        <Text
          style={[styles.idText, { color: colors.foreground }]}
          numberOfLines={1}
          accessibilityLabel={`${label} ID: ${value}`}
          accessibilityHint={`The full ${fieldLabel} ID is available to screen readers`}
        >
          {truncate(value)}
        </Text>
        <Pressable
          onPress={() => void copyIdentifier(field, value)}
          style={[styles.copyBtn, { borderColor: colors.border }]}
          accessibilityRole="button"
          accessibilityLabel={`Copy ${fieldLabel} ID`}
          accessibilityHint={`Copies the full ${fieldLabel} ID`}
        >
          <Feather name="copy" size={13} color={colors.mutedForeground} />
        </Pressable>
        {status === "copied" ? (
          <Text
            style={[styles.copyStatus, { color: colors.primary }]}
            accessibilityLabel={`${label} ID copied`}
            accessibilityLiveRegion="polite"
          >
            Copied
          </Text>
        ) : status === "failed" ? (
          <Text
            style={[styles.copyStatus, { color: colors.destructive }]}
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
          >
            Copy failed
          </Text>
        ) : null}
      </View>
    );
  };

  return (
    <View style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={[styles.badge, { backgroundColor: cfg.bg }]}>
        <Text style={[styles.badgeText, { color: cfg.fg }]}>{cfg.label}</Text>
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        {renderIdentifier("admin", "Admin", row.adminClerkUserId)}
        {renderIdentifier("target", "Target", row.targetClerkUserId)}
      </View>
      <Text style={[styles.time, { color: colors.mutedForeground }]}>{timeAgo(row.createdAt)}</Text>
    </View>
  );
}

export default function AdminAuditLogScreen() {
  "use no memo";

  useTrackScreen("Admin Audit Log");
  const colors = useColors();
  const router = useRouter();
  const { isAdmin, adminToken, isLoading } = useApp();
  const { reportNetworkFailure } = useApiHealth();

  const [rows, setRows] = useState<Array<AuditRow>>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const nextCursorRef = useRef<number | null>(null);
  const hasMoreRef = useRef(true);
  const requestVersionRef = useRef(0);
  const fullPageRequestRef = useRef<number | null>(null);
  const activeLoadMoreRequestRef = useRef<number | null>(null);
  const nextLoadMoreRequestIdRef = useRef(0);
  const mountedRef = useRef(false);
  const adminAccessRef = useRef(false);
  const fullPageAbortControllerRef = useRef<AbortController | null>(null);
  const loadMoreAbortControllerRef = useRef<AbortController | null>(null);

  adminAccessRef.current = !isLoading && isAdmin && Boolean(adminToken);

  const cancelRequests = useCallback((resetUi = false) => {
    requestVersionRef.current += 1;
    fullPageAbortControllerRef.current?.abort();
    fullPageAbortControllerRef.current = null;
    loadMoreAbortControllerRef.current?.abort();
    loadMoreAbortControllerRef.current = null;
    fullPageRequestRef.current = null;
    activeLoadMoreRequestRef.current = null;
    if (resetUi && mountedRef.current) {
      setLoading(false);
      setRefreshing(false);
      setLoadingMore(false);
      setError(null);
      setLoadMoreError(null);
    }
  }, []);

  const fetchPage = useCallback(async (
    beforeId: number | null,
    token: string,
    signal: AbortSignal,
  ): Promise<AuditLogPage> => {
    const url = beforeId !== null
      ? `${API_BASE}/admin/audit-log?limit=${PAGE_SIZE}&before_id=${beforeId}`
      : `${API_BASE}/admin/audit-log?limit=${PAGE_SIZE}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    return res.json() as Promise<AuditLogPage>;
  }, []);

  const fetchLog = useCallback(async (isRefresh = false) => {
    if (!adminToken || !mountedRef.current || !adminAccessRef.current) return;

    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    fullPageAbortControllerRef.current?.abort();
    loadMoreAbortControllerRef.current?.abort();
    loadMoreAbortControllerRef.current = null;
    fullPageRequestRef.current = requestVersion;
    activeLoadMoreRequestRef.current = null;
    setLoadingMore(false);
    setLoadMoreError(null);
    const controller = new AbortController();
    fullPageAbortControllerRef.current = controller;

    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const page = await fetchPage(null, adminToken, controller.signal);
      if (
        requestVersion !== requestVersionRef.current ||
        controller.signal.aborted ||
        !mountedRef.current ||
        !adminAccessRef.current
      ) return;
      setRows(mergeAuditRows([], page.rows));
      nextCursorRef.current = page.nextCursor;
      hasMoreRef.current = page.nextCursor !== null;
    } catch (err) {
      if (
        requestVersion !== requestVersionRef.current ||
        controller.signal.aborted ||
        !mountedRef.current ||
        !adminAccessRef.current ||
        isAbortError(err)
      ) return;
      if (err instanceof TypeError) reportNetworkFailure();
      setError(err instanceof Error ? err.message : "Failed to load audit log");
    } finally {
      if (
        requestVersion !== requestVersionRef.current ||
        fullPageAbortControllerRef.current !== controller ||
        !mountedRef.current ||
        !adminAccessRef.current
      ) return;
      fullPageAbortControllerRef.current = null;
      fullPageRequestRef.current = null;
      if (isRefresh) setRefreshing(false);
      else setLoading(false);
    }
  }, [adminToken, fetchPage, reportNetworkFailure]);

  const loadMore = useCallback(async () => {
    if (
      !adminToken ||
      loadingMore ||
      fullPageRequestRef.current !== null ||
      !hasMoreRef.current ||
      nextCursorRef.current === null
    ) return;

    const beforeId = nextCursorRef.current;
    const requestVersion = requestVersionRef.current;
    const requestId = nextLoadMoreRequestIdRef.current + 1;
    nextLoadMoreRequestIdRef.current = requestId;
    activeLoadMoreRequestRef.current = requestId;
    const controller = new AbortController();
    loadMoreAbortControllerRef.current = controller;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await fetchPage(beforeId, adminToken, controller.signal);
      if (
        requestVersion !== requestVersionRef.current ||
        activeLoadMoreRequestRef.current !== requestId ||
        controller.signal.aborted ||
        !mountedRef.current ||
        !adminAccessRef.current
      ) return;
      setRows((prev) => mergeAuditRows(prev, page.rows));
      nextCursorRef.current = page.nextCursor;
      hasMoreRef.current = page.nextCursor !== null;
    } catch (err) {
      if (
        requestVersion !== requestVersionRef.current ||
        activeLoadMoreRequestRef.current !== requestId ||
        controller.signal.aborted ||
        !mountedRef.current ||
        !adminAccessRef.current ||
        isAbortError(err)
      ) return;
      if (err instanceof TypeError) reportNetworkFailure();
      setLoadMoreError(err instanceof Error ? err.message : "Failed to load more");
    } finally {
      if (
        activeLoadMoreRequestRef.current === requestId &&
        loadMoreAbortControllerRef.current === controller &&
        mountedRef.current &&
        adminAccessRef.current
      ) {
        activeLoadMoreRequestRef.current = null;
        loadMoreAbortControllerRef.current = null;
        setLoadingMore(false);
      }
    }
  }, [adminToken, loadingMore, fetchPage, reportNetworkFailure]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelRequests();
    };
  }, [cancelRequests]);

  useEffect(() => {
    if (!isLoading && isAdmin && adminToken) return;
    cancelRequests(!isLoading);
  }, [adminToken, cancelRequests, isAdmin, isLoading]);

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

  const ListFooter = loadingMore ? (
    <View
      style={styles.footerLoader}
      accessibilityRole="progressbar"
      accessibilityLabel="Loading more audit log entries"
      accessibilityLiveRegion="polite"
    >
      <ActivityIndicator size="small" color={colors.primary} />
    </View>
  ) : loadMoreError ? (
    <View
      style={styles.footerError}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <Text style={[styles.footerErrorText, { color: colors.destructive }]}>
        ⚠ {loadMoreError}
      </Text>
      <Pressable
        onPress={loadMore}
        style={[styles.retryBtn, { borderColor: colors.border }]}
        accessibilityRole="button"
        accessibilityLabel="Retry loading more audit log entries"
      >
        <Text style={[styles.retryText, { color: colors.primary }]}>Retry</Text>
      </Pressable>
    </View>
  ) : hasMoreRef.current && rows.length > 0 ? (
    <Pressable
      onPress={loadMore}
      style={[styles.loadMoreBtn, { borderColor: colors.border }]}
      accessibilityRole="button"
      accessibilityLabel="Load more audit log entries"
    >
      <Text style={[styles.loadMoreText, { color: colors.primary }]}>Load more</Text>
    </Pressable>
  ) : null;
  const hasLoadedRows = rows.length > 0;
  const ListHeader = error && hasLoadedRows ? (
    <View
      style={[styles.listError, { backgroundColor: colors.card, borderColor: colors.border }]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <Text style={[styles.footerErrorText, { color: colors.destructive }]}>
        ⚠ {error}
      </Text>
      <Pressable
        onPress={() => fetchLog(true)}
        style={[styles.retryBtn, { borderColor: colors.border }]}
        accessibilityRole="button"
        accessibilityLabel="Retry refreshing audit log"
      >
        <Text style={[styles.retryText, { color: colors.primary }]}>Retry</Text>
      </Pressable>
    </View>
  ) : null;
  const lifecycleStatus = loading && !hasLoadedRows
    ? "Loading audit log"
    : refreshing
      ? "Refreshing audit log"
      : loadingMore
        ? "Loading more audit log entries"
        : loadMoreError
          ? `Could not load more audit log entries. ${loadMoreError}`
          : error
            ? `Could not refresh audit log. ${error}`
            : null;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable onPress={() => router.back()} style={styles.backBtn} accessibilityLabel="Go back">
          <Feather name="arrow-left" size={20} color={colors.foreground} />
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>Audit Log</Text>
          <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>
            {rows.length} event{rows.length !== 1 ? "s" : ""}{hasMoreRef.current ? "+" : ""}
          </Text>
        </View>
        <Pressable
          onPress={() => fetchLog(hasLoadedRows)}
          style={styles.refreshBtn}
          accessibilityLabel={refreshing ? "Refreshing audit log" : "Refresh"}
          accessibilityHint="Reload audit events to include actions from other admin sessions"
          accessibilityRole="button"
          accessibilityState={{ busy: loading || refreshing }}
        >
          <Feather name="refresh-cw" size={17} color={colors.mutedForeground} />
        </Pressable>
      </View>

      {lifecycleStatus ? (
        <Text
          accessibilityLabel={lifecycleStatus}
          accessibilityLiveRegion="polite"
          style={styles.accessibilityStatus}
        >
          {lifecycleStatus}
        </Text>
      ) : null}

      {loading && !hasLoadedRows ? (
        <View
          style={styles.centered}
          accessibilityRole="progressbar"
          accessibilityLabel="Loading audit log"
          accessibilityLiveRegion="polite"
        >
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error && !hasLoadedRows ? (
        <View style={styles.centered}>
          <Text
            style={[styles.errorText, { color: colors.destructive }]}
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
          >
            ⚠ {error}
          </Text>
          <Pressable
            onPress={() => fetchLog(false)}
            style={[styles.retryBtn, { borderColor: colors.border }]}
            accessibilityRole="button"
            accessibilityLabel="Retry loading audit log"
          >
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
          onEndReached={loadMore}
          onEndReachedThreshold={0.3}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => fetchLog(true)}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
          renderItem={({ item }) => <AuditItem row={item} colors={colors} />}
          ListHeaderComponent={ListHeader}
          ListFooterComponent={ListFooter}
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
  accessibilityStatus: {
    position: "absolute",
    width: 1,
    height: 1,
    opacity: 0,
    overflow: "hidden",
  },
  errorText: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center" },
  listError: {
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
    padding: 12,
    borderWidth: 1,
    borderRadius: 10,
  },
  emptyText: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 22 },
  retryBtn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 20, paddingVertical: 8 },
  retryText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  list: { flexGrow: 1, padding: 12, gap: 8 },
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
  copyBtn: {
    borderWidth: 1,
    borderRadius: 5,
    padding: 4,
  },
  copyStatus: { fontSize: 10, fontFamily: "Inter_600SemiBold" },
  time: { fontSize: 11, fontFamily: "Inter_400Regular", flexShrink: 0 },
  footerLoader: { paddingVertical: 16, alignItems: "center" },
  footerError: { alignItems: "center", gap: 8, paddingVertical: 12, paddingHorizontal: 12 },
  footerErrorText: { fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center" },
  loadMoreBtn: {
    marginHorizontal: 12,
    marginVertical: 8,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
  },
  loadMoreText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
});
