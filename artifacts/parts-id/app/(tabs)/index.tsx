import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
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
import { Feather } from "@expo/vector-icons";

const FUSE_CACHE_KEY = "parts_id_fuse_cache_v2";
const QUERY_CACHE_KEY = "parts_id_query_cache_v1";
const SETTINGS_KEY = "parts_id_settings_v1";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : "http://localhost:8080/api";

type TextSize = "small" | "normal" | "large";
type AppSettings = { defaultFiltersOpen: boolean; textSize: TextSize; defaultConfidenceThreshold: number };
const DEFAULT_SETTINGS: AppSettings = { defaultFiltersOpen: true, textSize: "normal", defaultConfidenceThreshold: 50 };

async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } as AppSettings;
  } catch { return DEFAULT_SETTINGS; }
}

async function saveSettings(s: AppSettings): Promise<void> {
  try { await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
}

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
  const { logout, clearCache } = useApp();
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [filters, setFilters] = useState<FilterValues>(DEFAULT_FILTERS);
  const [editItem, setEditItem] = useState<InventoryItem | null>(null);
  // Start hidden so settings load completes before the filter panel is shown,
  // preventing a flicker when the user has defaultFiltersOpen=false saved.
  const [showFilters, setShowFilters] = useState(false);
  const [offlineResults, setOfflineResults] = useState<SearchResult[] | null>(null);
  const [isOffline, setIsOffline] = useState(false);
  const [offlineCacheType, setOfflineCacheType] = useState<"exact" | "fuse" | null>(null);
  const [showLogoutModal, setShowLogoutModal] = useState(false);
  const [cacheClearedMsg, setCacheClearedMsg] = useState<string | null>(null);
  const [dimensionCounts, setDimensionCounts] = useState<Record<string, Record<string, number>> | undefined>(undefined);
  // Local Fuse index seeded from AsyncStorage cache
  const fuseRef = useRef<Fuse<InventoryItem> | null>(null);
  const fuseItemsRef = useRef<InventoryItem[]>([]);
  const [cachedCount, setCachedCount] = useState(0);
  const [syncProgress, setSyncProgress] = useState<{ loaded: number; total: number } | null>(null);
  // Track latest filters in a ref so the onError closure always reads current values
  const filtersRef = useRef<FilterValues>(filters);
  useEffect(() => { filtersRef.current = filters; }, [filters]);

  // Load persisted settings and apply on mount
  useEffect(() => {
    loadSettings().then(s => {
      setSettings(s);
      setShowFilters(s.defaultFiltersOpen);
      setFilters(f => ({ ...f, confidenceThreshold: s.defaultConfidenceThreshold }));
    });
  }, []);

  const buildFuseIndex = useCallback((items: InventoryItem[]) => {
    fuseItemsRef.current = items;
    setCachedCount(items.length);
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
  }, []);

  // Fetch all inventory items in pages and build the Fuse cache
  const syncAllInventory = useCallback(async () => {
    const PAGE_SIZE = 500;
    let page = 1;
    let total = 0;
    const allItems: InventoryItem[] = [];
    try {
      do {
        const res = await fetch(`${API_BASE}/inventory?page=${page}&limit=${PAGE_SIZE}`);
        if (!res.ok) return;
        const data: { items: InventoryItem[]; total: number } = await res.json();
        total = data.total;
        allItems.push(...data.items);
        setSyncProgress({ loaded: allItems.length, total });
        page++;
      } while (allItems.length < total);
      buildFuseIndex(allItems);
      await AsyncStorage.setItem(FUSE_CACHE_KEY, JSON.stringify(allItems));
    } catch {
      // Silently fail — app still works online; retry on next launch
    } finally {
      setSyncProgress(null);
    }
  }, [buildFuseIndex]);

  // Seed local Fuse index from AsyncStorage on mount; sync from API if cache is empty
  useEffect(() => {
    AsyncStorage.getItem(FUSE_CACHE_KEY)
      .then(raw => {
        if (!raw) {
          // Cache empty — fetch all inventory in background
          syncAllInventory();
          return;
        }
        const items: InventoryItem[] = JSON.parse(raw);
        buildFuseIndex(items);
      })
      .catch(() => {
        syncAllInventory();
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
          buildFuseIndex(merged);
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
    setFilters({ ...DEFAULT_FILTERS, confidenceThreshold: settings.defaultConfidenceThreshold });
    searchMutation.reset();
    setOfflineResults(null);
    setIsOffline(false);
    setOfflineCacheType(null);
    setShowFilters(settings.defaultFiltersOpen);
    setDimensionCounts(undefined);
  };

  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    saveSettings(next);
    if (key === "defaultFiltersOpen") setShowFilters(value as boolean);
    if (key === "defaultConfidenceThreshold") setFilters(f => ({ ...f, confidenceThreshold: value as number }));
  };

  const textFontScale = settings.textSize === "small" ? 0.85 : settings.textSize === "large" ? 1.18 : 1.0;

  // Called by KeywordEditor after debounced save — update local Fuse index immediately
  const handleKeywordsChanged = useCallback((id: number, keywords: string[]) => {
    const items = fuseItemsRef.current.map(item =>
      item.id === id ? { ...item, aiKeywords: keywords } : item,
    );
    buildFuseIndex(items);
    AsyncStorage.setItem(FUSE_CACHE_KEY, JSON.stringify(items)).catch(() => {});
  }, [buildFuseIndex]);

  const results: SearchResult[] = offlineResults ?? (searchMutation.data?.results ?? []);
  const totalMatches = searchMutation.data?.totalMatches ?? 0;
  const belowThreshold = searchMutation.data?.belowThreshold ?? 0;
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
            {/* Sync progress — while fetching all inventory for offline cache */}
            {syncProgress ? (
              <View style={[styles.statusBadge, { backgroundColor: colors.muted }]}>
                <ActivityIndicator size={10} color={colors.mutedForeground} style={{ marginRight: 4 }} />
                <Text style={[styles.statusBadgeText, { color: colors.mutedForeground }]}>
                  {`Syncing ${syncProgress.loaded} / ${syncProgress.total}`}
                </Text>
              </View>
            ) : cachedCount > 0 ? (
              <View style={[styles.statusBadge, { backgroundColor: colors.primary + "18" }]}>
                <Text style={[styles.statusBadgeText, { color: colors.primary }]}>
                  {`✓ Ready · ${cachedCount} items`}
                </Text>
              </View>
            ) : null}
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
            style={[styles.headerBtn, styles.filterToggle, {
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
            style={[styles.headerBtn, styles.logoutBtn, { backgroundColor: colors.muted, borderColor: colors.border }]}
          >
            <Feather name="log-out" size={16} color={colors.mutedForeground} />
            <Text style={[styles.logoutBtnLabel, { color: colors.mutedForeground }]}>Settings</Text>
          </Pressable>
        </View>
      </View>

      {/* Settings modal (logout + cache clear) */}
      <Modal
        visible={showLogoutModal}
        transparent
        animationType="fade"
        onRequestClose={() => { setShowLogoutModal(false); setCacheClearedMsg(null); }}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.logoutModal, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.logoutModalTitle, { color: colors.foreground }]}>Settings</Text>

            {/* Clear cache row */}
            <View style={[styles.settingsRow, { borderColor: colors.border }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.settingsRowLabel, { color: colors.foreground }]}>Search cache</Text>
                <Text style={[styles.settingsRowHint, { color: colors.mutedForeground }]}>
                  Clears locally stored search results. Useful when inventory changes.
                </Text>
                {cacheClearedMsg ? (
                  <Text style={[styles.settingsRowSuccess, { color: colors.success }]}>{cacheClearedMsg}</Text>
                ) : null}
              </View>
              <Pressable
                onPress={async () => {
                  await clearCache();
                  // Reset in-memory Fuse pool so "Ready · N items" badge
                  // drops to zero immediately without waiting for next load
                  fuseRef.current = null;
                  fuseItemsRef.current = [];
                  setCachedCount(0);
                  setOfflineResults(null);
                  setCacheClearedMsg("✓ Cache cleared — resyncing…");
                  syncAllInventory().then(() => {
                    setCacheClearedMsg(null);
                  });
                }}
                style={[styles.clearCacheBtn, { backgroundColor: colors.muted, borderColor: colors.border }]}
              >
                <Text style={[styles.clearCacheBtnText, { color: colors.foreground }]}>Clear</Text>
              </Pressable>
            </View>

            {/* Filters open by default row */}
            <View style={[styles.settingsRow, { borderColor: colors.border }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.settingsRowLabel, { color: colors.foreground }]}>Filters open by default</Text>
                <Text style={[styles.settingsRowHint, { color: colors.mutedForeground }]}>
                  Show the filter panel automatically when you open the app.
                </Text>
              </View>
              <Switch
                value={settings.defaultFiltersOpen}
                onValueChange={v => updateSetting("defaultFiltersOpen", v)}
                trackColor={{ false: colors.border, true: colors.primary }}
                thumbColor="#fff"
              />
            </View>

            {/* Text size row */}
            <View style={[styles.settingsRow, { borderColor: colors.border }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.settingsRowLabel, { color: colors.foreground }]}>Text size</Text>
                <Text style={[styles.settingsRowHint, { color: colors.mutedForeground }]}>
                  Adjust how large result text appears.
                </Text>
              </View>
              <View style={styles.textSizePicker}>
                {(["small", "normal", "large"] as TextSize[]).map(sz => (
                  <Pressable
                    key={sz}
                    onPress={() => updateSetting("textSize", sz)}
                    style={[
                      styles.textSizeBtn,
                      {
                        backgroundColor: settings.textSize === sz ? colors.primary : colors.muted,
                        borderColor: settings.textSize === sz ? colors.primary : colors.border,
                      },
                    ]}
                  >
                    <Text style={[
                      styles.textSizeBtnLabel,
                      { color: settings.textSize === sz ? colors.primaryForeground : colors.foreground },
                    ]}>
                      {sz === "small" ? "S" : sz === "large" ? "L" : "M"}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {/* Default confidence threshold row */}
            <View style={[styles.settingsRow, { borderColor: colors.border, flexDirection: "column", gap: 8 }]}>
              <Text style={[styles.settingsRowLabel, { color: colors.foreground }]}>Default min confidence</Text>
              <Text style={[styles.settingsRowHint, { color: colors.mutedForeground }]}>
                Pre-fills the confidence slider on each new search.
              </Text>
              <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
                {([0, 30, 50, 70, 90] as number[]).map(pct => (
                  <Pressable
                    key={pct}
                    onPress={() => updateSetting("defaultConfidenceThreshold", pct)}
                    style={[
                      styles.textSizeBtn,
                      {
                        backgroundColor: settings.defaultConfidenceThreshold === pct ? colors.primary : colors.muted,
                        borderColor: settings.defaultConfidenceThreshold === pct ? colors.primary : colors.border,
                        width: 50,
                      },
                    ]}
                  >
                    <Text style={[
                      styles.textSizeBtnLabel,
                      { color: settings.defaultConfidenceThreshold === pct ? colors.primaryForeground : colors.foreground, fontSize: 12 },
                    ]}>
                      {pct === 0 ? "All" : `${pct}%`}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {/* Sign out row */}
            <Text style={[styles.logoutModalHint, { color: colors.mutedForeground, marginTop: 16 }]}>
              Sign out to return to the password screen.
            </Text>
            <View style={styles.logoutModalBtns}>
              <Pressable
                onPress={() => { setShowLogoutModal(false); setCacheClearedMsg(null); }}
                style={[styles.logoutModalCancel, { borderColor: colors.border, backgroundColor: colors.muted }]}
              >
                <Text style={[styles.logoutModalCancelText, { color: colors.foreground }]}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => { setShowLogoutModal(false); setCacheClearedMsg(null); logout(); }}
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

      {/* Filter panel — stable view outside FlatList to prevent TextInput remount on every render */}
      {showFilters ? (
        <ScrollView
          style={{ maxHeight: "62%" }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
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
        </ScrollView>
      ) : null}

      <FlatList
        data={results}
        keyExtractor={item => String(item.item.id)}
        ListHeaderComponent={() => (
          <View>
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
            <ResultCard result={result} onEditKeywords={setEditItem} rank={index} fontScale={textFontScale} />
          </View>
        )}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="none"
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
  statusBadge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 5, flexDirection: "row", alignItems: "center" },
  statusBadgeText: { fontSize: 11, fontFamily: "Inter_500Medium" },
  offlineBadge: { paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4 },
  offlineBadgeText: { fontSize: 9, fontFamily: "Inter_700Bold", letterSpacing: 0.5 },
  offlineBanner: { paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: 1 },
  offlineBannerText: { fontSize: 12, fontFamily: "Inter_500Medium" },
  headerBtn: { height: 44, borderRadius: 8, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  logoutBtn: { width: 48, flexDirection: "column", gap: 2, paddingVertical: 4 },
  logoutBtnLabel: { fontSize: 9, fontFamily: "Inter_500Medium", letterSpacing: 0.2 },
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
    paddingHorizontal: 12,
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
  settingsRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  settingsRowLabel: { fontSize: 14, fontFamily: "Inter_600SemiBold", marginBottom: 2 },
  settingsRowHint: { fontSize: 12, fontFamily: "Inter_400Regular", lineHeight: 17 },
  settingsRowSuccess: { fontSize: 12, fontFamily: "Inter_500Medium", marginTop: 4 },
  clearCacheBtn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8, alignSelf: "center" },
  clearCacheBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  textSizePicker: { flexDirection: "row", gap: 6, alignSelf: "center" },
  textSizeBtn: { width: 34, height: 34, borderRadius: 8, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  textSizeBtnLabel: { fontSize: 13, fontFamily: "Inter_700Bold" },
});
