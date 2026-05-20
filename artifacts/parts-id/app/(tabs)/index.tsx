import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Fuse from "fuse.js";
import { useSearchInventory } from "@workspace/api-client-react";
import type { InventoryItem, SearchResult } from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";
import { FilterPanel, ConfidenceSlider, type FilterValues } from "@/components/FilterPanel";
import { ResultCard } from "@/components/ResultCard";
import { ReferenceModal } from "@/components/ReferenceModal";
import { KeywordEditor } from "@/components/KeywordEditor";
import { BinEditor } from "@/components/BinEditor";
import { BarcodeEditor } from "@/components/BarcodeEditor";
import { PartDetailsEditor } from "@/components/PartDetailsEditor";
import { useApp, DEFAULT_SETTINGS, type TextSize, type ThemeMode } from "@/contexts/AppContext";
import { Feather } from "@expo/vector-icons";
import { secondaryBtnBase } from "@/styles/shared";
import { reportStorageError } from "@/utils/storageErrorReporter";
import { retryAsync } from "@/utils/retryAsync";
import { evictLRU, QUERY_CACHE_MAX_ENTRIES } from "@/utils/queryCacheBound";
import { BrowseByAisle } from "@/components/BrowseByAisle";
import { BrowseByCategory } from "@/components/BrowseByCategory";
import { AddPartModal } from "@/components/AddPartModal";
import { FUSE_CACHE_KEY, FUSE_CACHE_SYNCED_AT_KEY, getFuseCacheSyncedAt } from "@/utils/offlineBarcode";

// Trigger a background full sync if the cache is older than this. The full
// sync replaces the cache with the authoritative server list, naturally pruning
// items deleted server-side since the last sync.
const FUSE_SYNC_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

const QUERY_CACHE_KEY = "parts_id_query_cache_v1";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : "http://localhost:8080/api";


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
  // Bound the cache so a long session of unique searches can't grow it without
  // limit. Evict by LRU (oldest timestamp first) before persisting.
  const bounded = evictLRU(cache, QUERY_CACHE_MAX_ENTRIES);
  try {
    await AsyncStorage.setItem(QUERY_CACHE_KEY, JSON.stringify(bounded));
  } catch (err) {
    reportStorageError("Could not save offline search cache", err);
  }
}

