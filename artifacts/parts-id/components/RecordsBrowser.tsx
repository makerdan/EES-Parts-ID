/**
 * RecordsBrowser
 *
 * Paginated, searchable list of all inventory records for the Records sub-tab
 * in the Upload screen (admin-only).
 *
 * Features:
 *   - Debounced search bar (400 ms) that re-fetches with ?q=… on GET /inventory
 *   - Pull-to-refresh (RefreshControl)
 *   - Scroll-triggered load-more via onEndReached (threshold 0.3)
 *   - Tap a row to open RecordEditModal for inline editing
 *   - Optimistic list update after a successful PATCH
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useColors } from "@/hooks/useColors";
import type { InventoryItem } from "@workspace/api-client-react";
import { RecordEditModal } from "./RecordEditModal";

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : "";

const PAGE_SIZE = 50;

interface Props {
  adminHeaders: Record<string, string>;
}

type ListItem = InventoryItem & { vendorFullName?: string | null };

export function RecordsBrowser({ adminHeaders }: Props) {
  const colors = useColors();

  const [items, setItems] = useState<ListItem[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allLoaded, setAllLoaded] = useState(false);

  const [search, setSearch] = useState("");

  const [editItem, setEditItem] = useState<ListItem | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guard so onEndReached can't double-trigger while a fetch is in flight
  const fetchingRef = useRef(false);

  const fetchPage = useCallback(async (opts: {
    pageNum: number;
    q: string;
    append: boolean;
    isRefresh?: boolean;
  }) => {
    const { pageNum, q, append, isRefresh } = opts;
    if (fetchingRef.current && append) return;
    fetchingRef.current = true;

    if (isRefresh) setRefreshing(true);
    else if (append) setLoadingMore(true);
    else setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        page: String(pageNum),
        limit: String(PAGE_SIZE),
      });
      if (q.trim()) params.set("q", q.trim());

      const res = await fetch(`${API_BASE}/inventory?${params.toString()}`, {
        headers: adminHeaders,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setError(data.error ?? "Failed to load records.");
        return;
      }

      const data = await res.json() as {
        items: ListItem[];
        total: number;
        page: number;
        limit: number;
      };

      const newItems = append ? (prev: ListItem[]) => [...prev, ...data.items] : () => data.items;
      setTotal(data.total);
      setPage(pageNum);
      setItems(newItems);
      setAllLoaded(data.items.length < PAGE_SIZE || pageNum * PAGE_SIZE >= data.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error — please try again.");
    } finally {
      setLoading(false);
      setLoadingMore(false);
      setRefreshing(false);
      fetchingRef.current = false;
    }
  }, [adminHeaders]);

  useEffect(() => {
    void fetchPage({ pageNum: 1, q: "", append: false });
  // Run once on mount; fetchPage is stable via useCallback
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSearchChange = (text: string) => {
    setSearch(text);
    setAllLoaded(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void fetchPage({ pageNum: 1, q: text, append: false });
    }, 400);
  };

  const handleRefresh = () => {
    setAllLoaded(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    void fetchPage({ pageNum: 1, q: search, append: false, isRefresh: true });
  };

  const handleEndReached = () => {
    if (loadingMore || loading || allLoaded) return;
    void fetchPage({ pageNum: page + 1, q: search, append: true });
  };

  const handleSaved = useCallback((updated: InventoryItem) => {
    setItems(prev => prev.map(it => it.id === updated.id ? { ...it, ...updated } : it));
    setEditItem(prev => prev && prev.id === updated.id ? { ...prev, ...updated } : prev);
  }, []);

  const renderItem = ({ item }: { item: ListItem }) => {
    const vendorLine = item.vendorFullName && item.vendorFullName !== item.vendor
      ? `${item.vendor} · ${item.vendorFullName}`
      : item.vendor;

    return (
      <Pressable
        onPress={() => setEditItem(item)}
        style={({ pressed }) => [
          s.row,
          {
            backgroundColor: pressed ? colors.muted : colors.background,
            borderBottomColor: colors.border,
          },
        ]}
        accessibilityRole="button"
        accessibilityLabel={`Edit ${item.catalog}`}
      >
        <View style={s.rowMain}>
          <View style={s.rowLeft}>
            <Text style={[s.catalog, { color: colors.foreground }]} numberOfLines={1}>
              {item.catalog}
            </Text>
            <Text style={[s.vendor, { color: colors.mutedForeground }]} numberOfLines={1}>
              {vendorLine}
            </Text>
            {item.description ? (
              <Text style={[s.desc, { color: colors.mutedForeground }]} numberOfLines={2}>
                {item.description}
              </Text>
            ) : null}
            {item.binLocations && item.binLocations.length > 0 ? (
              <Text style={[s.bins, { color: colors.primary }]} numberOfLines={1}>
                {item.binLocations.join(", ")}
              </Text>
            ) : null}
          </View>
          <Text style={[s.chevron, { color: colors.mutedForeground }]}>›</Text>
        </View>
      </Pressable>
    );
  };

  return (
    <View style={[s.container, { backgroundColor: colors.background }]}>
      {/* Search bar */}
      <View style={[s.searchBar, { backgroundColor: colors.muted, borderColor: colors.border }]}>
        <Text style={{ color: colors.mutedForeground, marginRight: 6, fontSize: 14 }}>🔍</Text>
        <TextInput
          value={search}
          onChangeText={handleSearchChange}
          placeholder="Search vendor, catalog, description…"
          placeholderTextColor={colors.mutedForeground}
          style={[s.searchInput, { color: colors.foreground }]}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
        {search.length > 0 ? (
          <Pressable
            onPress={() => handleSearchChange("")}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Clear search"
          >
            <Text style={{ color: colors.mutedForeground, fontSize: 16, paddingLeft: 4 }}>✕</Text>
          </Pressable>
        ) : null}
      </View>

      {/* Total count */}
      {total !== null ? (
        <View style={s.countRow}>
          <Text style={[s.countText, { color: colors.mutedForeground }]}>
            {search.trim() ? `${total} matching records` : `${total} total records`}
          </Text>
        </View>
      ) : null}

      {/* Error */}
      {error ? (
        <View style={[s.errorBanner, { backgroundColor: "#ef444422", borderColor: "#ef4444" }]}>
          <Text style={{ color: "#ef4444", fontSize: 13, fontFamily: "Inter_500Medium", flex: 1 }}>
            {error}
          </Text>
          <Pressable onPress={() => setError(null)} style={{ paddingLeft: 8 }}>
            <Text style={{ color: "#ef4444", fontSize: 16 }}>✕</Text>
          </Pressable>
        </View>
      ) : null}

      {/* List */}
      {loading && items.length === 0 ? (
        <View style={s.center}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={[s.loadingText, { color: colors.mutedForeground }]}>Loading records…</Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={item => String(item.id)}
          renderItem={renderItem}
          onEndReached={handleEndReached}
          onEndReachedThreshold={0.3}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
          ListEmptyComponent={() =>
            !loading ? (
              <View style={s.center}>
                <Text style={[s.emptyText, { color: colors.mutedForeground }]}>
                  {search.trim() ? `No records match "${search}"` : "No inventory records found."}
                </Text>
              </View>
            ) : null
          }
          ListFooterComponent={() =>
            loadingMore ? (
              <View style={s.footerLoader}>
                <ActivityIndicator size="small" color={colors.primary} />
              </View>
            ) : allLoaded && items.length > 0 ? (
              <Text style={[s.endText, { color: colors.mutedForeground }]}>
                All {items.length} records loaded
              </Text>
            ) : null
          }
          contentContainerStyle={{ paddingBottom: 80 }}
          keyboardShouldPersistTaps="handled"
        />
      )}

      {/* Edit modal */}
      <RecordEditModal
        item={editItem}
        adminHeaders={adminHeaders}
        onClose={() => setEditItem(null)}
        onSaved={handleSaved}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    margin: 12,
    marginBottom: 0,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    padding: 0,
  },
  countRow: {
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 4,
  },
  countText: { fontSize: 11, fontFamily: "Inter_500Medium" },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    margin: 12,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 48,
    gap: 10,
  },
  loadingText: { fontSize: 14, fontFamily: "Inter_400Regular" },
  emptyText: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center", paddingHorizontal: 24 },
  row: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowMain: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowLeft: { flex: 1, gap: 2 },
  catalog: { fontSize: 14, fontFamily: "Inter_700Bold" },
  vendor: { fontSize: 11, fontFamily: "Inter_500Medium", textTransform: "uppercase", letterSpacing: 0.4 },
  desc: { fontSize: 12, fontFamily: "Inter_400Regular", lineHeight: 17, marginTop: 1 },
  bins: { fontSize: 11, fontFamily: "Inter_600SemiBold", marginTop: 2 },
  chevron: { fontSize: 18, fontFamily: "Inter_400Regular" },
  footerLoader: { paddingVertical: 16, alignItems: "center" },
  endText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    paddingVertical: 16,
  },
});
