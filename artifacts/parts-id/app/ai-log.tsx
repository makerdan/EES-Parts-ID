/**
 * AI Answer Log Screen
 *
 * Lists recent Q&A pairs from the reference assistant, showing the question,
 * matched inventory item count, and timestamp. Tap a row to expand the full answer.
 * Admin-only.
 *
 * Route: /ai-log
 */
import { Feather } from "@expo/vector-icons";
import { ReferenceLogResponseSchema, type ReferenceLogRow } from "@workspace/api-zod";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  SafeAreaView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { useApiHealth } from "@/contexts/ApiHealthContext";
import { useApp } from "@/contexts/AppContext";
import { useColors } from "@/hooks/useColors";
import { shouldRedirectNonAdmin } from "@/utils/adminGuard";
import { API_BASE } from "@/utils/apiBase";
import { useTrackScreen } from "@/utils/useTrackScreen";

const AI_LOG_PAGE_SIZE = 100;

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

function LogItem({ row, colors }: { row: ReferenceLogRow; colors: ReturnType<typeof useColors> }) {
  const [expanded, setExpanded] = useState(false);
  const matchSummary = `${row.matchedItemCount} matched item${row.matchedItemCount === 1 ? "" : "s"}`;

  return (
    <Pressable
      onPress={() => setExpanded((v) => !v)}
      style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border }]}
      accessibilityRole="button"
      accessibilityLabel={`${row.question}. ${matchSummary}. ${timeAgo(row.createdAt)}. ${
        expanded ? "Collapse answer" : "Expand answer"
      }`}
      accessibilityState={{ expanded }}
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

function escapeCsv(value: string | number): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}

