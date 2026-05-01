import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Fuse from "fuse.js";
import { useSearchInventory } from "@workspace/api-client-react";
import type { InventoryItem, SearchResult } from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";
import { FilterPanel, type FilterValues } from "@/components/FilterPanel";
import { ResultCard } from "@/components/ResultCard";
import { ReferenceModal } from "@/components/ReferenceModal";
import { KeywordEditor } from "@/components/KeywordEditor";
import { useApp } from "@/contexts/AppContext";

const FUSE_CACHE_KEY = "parts_id_fuse_cache_v2";
const QUERY_CACHE_KEY = "parts_id_query_cache_v1";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

type QueryCacheEntry = { timestamp: number; results: SearchResult[] };
type QueryCache = Record<string, QueryCacheEntry>;

function buildQueryKey(f: FilterValues): string {
  return JSON.stringify(buildSearchBody(f));
}

async function loadQueryCache(): Promise<QueryCache> {
  try {
    const raw = await AsyncStorage.getItem(QUERY_CACHE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as QueryCache;
  } catch { return {}; }
}

async function saveQueryCache(cache: QueryCache): Promise<void> {
  try { await AsyncStorage.setItem(QUERY_CACHE_KEY, JSON.stringify(cache)); } catch {}
}

function pruneExpired(cache: QueryCache): QueryCache {
  const now = Date.now();
  const out: QueryCache = {};
  for (const [k, v] of Object.entries(cache)) {
    if (now - v.timestamp < CACHE_TTL_MS) out[k] = v;
  }
  return out;
}

const DEFAULT_FILTERS: FilterValues = {
  keywords: "",
  catalog: "",
  vendor: "",
  color: "",
  size: "",
  material: "",
  textNumbers: "",
  confidenceThreshold: 50,
  // 16 required chip dimensions
  category: "",
  amperage: "",
  colorChip: "",
  manufacturer: "",
  sizeChip: "",
  rating: "",
  wireType: "",
  wireGauge: "",
  conduitType: "",
  conduitSize: "",
  boxType: "",
  boxGangCount: "",
  mountingType: "",
  environment: "",
  voltage: "",
  poleCount: "",
};

// Build structured search body — chip dimensions passed as separate AND-filter fields
function buildSearchBody(f: FilterValues) {
  return {
    keywords: f.keywords,
    catalog: f.catalog,
    vendor: f.vendor,
    color: f.color,
    size: f.size,
    material: f.material,
    textNumbers: f.textNumbers,
    confidenceThreshold: f.confidenceThreshold,
    // 16 structured chip dimensions
    category: f.category,
    amperage: f.amperage,
    colorChip: f.colorChip,
    manufacturer: f.manufacturer,
    sizeChip: f.sizeChip,
    rating: f.rating,
    wireType: f.wireType,
    wireGauge: f.wireGauge,
    conduitType: f.conduitType,
    conduitSize: f.conduitSize,
    boxType: f.boxType,
    boxGangCount: f.boxGangCount,
    mountingType: f.mountingType,
    environment: f.environment,
    voltage: f.voltage,
    poleCount: f.poleCount,
  };
}

export default function SearchScreen() {
  const colors = useColors();
  const { logout } = useApp();
  const [filters, setFilters] = useState<FilterValues>(DEFAULT_FILTERS);
  const [editItem, setEditItem] = useState<InventoryItem | null>(null);
  const [showFilters, setShowFilters] = useState(true);
  const [offlineResults, setOfflineResults] = useState<SearchResult[] | null>(null);
  const [isOffline, setIsOffline] = useState(false);
  const [offlineCacheType, setOfflineCacheType] = useState<"exact" | "fuse" | null>(null);
  const [showLogoutModal, setShowLogoutModal] = useState(false);
  const [dimensionCounts, setDimensionCounts] = useState<Record<string, Record<string, number>> | undefined>(undefined);
  // Local Fuse index seeded from AsyncStorage cache
  const fuseRef = useRef<Fuse<InventoryItem> | null>(null);
  const fuseItemsRef = useRef<InventoryItem[]>([]);
  // Track latest filters in a ref so the onError closure always reads current values
  const filtersRef = useRef<FilterValues>(filters);
  useEffect(() => { filtersRef.current = filters; }, [filters]);

  // Seed local Fuse index from AsyncStorage on mount
  useEffect(() => {
    AsyncStorage.getItem(FUSE_CACHE_KEY)
      .then(raw => {
        if (!raw) return;
        const items: InventoryItem[] = JSON.parse(raw);
        fuseItemsRef.current = items;
        fuseRef.current = new Fuse(items, {
          keys: [
            { name: "catalog", weight: 0.35 },
            { name: "description", weight: 0.30 },
            { name: "vendor", weight: 0.10 },
            { name: "aiKeywords", weight: 0.25 },
          ],
          threshold: 0.45,
          ignoreLocation: true,
          minMatchCharLength: 2,
          findAllMatches: true,
          includeScore: true,
        });
      })
      .catch(() => {});
  }, []);

  const runFuseSearch = useCallback((kw: string): SearchResult[] => {
    if (!fuseRef.current || !kw.trim()) return [];
    return fuseRef.current
      .search(kw.trim(), { limit: 30 })
      .map((r, index) => ({
        item: r.item,
        confidence: Math.max(0, 1 - (r.score ?? 0.5)),
        matchReason: "offline Fuse match",
        seriesLabel: undefined,
        variants: [],
      }));
  }, []);

  const searchMutation = useSearchInventory({
    mutation: {
      onSuccess: (data) => {
        setIsOffline(false);
        setOfflineResults(null);
        setOfflineCacheType(null);
        setShowFilters(false);
        setDimensionCounts(data.dimensionCounts as Record<string, Record<string, number>> | undefined);

        // Cache all returned items for offline Fuse use
        if (data.results?.length) {
          const newItems = data.results.map(r => r.item);
          // Merge into existing cache — deduplicate by id
          const merged = [...fuseItemsRef.current];
          for (const item of newItems) {
            const idx = merged.findIndex(m => m.id === item.id);
            if (idx >= 0) merged[idx] = item;
            else merged.push(item);
          }
          fuseItemsRef.current = merged;
          fuseRef.current = new Fuse(merged, {
            keys: [
              { name: "catalog", weight: 0.35 },
              { name: "description", weight: 0.30 },
              { name: "vendor", weight: 0.10 },
              { name: "aiKeywords", weight: 0.25 },
            ],
            threshold: 0.45,
            ignoreLocation: true,
            minMatchCharLength: 2,
            findAllMatches: true,
            includeScore: true,
          });
          AsyncStorage.setItem(FUSE_CACHE_KEY, JSON.stringify(merged)).catch(() => {});
        }

        // Cache results keyed by query (with TTL pruning)
        const queryKey = buildQueryKey(filtersRef.current);
        loadQueryCache().then(cache => {
          const pruned = pruneExpired(cache);
          pruned[queryKey] = { timestamp: Date.now(), results: data.results ?? [] };
          saveQueryCache(pruned);
        });
      },
      onError: () => {
        // Server unreachable — try exact query cache first, then Fuse fallback
        const f = filtersRef.current;
        const queryKey = buildQueryKey(f);

        loadQueryCache().then(cache => {
          const pruned = pruneExpired(cache);
          // Persist pruned cache back to storage so expired entries are removed on disk
          if (Object.keys(pruned).length !== Object.keys(cache).length) {
            saveQueryCache(pruned);
          }
          const exactEntry = pruned[queryKey];

          if (exactEntry) {
            setIsOffline(true);
            setOfflineCacheType("exact");
            setOfflineResults(exactEntry.results);
            setShowFilters(false);
            return;
          }

          // No exact cache hit — fall back to Fuse keyword search
          const kw = [
            f.keywords,
            f.catalog,
            f.vendor,
            f.category,
            f.voltage,
            f.amperage,
          ].filter(Boolean).join(" ");
          const fuseHits = runFuseSearch(kw);
          setIsOffline(true);
          setOfflineCacheType("fuse");
          setOfflineResults(fuseHits.length > 0 ? fuseHits : []);
          if (fuseHits.length > 0) setShowFilters(false);
        });
      },
    },
  });

  const handleChange = (key: keyof FilterValues, value: string | number) => {
    setFilters(f => ({ ...f, [key]: value }));
  };

  const handleSearch = () => {
    setOfflineResults(null);
    setIsOffline(false);
    setOfflineCacheType(null);
    const body = buildSearchBody(filters);
    searchMutation.mutate({ data: body });
  };

  const handleClear = () => {
    setFilters(DEFAULT_FILTERS);
    searchMutation.reset();
    setOfflineResults(null);
    setIsOffline(false);
    setOfflineCacheType(null);
    setShowFilters(true);
    setDimensionCounts(undefined);
  };

  // Called by KeywordEditor after debounced save — update local Fuse index immediately
  const handleKeywordsChanged = useCallback((id: number, keywords: string[]) => {
    const items = fuseItemsRef.current.map(item =>
      item.id === id ? { ...item, aiKeywords: keywords } : item,
    );
    fuseItemsRef.current = items;
    fuseRef.current = new Fuse(items, {
      keys: [
        { name: "catalog", weight: 0.35 },
        { name: "description", weight: 0.30 },
        { name: "vendor", weight: 0.10 },
        { name: "aiKeywords", weight: 0.25 },
      ],
      threshold: 0.45,
      ignoreLocation: true,
      minMatchCharLength: 2,
      findAllMatches: true,
      includeScore: true,
    });
    AsyncStorage.setItem(FUSE_CACHE_KEY, JSON.stringify(items)).catch(() => {});
  }, []);

  const results: SearchResult[] = offlineResults ?? (searchMutation.data?.results ?? []);
  const totalMatches = searchMutation.data?.totalMatches ?? 0;
  const belowThreshold = searchMutation.data?.belowThreshold ?? 0;
  const cachedCount = fuseItemsRef.current.length;

  const activeChipCount = [
    filters.category, filters.amperage, filters.colorChip, filters.manufacturer,
    filters.sizeChip, filters.rating, filters.wireType, filters.wireGauge,
    filters.conduitType, filters.conduitSize, filters.boxType, filters.boxGangCount,
    filters.mountingType, filters.environment, filters.voltage, filters.poleCount,
  ].filter(Boolean).length;

  const hasResults = searchMutation.isSuccess || offlineResults !== null;

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>⚡ Parts ID</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 }}>
            {/* Explicit Ready / Empty loaded status */}
            <View style={[
              styles.statusBadge,
              { backgroundColor: cachedCount > 0 ? colors.primary + "18" : colors.muted },
            ]}>
              <Text style={[
                styles.statusBadgeText,
                { color: cachedCount > 0 ? colors.primary : colors.mutedForeground },
              ]}>
                {cachedCount > 0 ? `✓ Ready · ${cachedCount} items` : "⊘ Empty · no items loaded"}
              </Text>
            </View>
            {isOffline ? (
              <View style={[styles.offlineBadge, { backgroundColor: colors.warning + "22" }]}>
                <Text style={[styles.offlineBadgeText, { color: colors.warning }]}>OFFLINE</Text>
              </View>
            ) : null}
          </View>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Pressable
            onPress={() => setShowFilters(!showFilters)}
            style={[styles.filterToggle, {
              backgroundColor: showFilters ? colors.primary : colors.muted,
              borderColor: activeChipCount > 0 ? colors.primary : colors.border,
            }]}
          >
            <Text style={[styles.filterToggleText, { color: showFilters ? colors.primaryForeground : colors.foreground }]}>
              {showFilters ? "▼ Filters" : `▲ Filters${activeChipCount > 0 ? ` (${activeChipCount})` : ""}`}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setShowLogoutModal(true)}
            style={[styles.logoutBtn, { backgroundColor: colors.muted, borderColor: colors.border }]}
          >
            <Text style={[styles.logoutBtnText, { color: colors.mutedForeground }]}>⎋</Text>
          </Pressable>
        </View>
      </View>

      {/* Logout confirmation modal */}
      <Modal visible={showLogoutModal} transparent animationType="fade" onRequestClose={() => setShowLogoutModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.logoutModal, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.logoutModalTitle, { color: colors.foreground }]}>Sign Out</Text>
            <Text style={[styles.logoutModalHint, { color: colors.mutedForeground }]}>
              You will be returned to the password screen.
            </Text>
            <View style={styles.logoutModalBtns}>
              <Pressable
                onPress={() => setShowLogoutModal(false)}
                style={[styles.logoutModalCancel, { borderColor: colors.border, backgroundColor: colors.muted }]}
              >
                <Text style={[styles.logoutModalCancelText, { color: colors.foreground }]}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => { setShowLogoutModal(false); logout(); }}
                style={[styles.logoutModalConfirm, { backgroundColor: colors.destructive }]}
              >
                <Text style={[styles.logoutModalConfirmText, { color: "#fff" }]}>Sign Out</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Offline banner */}
      {isOffline ? (
        <View style={[styles.offlineBanner, { backgroundColor: colors.warning + "15", borderBottomColor: colors.warning + "44" }]}>
          <Text style={[styles.offlineBannerText, { color: colors.warning }]}>
            {offlineCacheType === "exact"
              ? "Offline — showing cached results"
              : `Offline — showing ${cachedCount} cached items via local search`}
          </Text>
        </View>
      ) : null}

      <FlatList
        data={results}
        keyExtractor={item => String(item.item.id)}
        ListHeaderComponent={() => (
          <View>
            {/* Filter panel */}
            {showFilters ? (
              <View style={[styles.filterCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <FilterPanel
                  values={filters}
                  onChange={handleChange}
                  onSearch={handleSearch}
                  onClear={handleClear}
                  isLoading={searchMutation.isPending}
                  resultCount={searchMutation.isSuccess ? results.length : undefined}
                  dimensionCounts={dimensionCounts}
                />
              </View>
            ) : null}

            {/* Results header */}
            {hasResults ? (
              <View>
                <View style={styles.resultsHeader}>
                  <Text style={[styles.resultsCount, { color: colors.foreground }]}>
                    {results.length} {isOffline ? "offline" : ""} match{results.length !== 1 ? "es" : ""} found
                  </Text>
                  {!showFilters ? (
                    <Pressable
                      onPress={handleClear}
                      style={[styles.newSearchBtn, { borderColor: colors.border }]}
                    >
                      <Text style={[styles.newSearchText, { color: colors.primary }]}>New Search</Text>
                    </Pressable>
                  ) : null}
                </View>
                {/* Actionable "more matches below threshold" banner */}
                {!isOffline && belowThreshold > 0 && (
                  <Pressable
                    onPress={() => {
                      const lower = Math.max(0, filters.confidenceThreshold - 20);
                      handleChange("confidenceThreshold", lower);
                      setTimeout(handleSearch, 50);
                    }}
                    style={[styles.belowThresholdBanner, {
                      backgroundColor: colors.warning + "18",
                      borderColor: colors.warning + "55",
                    }]}
                  >
                    <Text style={[styles.belowThresholdBannerText, { color: colors.warning }]}>
                      {belowThreshold} more match{belowThreshold !== 1 ? "es" : ""} available at{" "}
                      {Math.max(0, filters.confidenceThreshold - 20)}% — tap to lower threshold
                    </Text>
                  </Pressable>
                )}
              </View>
            ) : null}

            {/* Loading */}
            {searchMutation.isPending ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color={colors.primary} />
                <Text style={[styles.loadingText, { color: colors.mutedForeground }]}>
                  Searching dictionaries…
                </Text>
              </View>
            ) : null}

            {/* Error: server failed + no offline cache */}
            {searchMutation.isError && !isOffline ? (
              <View style={[styles.errorCard, { backgroundColor: colors.destructive + "11", borderColor: colors.destructive + "44" }]}>
                <Text style={[styles.errorText, { color: colors.destructive }]}>
                  Search failed. Check your connection and try again.
                </Text>
              </View>
            ) : null}
            {isOffline && offlineResults !== null && offlineResults.length === 0 ? (
              <View style={[styles.errorCard, { backgroundColor: colors.warning + "11", borderColor: colors.warning + "44" }]}>
                <Text style={[styles.errorText, { color: colors.warning }]}>
                  Offline — no cached items match your search. Connect to load more results.
                </Text>
              </View>
            ) : null}

            {/* Empty state */}
            {hasResults && results.length === 0 && !isOffline ? (
              <View style={styles.emptyContainer}>
                <Text style={styles.emptyEmoji}>🔍</Text>
                <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No Results Found</Text>
                <Text style={[styles.emptyHint, { color: colors.mutedForeground }]}>
                  Try broader terms, check spelling, or lower the confidence threshold.
                </Text>
                {belowThreshold > 0 ? (
                  <Pressable
                    onPress={() => {
                      const lower = Math.max(0, filters.confidenceThreshold - 20);
                      handleChange("confidenceThreshold", lower);
                      setTimeout(handleSearch, 50);
                    }}
                    style={[styles.lowerThresholdBtn, {
                      backgroundColor: colors.warning + "18",
                      borderColor: colors.warning + "55",
                    }]}
                  >
                    <Text style={[styles.lowerThresholdBtnText, { color: colors.warning }]}>
                      {belowThreshold} match{belowThreshold !== 1 ? "es" : ""} at lower confidence —{"\n"}
                      Tap to search at {Math.max(0, filters.confidenceThreshold - 20)}%
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}

            {/* Welcome state */}
            {!hasResults && !searchMutation.isPending ? (
              <View style={styles.welcomeContainer}>
                <Text style={styles.welcomeEmoji}>⚡</Text>
                <Text style={[styles.welcomeTitle, { color: colors.foreground }]}>
                  Search Electrical Parts
                </Text>
                <Text style={[styles.welcomeHint, { color: colors.mutedForeground }]}>
                  Search by keywords, catalog #, vendor, or use the 16-dimension filter chips below. Handles abbreviations, synonyms, and misspellings automatically.
                </Text>
                <View style={[styles.tipCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <Text style={[styles.tipTitle, { color: colors.foreground }]}>💡 Quick Tips</Text>
                  {[
                    "Type '20a duplex white' for white 20A outlet",
                    "Type 'BR120' for Eaton BR 20A breaker",
                    "Type '3/4 emt' for 3/4\" EMT conduit fittings",
                    "Select chips to narrow by voltage, amperage, part type…",
                    "Use Photo ID tab to identify parts by camera",
                  ].map((tip, i) => (
                    <Text key={i} style={[styles.tipText, { color: colors.mutedForeground }]}>
                      • {tip}
                    </Text>
                  ))}
                </View>
              </View>
            ) : null}
          </View>
        )}
        renderItem={({ item: result, index }) => (
          <View style={styles.resultItem}>
            <ResultCard result={result} onEditKeywords={setEditItem} rank={index} />
          </View>
        )}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      />

      <ReferenceModal />

      <KeywordEditor
        item={editItem}
        onClose={() => setEditItem(null)}
        onKeywordsChanged={handleKeywordsChanged}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  headerTitle: { fontSize: 20, fontFamily: "Inter_700Bold" },
  statusBadge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 5 },
  statusBadgeText: { fontSize: 11, fontFamily: "Inter_500Medium" },
  offlineBadge: { paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4 },
  offlineBadgeText: { fontSize: 9, fontFamily: "Inter_700Bold", letterSpacing: 0.5 },
  offlineBanner: { paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: 1 },
  offlineBannerText: { fontSize: 12, fontFamily: "Inter_500Medium" },
  logoutBtn: { width: 34, height: 34, borderRadius: 8, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  logoutBtnText: { fontSize: 16 },
  modalOverlay: { flex: 1, backgroundColor: "#00000055", alignItems: "center", justifyContent: "center", padding: 32 },
  logoutModal: { width: "100%", borderRadius: 14, borderWidth: 1, padding: 24 },
  logoutModalTitle: { fontSize: 18, fontFamily: "Inter_700Bold", marginBottom: 8 },
  logoutModalHint: { fontSize: 14, fontFamily: "Inter_400Regular", lineHeight: 20, marginBottom: 20 },
  logoutModalBtns: { flexDirection: "row", gap: 10 },
  logoutModalCancel: { flex: 1, borderWidth: 1, borderRadius: 8, paddingVertical: 12, alignItems: "center" },
  logoutModalCancelText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  logoutModalConfirm: { flex: 1, borderRadius: 8, paddingVertical: 12, alignItems: "center" },
  logoutModalConfirmText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  filterToggle: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  filterToggleText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  filterCard: {
    margin: 12,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
  },
  resultsHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  resultsCount: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  belowThresholdBanner: {
    marginHorizontal: 16, marginBottom: 4, padding: 10,
    borderRadius: 8, borderWidth: 1,
  },
  belowThresholdBannerText: { fontSize: 13, fontFamily: "Inter_500Medium", textAlign: "center" },
  lowerThresholdBtn: {
    marginTop: 12, paddingHorizontal: 20, paddingVertical: 12,
    borderRadius: 10, borderWidth: 1, alignItems: "center",
  },
  lowerThresholdBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold", textAlign: "center", lineHeight: 22 },
  newSearchBtn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  newSearchText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  loadingContainer: { alignItems: "center", padding: 40, gap: 12 },
  loadingText: { fontSize: 14, fontFamily: "Inter_400Regular" },
  errorCard: { margin: 16, padding: 16, borderRadius: 8, borderWidth: 1 },
  errorText: { fontSize: 14, fontFamily: "Inter_500Medium" },
  emptyContainer: { alignItems: "center", padding: 40 },
  emptyEmoji: { fontSize: 48, marginBottom: 12 },
  emptyTitle: { fontSize: 18, fontFamily: "Inter_700Bold", marginBottom: 8 },
  emptyHint: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20, marginBottom: 8 },
  welcomeContainer: { padding: 24, alignItems: "center" },
  welcomeEmoji: { fontSize: 48, marginBottom: 12 },
  welcomeTitle: { fontSize: 20, fontFamily: "Inter_700Bold", marginBottom: 8 },
  welcomeHint: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20, marginBottom: 20 },
  tipCard: { width: "100%", padding: 16, borderRadius: 8, borderWidth: 1 },
  tipTitle: { fontSize: 14, fontFamily: "Inter_600SemiBold", marginBottom: 8 },
  tipText: { fontSize: 13, fontFamily: "Inter_400Regular", marginBottom: 4, lineHeight: 18 },
  resultItem: { paddingHorizontal: 12 },
  listContent: { paddingBottom: 120 },
});