function formatRelativeAge(ts: number): string {
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "Last updated just now";
  if (mins < 60) return `Last updated ${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `Last updated ${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  return `Last updated ${days} day${days === 1 ? "" : "s"} ago`;
}

async function readNewestCacheTimestamp(): Promise<string> {
  try {
    const raw = await AsyncStorage.getItem(QUERY_CACHE_KEY);
    if (!raw) return "No cached data";
    const cache = JSON.parse(raw) as QueryCache;
    const entries = Object.values(cache);
    if (entries.length === 0) return "No cached data";
    const newest = Math.max(...entries.map(e => e.timestamp));
    return formatRelativeAge(newest);
  } catch {
    return "No cached data";
  }
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
function buildSearchBody(f: FilterValues, categorySlug?: string | null) {
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
    ...(categorySlug ? { categorySlug } : {}),
  };
}

export default function SearchScreen() {
  const colors = useColors();
  const { logout, clearCache, settings, updateSetting, textFontScale, isLoading: settingsLoading, isAdmin, adminToken, registerLogoutHandler } = useApp();
  const [filters, setFilters] = useState<FilterValues>(DEFAULT_FILTERS);
  type SearchMode = "search" | "aisle" | "category";
  const [mode, setMode] = useState<SearchMode>("search");
  const [activeCategorySlug, setActiveCategorySlug] = useState<string | null>(null);
  const [activeCategoryLabel, setActiveCategoryLabel] = useState<string | null>(null);
  const activeCategorySlugRef = useRef<string | null>(null);
  useEffect(() => { activeCategorySlugRef.current = activeCategorySlug; }, [activeCategorySlug]);
  const [showAddPartModal, setShowAddPartModal] = useState(false);
  const [detailsItem, setDetailsItem] = useState<InventoryItem | null>(null);
  const [editItem, setEditItem] = useState<InventoryItem | null>(null);
  const [binEditItem, setBinEditItem] = useState<InventoryItem | null>(null);
  const [barcodeEditItem, setBarcodeEditItem] = useState<InventoryItem | null>(null);
  // Local override of bin lists keyed by item.id, applied on top of whatever
  // results are currently displayed (online searchMutation.data, offlineResults,
  // or Fuse fallback). Lets bin edits show up immediately without a re-search.
  const [binOverrides, setBinOverrides] = useState<Record<number, string[]>>({});
  const [offlineResults, setOfflineResults] = useState<SearchResult[] | null>(null);
  // Local string state for the custom threshold TextInput in Settings
  const [confThresholdInput, setConfThresholdInput] = useState(String(DEFAULT_SETTINGS.defaultConfidenceThreshold));
  const [isOffline, setIsOffline] = useState(false);
  const [offlineCacheType, setOfflineCacheType] = useState<"exact" | "fuse" | null>(null);
  const [showLogoutModal, setShowLogoutModal] = useState(false);
  const [cacheClearedMsg, setCacheClearedMsg] = useState<string | null>(null);
  const [cacheAge, setCacheAge] = useState<string | null>(null);
  const [showReference, setShowReference] = useState(false);
  const [dimensionCounts, setDimensionCounts] = useState<Record<string, Record<string, number>> | undefined>(undefined);
  // Local Fuse index seeded from AsyncStorage cache
  const fuseRef = useRef<Fuse<InventoryItem> | null>(null);
  const fuseItemsRef = useRef<InventoryItem[]>([]);
  const [cachedCount, setCachedCount] = useState(0);
  const [syncProgress, setSyncProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [syncError, setSyncError] = useState(false);
  const [syncRetryPending, setSyncRetryPending] = useState(false);
  const syncRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncRetryAttemptRef = useRef(0);
  // Track latest filters in a ref so the onError closure always reads current values
  const filtersRef = useRef<FilterValues>(filters);
  useEffect(() => { filtersRef.current = filters; }, [filters]);
  // Timeout + abort tracking for slow-connection fallback
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchAbortedRef = useRef(false);
  // Ref to the current searchMutation so the logout handler can call .reset()
  // without going through a stale closure.
  const searchMutationRef = useRef<{ reset: () => void } | null>(null);
  // Ref to the latest settings so callbacks (notably the logout handler)
  // always read the current default confidence threshold instead of the value
  // captured the first time the effect ran.
  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  // Keep the Settings modal text input in sync with the slider / persisted value.
  // This runs on every settings change so the input always reflects what was saved.
  useEffect(() => {
    setConfThresholdInput(String(settings.defaultConfidenceThreshold));
  }, [settings.defaultConfidenceThreshold]);

  // Apply the persisted default confidence threshold to the active search
  // filters whenever it changes in Settings (and once after settings finish
  // loading from AsyncStorage). This keeps the slider in sync so the user
  // doesn't see stale values after editing the default.
  useEffect(() => {
    if (settingsLoading) return;
    setFilters(f =>
      f.confidenceThreshold === settings.defaultConfidenceThreshold
        ? f
        : { ...f, confidenceThreshold: settings.defaultConfidenceThreshold },
    );
  }, [settingsLoading, settings.defaultConfidenceThreshold]);

  // Reset all in-memory search state on logout so the next login starts clean.
  useEffect(() => {
    return registerLogoutHandler(() => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
        searchTimeoutRef.current = null;
      }
      searchAbortedRef.current = false;
      setMode("search");
      setActiveCategorySlug(null);
      setActiveCategoryLabel(null);
      activeCategorySlugRef.current = null;
      setFilters({ ...DEFAULT_FILTERS, confidenceThreshold: settingsRef.current.defaultConfidenceThreshold });
      setEditItem(null);
      setBinEditItem(null);
      setBinOverrides({});
      setOfflineResults(null);
      setIsOffline(false);
      setOfflineCacheType(null);
      setDimensionCounts(undefined);
      searchMutationRef.current?.reset();
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerLogoutHandler]);

  const buildFuseIndex = useCallback((items: InventoryItem[]) => {
    fuseItemsRef.current = items;
    setCachedCount(items.length);
    fuseRef.current = new Fuse(items, {
      keys: [
        { name: "catalog", weight: 0.35 },
        { name: "description", weight: 0.30 },
        { name: "vendor", weight: 0.10 },
        { name: "aiKeywords", weight: 0.25 },
        { name: "barcodes", weight: 0.00 },
      ],
      threshold: 0.45,
      ignoreLocation: true,
      minMatchCharLength: 2,
      findAllMatches: true,
      includeScore: true,
    });
  }, []);

  // Auto-retry constants
  const SYNC_RETRY_INITIAL_MS = 30_000;   // 30 s first retry
  const SYNC_RETRY_MAX_MS     = 300_000;  // 5 min ceiling

  // Fetch all inventory items in pages and build the Fuse cache
  const syncAllInventory = useCallback(async () => {
    // Cancel any pending auto-retry before starting a new attempt
    if (syncRetryTimerRef.current !== null) {
      clearTimeout(syncRetryTimerRef.current);
      syncRetryTimerRef.current = null;
    }
    setSyncError(false);
    setSyncRetryPending(false);
    const PAGE_SIZE = 500;
    let page = 1;
    let total = 0;
    const allItems: InventoryItem[] = [];
    try {
      do {
        const data: { items: InventoryItem[]; total: number } = await retryAsync(async () => {
          const res = await fetch(`${API_BASE}/inventory?page=${page}&limit=${PAGE_SIZE}`);
          if (!res.ok) throw new Error(`Sync failed: ${res.status}`);
          return res.json();
        });
        // Guard: if the page returned zero items, the server total may be inconsistent —
        // stop looping to prevent an infinite loop.
        if (data.items.length === 0) break;
        total = data.total;
        allItems.push(...data.items);
        setSyncProgress({ loaded: allItems.length, total });
        page++;
      } while (allItems.length < total);
      buildFuseIndex(allItems);
      syncRetryAttemptRef.current = 0; // success — reset backoff counter
      try {
        await AsyncStorage.setItem(FUSE_CACHE_KEY, JSON.stringify(allItems));
        // Record when this authoritative full sync completed. The mount effect
        // uses this to trigger a background re-sync when the cache is stale,
        // which prunes items deleted server-side since the last sync.
        await AsyncStorage.setItem(FUSE_CACHE_SYNCED_AT_KEY, String(Date.now()));
      } catch (err) {
        reportStorageError("Could not save offline inventory cache", err);
      }
    } catch {
      setSyncError(true);
      // Schedule an automatic retry with exponential backoff (30 s → doubles → 5 min cap)
      const delay = Math.min(
        SYNC_RETRY_INITIAL_MS * Math.pow(2, syncRetryAttemptRef.current),
        SYNC_RETRY_MAX_MS,
      );
      syncRetryAttemptRef.current += 1;
      setSyncRetryPending(true);
      syncRetryTimerRef.current = setTimeout(() => {
        syncRetryTimerRef.current = null;
        syncAllInventory();
      }, delay);
    } finally {
      setSyncProgress(null);
    }
  }, [buildFuseIndex]);

  // Cancel pending auto-retry timer on unmount to prevent state updates
  // after the component is destroyed (e.g. user logs out mid-countdown).
  useEffect(() => {
    return () => {
      if (syncRetryTimerRef.current !== null) {
        clearTimeout(syncRetryTimerRef.current);
        syncRetryTimerRef.current = null;
      }
    };
  }, []);

  // Seed local Fuse index from AsyncStorage on mount; sync from API if cache is
  // empty or stale. A stale cache (older than FUSE_SYNC_MAX_AGE_MS) is served
  // immediately for offline capability, then replaced in background with the
  // authoritative server list — which prunes items deleted since the last sync.
  useEffect(() => {
    AsyncStorage.getItem(FUSE_CACHE_KEY)
      .then(raw => {
        if (!raw) {
          // Cache empty — fetch all inventory in background
          syncAllInventory();
          return;
        }
        let items: InventoryItem[];
        try {
          items = JSON.parse(raw) as InventoryItem[];
        } catch {
          // Corrupt cache — clear it and re-sync
          AsyncStorage.removeItem(FUSE_CACHE_KEY).catch(err => {
            reportStorageError("Could not clear corrupt offline cache", err);
          });
          syncAllInventory();
          return;
        }
        buildFuseIndex(items);

        // Check cache age: if older than FUSE_SYNC_MAX_AGE_MS (or timestamp
        // missing because the cache predates timestamp tracking), kick off a
        // background full sync. The sync will replace the cache with the
        // authoritative server list and record a fresh timestamp.
        getFuseCacheSyncedAt().then(syncedAt => {
          const age = syncedAt == null ? Infinity : Date.now() - syncedAt;
          if (age > FUSE_SYNC_MAX_AGE_MS) {
            syncAllInventory();
          }
        }).catch(() => {
          // If we can't read the timestamp, play it safe and re-sync
          syncAllInventory();
        });
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
      .map((r) => ({
        item: r.item,
        confidence: Math.max(0, 1 - (r.score ?? 0.5)),
        matchReason: "offline Fuse match",
        seriesLabel: undefined,
        variants: [],
      }));
  }, []);

  // Shared offline fallback — used by onError and the slow-connection timeout
  const runOfflineFallback = useCallback(() => {
    const f = filtersRef.current;
    const queryKey = buildQueryKey(f);
    loadQueryCache().then(cache => {
      const pruned = pruneExpired(cache);
      if (Object.keys(pruned).length !== Object.keys(cache).length) saveQueryCache(pruned);
      const exactEntry = pruned[queryKey];
      if (exactEntry) {
        setIsOffline(true);
        setOfflineCacheType("exact");
        setOfflineResults(exactEntry.results);
        return;
      }
      const kw = [f.keywords, f.catalog, f.vendor, f.category, f.voltage, f.amperage]
        .filter(Boolean).join(" ");
      const fuseHits = runFuseSearch(kw);
      setIsOffline(true);
      setOfflineCacheType("fuse");
      setOfflineResults(fuseHits.length > 0 ? fuseHits : []);
    });
  }, [runFuseSearch]);

  const searchMutation = useSearchInventory({
    mutation: {
      onSuccess: (data) => {
        if (searchAbortedRef.current) return; // timed out — discard late response
        if (searchTimeoutRef.current) { clearTimeout(searchTimeoutRef.current); searchTimeoutRef.current = null; }
        setIsOffline(false);
        setOfflineResults(null);
        setOfflineCacheType(null);
        // Server response is the new source of truth — drop any local
        // bin overlays so we don't keep showing stale local edits when the
        // backend returns fresh data for the same items.
        setBinOverrides({});
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
          AsyncStorage.setItem(FUSE_CACHE_KEY, JSON.stringify(merged)).catch(err => {
            reportStorageError("Could not save offline inventory cache", err);
          });
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
        if (searchTimeoutRef.current) { clearTimeout(searchTimeoutRef.current); searchTimeoutRef.current = null; }
        if (!searchAbortedRef.current) runOfflineFallback(); // timeout already ran fallback — skip
      },
    },
  });
  // Keep the ref pointing at the latest mutation so the logout handler can
  // reset it without capturing a stale closure.
  searchMutationRef.current = searchMutation;

  const handleChange = (key: keyof FilterValues, value: string | number) => {
    setFilters(f => ({ ...f, [key]: value }));
  };

  const SEARCH_TIMEOUT_MS = 8000;

  const handleSearch = () => {
    setOfflineResults(null);
    setIsOffline(false);
    setOfflineCacheType(null);
    searchAbortedRef.current = false;
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    const body = buildSearchBody(filters, activeCategorySlugRef.current);
    searchMutation.mutate({ data: body });
    // Fall back to offline if API hasn't responded within the timeout
    searchTimeoutRef.current = setTimeout(() => {
      searchTimeoutRef.current = null;
      searchAbortedRef.current = true; // onSuccess will discard any late response
      searchMutation.reset();          // clear the loading spinner
      runOfflineFallback();
    }, SEARCH_TIMEOUT_MS);
  };

  const handleCategorySelect = useCallback((slug: string, label: string) => {
    setMode("search");
    setActiveCategorySlug(slug);
    setActiveCategoryLabel(label);
    activeCategorySlugRef.current = slug;
    setOfflineResults(null);
    setIsOffline(false);
    setOfflineCacheType(null);
    searchAbortedRef.current = false;
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    const body = buildSearchBody(filtersRef.current, slug);
    searchMutation.mutate({ data: body });
    searchTimeoutRef.current = setTimeout(() => {
      searchTimeoutRef.current = null;
      searchAbortedRef.current = true;
      searchMutation.reset();
      runOfflineFallback();
    }, SEARCH_TIMEOUT_MS);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchMutation, runOfflineFallback]);

  const handleClear = () => {
    if (searchTimeoutRef.current) { clearTimeout(searchTimeoutRef.current); searchTimeoutRef.current = null; }
    searchAbortedRef.current = false;
    setFilters({ ...DEFAULT_FILTERS, confidenceThreshold: settings.defaultConfidenceThreshold });
    setActiveCategorySlug(null);
    setActiveCategoryLabel(null);
    activeCategorySlugRef.current = null;
    searchMutation.reset();
    setOfflineResults(null);
    setIsOffline(false);
    setOfflineCacheType(null);
    setDimensionCounts(undefined);
  };

  // Called by KeywordEditor after debounced save — update local Fuse index immediately
  const handleKeywordsChanged = useCallback((id: number, keywords: string[]) => {
    const items = fuseItemsRef.current.map(item =>
      item.id === id ? { ...item, aiKeywords: keywords } : item,
    );
    buildFuseIndex(items);
    AsyncStorage.setItem(FUSE_CACHE_KEY, JSON.stringify(items)).catch(err => {
      reportStorageError("Could not save offline inventory cache", err);
    });
  }, [buildFuseIndex]);

  // Called by BinEditor after a successful save — apply override to currently
  // visible results AND update the offline Fuse cache so the change persists.
  const handleBinsChanged = useCallback((id: number, binLocations: string[]) => {
    setBinOverrides(prev => ({ ...prev, [id]: binLocations }));
    const items = fuseItemsRef.current.map(it =>
      it.id === id ? { ...it, binLocations } : it,
    );
    buildFuseIndex(items);
    AsyncStorage.setItem(FUSE_CACHE_KEY, JSON.stringify(items)).catch(err => {
      reportStorageError("Could not save offline inventory cache", err);
    });
  }, [buildFuseIndex]);

  const handleBarcodesChanged = useCallback((id: number, barcodes: string[]) => {
    const items = fuseItemsRef.current.map(it =>
      it.id === id ? { ...it, barcodes } : it,
    );
    buildFuseIndex(items);
    AsyncStorage.setItem(FUSE_CACHE_KEY, JSON.stringify(items)).catch(err => {
      reportStorageError("Could not save offline inventory cache", err);
    });
  }, [buildFuseIndex]);

  const rawResults: SearchResult[] = offlineResults ?? (searchMutation.data?.results ?? []);
  const results: SearchResult[] = rawResults.map(r =>
    binOverrides[r.item.id]
      ? { ...r, item: { ...r.item, binLocations: binOverrides[r.item.id]! } }
      : r,
  );
  const belowThreshold = searchMutation.data?.belowThreshold ?? 0;
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
            ) : syncError ? (
              <Pressable
                onPress={() => syncAllInventory()}
                style={[styles.statusBadge, { backgroundColor: colors.destructive + "18" }]}
              >
                <Text style={[styles.statusBadgeText, { color: colors.destructive }]}>
                  {syncRetryPending ? "⚠ Sync failed — retrying…" : "⚠ Sync failed — tap to retry"}
                </Text>
              </Pressable>
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
          {isAdmin ? (
            <Pressable
              onPress={() => setShowAddPartModal(true)}
              style={[styles.headerBtn, styles.addPartBtn, { backgroundColor: colors.primary + "18", borderColor: colors.primary + "55" }]}
            >
              <Feather name="plus" size={16} color={colors.primary} />
              <Text style={[styles.logoutBtnLabel, { color: colors.primary }]}>Add Part</Text>
            </Pressable>
          ) : null}
          <Pressable
            onPress={() => setShowReference(true)}
            style={[styles.headerBtn, styles.refBtn, { backgroundColor: colors.muted, borderColor: colors.border }]}
          >
            <Text style={styles.refBtnIcon}>⚡</Text>
            <Text style={[styles.logoutBtnLabel, { color: colors.mutedForeground }]}>Ref</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              setShowLogoutModal(true);
              readNewestCacheTimestamp().then(setCacheAge);
            }}
            style={[styles.headerBtn, styles.logoutBtn, { backgroundColor: colors.muted, borderColor: colors.border }]}
          >
            <Feather name="settings" size={16} color={colors.mutedForeground} />
            <Text style={[styles.logoutBtnLabel, { color: colors.mutedForeground }]}>Settings</Text>
          </Pressable>
        </View>
      </View>

      {/* Settings modal (logout + cache clear) */}
      <Modal
        visible={showLogoutModal}
        transparent
        animationType="fade"
        onRequestClose={() => { setShowLogoutModal(false); setCacheClearedMsg(null); setCacheAge(null); }}
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
                {cacheAge ? (
                  <Text style={[styles.settingsRowHint, { color: colors.mutedForeground, marginTop: 3 }]}>
                    {cacheAge}
                  </Text>
                ) : null}
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
                  setCacheAge("No cached data");
                  setCacheClearedMsg("✓ Cache cleared — resyncing…");
                  syncAllInventory().then(() => {
                    setCacheClearedMsg(null);
                  });
                }}
                style={[styles.secondaryBtn, styles.clearCacheBtn, { backgroundColor: colors.muted, borderColor: colors.border }]}
              >
                <Text style={[styles.clearCacheBtnText, { color: colors.foreground }]}>Clear</Text>
              </Pressable>
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
                      styles.secondaryBtn,
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

            {/* Theme row */}
            <View style={[styles.settingsRow, { borderColor: colors.border }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.settingsRowLabel, { color: colors.foreground }]}>Theme</Text>
                <Text style={[styles.settingsRowHint, { color: colors.mutedForeground }]}>
                  Override the system appearance preference.
                </Text>
              </View>
              <View style={styles.textSizePicker}>
                {(["light", "dark", "system"] as ThemeMode[]).map(mode => (
                  <Pressable
                    key={mode}
                    onPress={() => updateSetting("themeMode", mode)}
                    style={[
                      styles.secondaryBtn,
                      styles.textSizeBtn,
                      {
                        width: "auto",
                        paddingHorizontal: 12,
                        backgroundColor: settings.themeMode === mode ? colors.primary : colors.muted,
                        borderColor: settings.themeMode === mode ? colors.primary : colors.border,
                      },
                    ]}
                  >
                    <Text style={[
                      styles.textSizeBtnLabel,
                      { color: settings.themeMode === mode ? colors.primaryForeground : colors.foreground },
                    ]}>
                      {mode === "light" ? "Light" : mode === "dark" ? "Dark" : "System"}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {/* Default confidence threshold row */}
            <View style={[styles.settingsRow, { borderColor: colors.border, flexDirection: "column", gap: 4 }]}>
              <Text style={[styles.settingsRowLabel, { color: colors.foreground }]}>Default min confidence</Text>
              <Text style={[styles.settingsRowHint, { color: colors.mutedForeground }]}>
                Sets the minimum confidence applied to searches.
              </Text>
              <ConfidenceSlider
                value={settings.defaultConfidenceThreshold}
                onChange={v => updateSetting("defaultConfidenceThreshold", v)}
                colors={colors}
                presets={[20, 40, 60, 80]}
              />
              {/* Custom value text input */}
              <View style={styles.confCustomRow}>
                <Text style={[styles.confCustomLabel, { color: colors.mutedForeground }]}>Custom</Text>
                <TextInput
                  value={confThresholdInput}
                  onChangeText={setConfThresholdInput}
                  onBlur={() => {
                    const n = parseInt(confThresholdInput, 10);
                    const clamped = isNaN(n) ? settings.defaultConfidenceThreshold : Math.max(1, Math.min(100, n));
                    updateSetting("defaultConfidenceThreshold", clamped);
                  }}
                  onSubmitEditing={() => {
                    const n = parseInt(confThresholdInput, 10);
                    const clamped = isNaN(n) ? settings.defaultConfidenceThreshold : Math.max(1, Math.min(100, n));
                    updateSetting("defaultConfidenceThreshold", clamped);
                  }}
                  keyboardType="number-pad"
                  maxLength={3}
                  style={[styles.confCustomInput, {
                    backgroundColor: colors.muted,
                    borderColor: colors.border,
                    color: colors.foreground,
                  }]}
                  returnKeyType="done"
                  selectTextOnFocus
                />
                <Text style={[styles.confCustomLabel, { color: colors.mutedForeground }]}>%</Text>
              </View>
            </View>

            {/* Footer */}
            <Text style={[styles.logoutModalHint, { color: colors.mutedForeground, marginTop: 16 }]}>
              Changes are saved automatically.
            </Text>
            <View style={styles.logoutModalBtns}>
              <Pressable
                onPress={() => { setShowLogoutModal(false); setCacheClearedMsg(null); setCacheAge(null); }}
                style={[styles.logoutModalConfirm, { backgroundColor: colors.primary }]}
              >
                <Text style={[styles.logoutModalConfirmText, { color: colors.primaryForeground }]}>Done</Text>
              </Pressable>
              <Pressable
                onPress={() => { setShowLogoutModal(false); setCacheClearedMsg(null); setCacheAge(null); logout(); }}
                style={[styles.secondaryBtn, styles.logoutModalCancel, { borderColor: colors.destructive + "66", backgroundColor: colors.destructive + "11" }]}
              >
                <Text style={[styles.logoutModalCancelText, { color: colors.destructive }]}>Sign Out</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {mode === "search" ? (
        <>
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

      {/* ── Persistent search bar — always visible ── */}
      <View style={[styles.searchBar, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.searchBarInputWrapper}>
          <TextInput
            value={filters.keywords}
            onChangeText={v => handleChange("keywords", v)}
            placeholder="Search parts — keyword, catalog #, vendor…"
            placeholderTextColor={colors.mutedForeground}
            style={[styles.searchBarInput, {
              backgroundColor: colors.muted,
              borderColor: '#000',
              color: colors.foreground,
              paddingRight: filters.keywords ? 36 : 12,
            }]}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            onSubmitEditing={handleSearch}
            blurOnSubmit={false}
          />
          {filters.keywords ? (
            <Pressable
              onPress={() => handleChange("keywords", "")}
              style={styles.searchBarClearX}
              hitSlop={8}
            >
              <Feather name="x-circle" size={16} color={colors.mutedForeground} />
            </Pressable>
          ) : null}
        </View>
        <View style={styles.searchBarButtons}>
          <Pressable
            onPress={handleSearch}
            disabled={searchMutation.isPending}
            style={[styles.searchBarSearchBtn, {
              backgroundColor: searchMutation.isPending ? colors.muted : colors.primary,
              borderWidth: 1,
              borderColor: searchMutation.isPending ? colors.border : '#000',
            }]}
          >
            <Text style={[styles.searchBarSearchBtnText, { color: '#000' }]}>
              {searchMutation.isPending ? "…" : "🔍 Search"}
            </Text>
          </Pressable>
          {(hasResults || filters.keywords) ? (
            <Pressable
              onPress={handleClear}
              style={[styles.secondaryBtn, styles.searchBarClearBtn, { borderColor: colors.border }]}
            >
              <Text style={[styles.searchBarClearBtnText, { color: colors.mutedForeground }]}>Clear</Text>
            </Pressable>
          ) : null}
        </View>

      </View>

      {/* ── Results list + floating filter overlay ── */}
      <View style={{ flex: 1 }}>
        <FlatList
          data={results}
          keyExtractor={item => String(item.item.id)}
          style={{ flex: 1 }}
        ListHeaderComponent={() => (
          <View>
            {/* Results header */}
            {hasResults ? (
              <View>
                <View style={styles.resultsHeader}>
                  <Text style={[styles.resultsCount, { color: colors.foreground }]}>
                    {results.length} {isOffline ? "offline" : ""} match{results.length !== 1 ? "es" : ""} found
                  </Text>
                  <Pressable
                    onPress={handleClear}
                    style={[styles.secondaryBtn, styles.newSearchBtn, { borderColor: colors.border }]}
                  >
                    <Text style={[styles.newSearchText, { color: colors.primary }]}>New Search</Text>
                  </Pressable>
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
                  Search by keywords, catalog #, or vendor. Expand Advanced Filters below for 16-dimension chip filters. Handles abbreviations, synonyms, and misspellings automatically.
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
            <ResultCard
              result={result}
              onEditKeywords={setEditItem}
              onEditBins={isAdmin ? setBinEditItem : undefined}
              onEditBarcodes={isAdmin ? setBarcodeEditItem : undefined}
              rank={index}
              fontScale={textFontScale}
            />
          </View>
        )}
        contentContainerStyle={[styles.listContent, { paddingTop: 76 }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="none"
      />

        {/* 3-mode toggle + Floating filter overlay — stacked above results */}
        <View style={styles.filterOverlayWrapper}>
          {/* Browse: [By Aisle] [By Category] */}
          <View style={styles.modeToggleRow}>
            <Text style={styles.modeToggleLabel}>Browse:</Text>
            {([ 
              { key: "aisle"    as SearchMode, label: "By Aisle",    icon: "map-pin" as const },
              { key: "category" as SearchMode, label: "By Category", icon: "tag"     as const },
            ]).map(m => (
              <Pressable
                key={m.key}
                onPress={() => setMode(m.key)}
                style={[
                  styles.modeToggleBtn,
                  {
                    backgroundColor: mode === m.key ? colors.primary + "22" : colors.card,
                    borderColor:     mode === m.key ? colors.primary + "88" : colors.border,
                  },
                ]}
              >
                <Feather name={m.icon} size={13} color="#fff" />
                <Text style={[styles.modeToggleBtnText, { color: "#fff" }]}>
                  {m.label}
                </Text>
              </Pressable>
            ))}
          </View>
          {activeCategorySlug && activeCategoryLabel ? (
            <Pressable
              onPress={handleClear}
              style={[styles.activeCategoryBadge, { backgroundColor: colors.primary + "18", borderColor: colors.primary + "55" }]}
            >
              <Feather name="tag" size={12} color={colors.primary} />
              <Text style={[styles.activeCategoryBadgeText, { color: colors.primary }]} numberOfLines={1}>
                {activeCategoryLabel}
              </Text>
              <Feather name="x" size={12} color={colors.primary} />
            </Pressable>
          ) : null}
          <View style={[styles.filterOverlay, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <FilterPanel
              values={filters}
              onChange={handleChange}
              dimensionCounts={dimensionCounts}
            />
          </View>
        </View>
      </View>
        </>
      ) : mode === "aisle" ? (
        <BrowseByAisle
          inventory={fuseItemsRef.current}
          isSyncing={syncProgress !== null}
          shelfViewEnabled={settings.shelfViewEnabled}
          fontScale={textFontScale}
          onClose={() => setMode("search")}
          onEditKeywords={setEditItem}
          onEditBins={isAdmin ? setBinEditItem : undefined}
          isAdmin={isAdmin}
          adminToken={adminToken}
          onPartAdded={() => syncAllInventory()}
        />
      ) : (
        <BrowseByCategory
          onSelectCategory={handleCategorySelect}
          onClose={() => setMode("search")}
        />
      )}

      <AddPartModal
        visible={showAddPartModal}
        adminToken={adminToken}
        onClose={() => setShowAddPartModal(false)}
        onSuccess={() => {
          syncAllInventory();
        }}
        onAddDetails={isAdmin ? (item) => setDetailsItem(item) : undefined}
      />

      <PartDetailsEditor
        item={detailsItem}
        adminToken={adminToken}
        onClose={() => setDetailsItem(null)}
      />

      <ReferenceModal open={showReference} onClose={() => setShowReference(false)} />

      <KeywordEditor
        item={editItem}
        onClose={() => setEditItem(null)}
        onKeywordsChanged={handleKeywordsChanged}
      />

      <BinEditor
        item={binEditItem}
        onClose={() => setBinEditItem(null)}
        onBinsChanged={handleBinsChanged}
      />

      <BarcodeEditor
        item={barcodeEditItem}
        onClose={() => setBarcodeEditItem(null)}
        onBarcodesChanged={handleBarcodesChanged}
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
  logoutBtn: { flexDirection: "column", gap: 2, paddingVertical: 4, paddingHorizontal: 10 },
  addPartBtn: { width: 60, flexDirection: "column", gap: 2, paddingVertical: 4 },
  logoutBtnLabel: { fontSize: 9, fontFamily: "Inter_500Medium", letterSpacing: 0.2 },
  refBtn: { flexDirection: "column", gap: 2, paddingVertical: 4, paddingHorizontal: 10 },
  refBtnIcon: { fontSize: 14 },
  modalOverlay: { flex: 1, backgroundColor: "#00000055", alignItems: "center", justifyContent: "center", padding: 32 },
  logoutModal: { width: "100%", borderRadius: 14, borderWidth: 1, padding: 24 },
  logoutModalTitle: { fontSize: 18, fontFamily: "Inter_700Bold", marginBottom: 8 },
  logoutModalHint: { fontSize: 14, fontFamily: "Inter_400Regular", lineHeight: 20, marginBottom: 20 },
  logoutModalBtns: { flexDirection: "row", gap: 10 },
  logoutModalCancel: { flex: 1, paddingVertical: 12, alignItems: "center" },
  logoutModalCancelText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  logoutModalConfirm: { flex: 1, borderRadius: 8, paddingVertical: 12, alignItems: "center" },
  logoutModalConfirmText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  searchBar: {
    margin: 12,
    marginBottom: 6,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    gap: 8,
  },
  searchBarInputWrapper: {
    position: "relative",
    justifyContent: "center",
  },
  searchBarInput: {
    borderWidth: 2,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
  },
  searchBarClearX: {
    position: "absolute",
    right: 10,
    padding: 2,
  },
  searchBarButtons: {
    flexDirection: "row",
    gap: 8,
  },
  searchBarSearchBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: "center",
  },
  searchBarSearchBtnText: { fontSize: 16, fontFamily: "Inter_700Bold" },
  searchBarClearBtn: {
    paddingVertical: 11,
    paddingHorizontal: 16,
    alignItems: "center",
  },
  searchBarClearBtnText: { fontSize: 14, fontFamily: "Inter_500Medium" },
  filterOverlayWrapper: {
    position: "absolute",
    top: 0,
    left: 12,
    right: 12,
    zIndex: 20,
    flexDirection: "column",
    alignItems: "center",
  },
  filterOverlay: {
    alignSelf: "stretch",
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 8,
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
  secondaryBtn: { ...secondaryBtnBase },
  newSearchBtn: { paddingHorizontal: 12, paddingVertical: 6 },
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
  confCustomRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 },
  confCustomLabel: { fontSize: 13, fontFamily: "Inter_500Medium" },
  confCustomInput: {
    borderWidth: 1, borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 7,
    fontSize: 15, fontFamily: "Inter_700Bold",
    textAlign: "center", width: 60,
  },
  clearCacheBtn: { paddingHorizontal: 14, paddingVertical: 8, alignSelf: "center" },
  clearCacheBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  textSizePicker: { flexDirection: "row", gap: 6, alignSelf: "center" },
  textSizeBtn: { width: 34, height: 34, alignItems: "center", justifyContent: "center" },
  textSizeBtnLabel: { fontSize: 13, fontFamily: "Inter_700Bold" },
  modeToggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 8,
    alignSelf: "stretch",
  },
  modeToggleLabel: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#fff", textDecorationLine: "underline" },
  modeToggleBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 10,
    borderWidth: 1,
  },
  modeToggleBtnText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  activeCategoryBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "center",
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 16,
    borderWidth: 1,
    marginBottom: 6,
    maxWidth: "90%",
  },
  activeCategoryBadgeText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    flexShrink: 1,
  },
});