export default function AiLogScreen() {
  "use no memo";

  useTrackScreen("AI Log");
  const colors = useColors();
  const router = useRouter();
  const { isAdmin, adminToken, isLoading } = useApp();
  const { reportNetworkFailure } = useApiHealth();

  const [rows, setRows] = useState<Array<ReferenceLogRow>>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [totalRows, setTotalRows] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [viewCleared, setViewCleared] = useState(false);
  const [exportFeedback, setExportFeedback] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const requestGenerationRef = useRef(0);
  const requestControllerRef = useRef<AbortController | null>(null);
  const activeSearchRef = useRef("");
  const currentPageRef = useRef(1);

  const visibleRows = useMemo(() => {
    if (viewCleared) return [];
    return rows;
  }, [rows, viewCleared]);

  const fetchLog = useCallback(async (
    isRefresh = false,
    requestedPage = 1,
    requestedSearch = activeSearchRef.current,
  ) => {
    if (!adminToken || !isAdmin) return;

    const generation = ++requestGenerationRef.current;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;

    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    setExportFeedback(null);

    try {
      const params = new URLSearchParams({
        page: String(requestedPage),
        limit: String(AI_LOG_PAGE_SIZE),
      });
      if (requestedSearch) params.set("search", requestedSearch);

      const res = await fetch(`${API_BASE}/reference/ask-log?${params.toString()}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const data: unknown = await res.json();
      const parsed = ReferenceLogResponseSchema.safeParse(data);
      if (!parsed.success) throw new Error("Invalid AI log response");

      if (
        !mountedRef.current ||
        generation !== requestGenerationRef.current ||
        controller.signal.aborted
      ) {
        return;
      }
      setRows((previous) =>
        requestedPage === 1 ? parsed.data.rows : [...previous, ...parsed.data.rows],
      );
      setTotalRows(parsed.data.total);
      setHasMore(parsed.data.hasMore);
      currentPageRef.current = parsed.data.page;
      setViewCleared(false);
    } catch (err) {
      if (
        !mountedRef.current ||
        generation !== requestGenerationRef.current ||
        controller.signal.aborted
      ) {
        return;
      }
      if (err instanceof TypeError) reportNetworkFailure();
      setError(err instanceof Error ? err.message : "Failed to load log");
    } finally {
      if (
        mountedRef.current &&
        generation === requestGenerationRef.current
      ) {
        if (isRefresh) setRefreshing(false);
        else setLoading(false);
      }
    }
  }, [adminToken, isAdmin, reportNetworkFailure]);

  useEffect(() => {
    mountedRef.current = true;
    if (shouldRedirectNonAdmin(isLoading, isAdmin)) {
      requestGenerationRef.current += 1;
      requestControllerRef.current?.abort();
      setRows([]);
      router.replace("/(tabs)");
      return;
    }

    if (!isLoading && isAdmin && adminToken) {
      requestGenerationRef.current += 1;
      requestControllerRef.current?.abort();
      setRows([]);
      setViewCleared(false);
      setSearchQuery("");
      setActiveSearch("");
      activeSearchRef.current = "";
      setTotalRows(0);
      setHasMore(false);
      currentPageRef.current = 1;
      setError(null);
      void fetchLog();
    } else if (!isLoading && (!isAdmin || !adminToken)) {
      requestGenerationRef.current += 1;
      requestControllerRef.current?.abort();
      setRows([]);
      setViewCleared(false);
      setSearchQuery("");
      setActiveSearch("");
      activeSearchRef.current = "";
      setTotalRows(0);
      setHasMore(false);
      currentPageRef.current = 1;
      setError(null);
      setLoading(false);
      setRefreshing(false);
    }

    return () => {
      requestGenerationRef.current += 1;
      requestControllerRef.current?.abort();
    };
  }, [adminToken, fetchLog, isAdmin, isLoading, router]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      requestGenerationRef.current += 1;
      requestControllerRef.current?.abort();
    };
  }, []);

  const clearVisibleLog = useCallback(() => {
    Alert.alert(
      "Clear this view?",
      "This only hides the rows currently loaded on this screen. The server log is unchanged, and Refresh can load it again.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear view",
          style: "destructive",
          onPress: () => {
            setViewCleared(true);
            setSearchQuery("");
            setExportFeedback("The loaded log is hidden from this screen.");
          },
        },
      ],
    );
  }, []);

  const submitSearch = useCallback(() => {
    const nextSearch = searchQuery.trim();
    activeSearchRef.current = nextSearch;
    setActiveSearch(nextSearch);
    setRows([]);
    setTotalRows(0);
    setHasMore(false);
    currentPageRef.current = 1;
    setViewCleared(false);
    void fetchLog(false, 1, nextSearch);
  }, [fetchLog, searchQuery]);

  const clearSearch = useCallback(() => {
    setSearchQuery("");
    activeSearchRef.current = "";
    setActiveSearch("");
    setRows([]);
    setTotalRows(0);
    setHasMore(false);
    currentPageRef.current = 1;
    setViewCleared(false);
    void fetchLog(false, 1, "");
  }, [fetchLog]);

  const exportVisibleLog = useCallback(async () => {
    if (!isAdmin || !adminToken) {
      setExportFeedback("Your admin session ended. Refresh after signing in again.");
      return;
    }
    if (visibleRows.length === 0) {
      setExportFeedback("There are no visible rows to export.");
      return;
    }

    const csv = [
      ["Question", "Answer", "Matched items", "Created at"].map(escapeCsv).join(","),
      ...visibleRows.map((row) =>
        [
          escapeCsv(row.question),
          escapeCsv(row.answer),
          row.matchedItemCount,
          escapeCsv(row.createdAt),
        ].join(","),
      ),
    ].join("\n");

    try {
      await Share.share({
        title: "AI Answer Log",
        message: csv,
      });
      setExportFeedback(`Export prepared for ${visibleRows.length} visible row${
        visibleRows.length === 1 ? "" : "s"
      }.`);
    } catch {
      setExportFeedback("Export could not be opened. No log data was changed.");
    }
  }, [adminToken, isAdmin, visibleRows]);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable onPress={() => router.back()} style={styles.backBtn} accessibilityLabel="Go back">
          <Feather name="arrow-left" size={20} color={colors.foreground} />
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>AI Answer Log</Text>
          <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>
            Search retained questions · admin only
          </Text>
        </View>
        <Pressable
          onPress={() => void fetchLog(true)}
          disabled={loading || refreshing}
          style={styles.refreshBtn}
          accessibilityLabel="Refresh"
          accessibilityState={{ disabled: loading || refreshing }}
        >
          <Feather name="refresh-cw" size={17} color={colors.mutedForeground} />
        </Pressable>
      </View>

      {loading && rows.length === 0 ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : !isLoading && isAdmin && !adminToken ? (
        <View style={styles.centered}>
          <Text style={[styles.errorText, { color: colors.destructive }]}>
            Your admin session is unavailable.
          </Text>
          <Text style={[styles.helperText, { color: colors.mutedForeground }]}>
            Return to People & System and sign in again before opening the AI log.
          </Text>
          <Pressable
            onPress={() => router.back()}
            style={[styles.retryBtn, { borderColor: colors.border }]}
            accessibilityRole="button"
            accessibilityLabel="Return from AI log"
          >
            <Text style={[styles.retryText, { color: colors.primary }]}>Return</Text>
          </Pressable>
        </View>
      ) : error && rows.length === 0 && !refreshing ? (
        <View style={styles.centered}>
          <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text>
          <Text style={[styles.helperText, { color: colors.mutedForeground }]}>
            The previous log was not available. Try again without leaving this screen.
          </Text>
          <Pressable
            onPress={() => void fetchLog()}
            style={[styles.retryBtn, { borderColor: colors.border }]}
            accessibilityRole="button"
            accessibilityLabel="Retry loading AI log"
          >
            <Text style={[styles.retryText, { color: colors.primary }]}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <View style={styles.toolbar}>
            <TextInput
              value={searchQuery}
              onChangeText={(value) => {
                setSearchQuery(value);
                setViewCleared(false);
                setExportFeedback(null);
              }}
              onSubmitEditing={submitSearch}
              placeholder="Search questions or answers"
              placeholderTextColor={colors.mutedForeground}
              style={[
                styles.filterInput,
                { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.card },
              ]}
              accessibilityLabel="Search AI log"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
            />
            <View style={styles.actionRow}>
              {searchQuery.length > 0 && (
                <Pressable
                  onPress={clearSearch}
                  style={[styles.actionBtn, { borderColor: colors.border }]}
                  accessibilityRole="button"
                  accessibilityLabel="Clear AI log search"
                >
                  <Text style={[styles.actionText, { color: colors.mutedForeground }]}>Clear search</Text>
                </Pressable>
              )}
              <Pressable
                onPress={clearVisibleLog}
                style={[styles.actionBtn, { borderColor: colors.border }]}
                accessibilityRole="button"
                accessibilityLabel="Clear loaded AI log view"
              >
                <Text style={[styles.actionText, { color: colors.mutedForeground }]}>Clear view</Text>
              </Pressable>
              <Pressable
                onPress={() => void exportVisibleLog()}
                style={[styles.actionBtn, { borderColor: colors.border }]}
                accessibilityRole="button"
                accessibilityLabel="Export visible AI log rows"
              >
                <Text style={[styles.actionText, { color: colors.primary }]}>Export</Text>
              </Pressable>
            </View>
            <Text style={[styles.scopeText, { color: colors.mutedForeground }]}>
              {viewCleared
                ? "This view is clear. Search or refresh to load questions."
                : activeSearch
                  ? `${visibleRows.length} of ${totalRows} matching question${totalRows === 1 ? "" : "s"} loaded`
                  : `${visibleRows.length} of ${totalRows} retained question${totalRows === 1 ? "" : "s"} loaded`}
            </Text>
            {hasMore && !viewCleared && (
              <Pressable
                onPress={() => void fetchLog(false, currentPageRef.current + 1)}
                disabled={loading || refreshing}
                style={[styles.loadMoreBtn, { borderColor: colors.border }]}
                accessibilityRole="button"
                accessibilityLabel="Load older AI log rows"
                accessibilityState={{ disabled: loading || refreshing }}
              >
                <Text style={[styles.actionText, { color: colors.primary }]}>
                  {loading ? "Loading older questions…" : "Load older questions"}
                </Text>
              </Pressable>
            )}
            {error && rows.length > 0 && (
              <View style={[styles.inlineError, { backgroundColor: colors.destructive + "15", borderColor: colors.destructive + "55" }]}>
                <Text style={[styles.inlineErrorText, { color: colors.destructive }]}>
                  Refresh failed: {error}. Showing the last loaded log.
                </Text>
                <Pressable
                  onPress={() => void fetchLog(true)}
                  accessibilityRole="button"
                  accessibilityLabel="Retry refreshing AI log"
                >
                  <Text style={[styles.retryText, { color: colors.primary }]}>Retry</Text>
                </Pressable>
              </View>
            )}
            {exportFeedback && (
              <Text
                style={[styles.feedbackText, { color: colors.mutedForeground }]}
                accessibilityLiveRegion="polite"
              >
                {exportFeedback}
              </Text>
            )}
          </View>
          {visibleRows.length === 0 ? (
            <View style={styles.centered}>
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                {viewCleared
                  ? "This view is clear.\nSearch or refresh to load questions."
                  : activeSearch
                    ? "No retained questions match this search.\nTry a shorter search."
                    : "No questions logged yet.\nAsk the AI something to see it here."}
              </Text>
            </View>
          ) : (
            <FlatList
              data={visibleRows}
              keyExtractor={(item) => String(item.id)}
              contentContainerStyle={styles.list}
              removeClippedSubviews={true}
              initialNumToRender={10}
              maxToRenderPerBatch={10}
              windowSize={10}
              keyboardShouldPersistTaps="handled"
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={() => void fetchLog(true)}
                  tintColor={colors.primary}
                  colors={[colors.primary]}
                />
              }
              renderItem={({ item }) => <LogItem row={item} colors={colors} />}
            />
          )}
        </>
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
  helperText: { fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 19 },
  emptyText: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 22 },
  retryBtn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 20, paddingVertical: 8 },
  retryText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  toolbar: { paddingHorizontal: 12, paddingTop: 12, gap: 8 },
  filterInput: {
    minHeight: 42,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  actionBtn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7 },
  loadMoreBtn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, alignSelf: "flex-start" },
  actionText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  scopeText: { fontSize: 12, fontFamily: "Inter_400Regular" },
  inlineError: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    gap: 8,
  },
  inlineErrorText: { flex: 1, fontSize: 12, fontFamily: "Inter_400Regular", lineHeight: 18 },
  feedbackText: { fontSize: 12, fontFamily: "Inter_400Regular" },
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
  },
});
