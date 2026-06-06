import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import NetInfo from "@react-native-community/netinfo";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Fuse from "fuse.js";
import { useSearchInventory } from "@workspace/api-client-react";
import type { InventoryItem, SearchResult } from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";
import { FilterPanel, ConfidenceSlider, type FilterValues } from "@/components/FilterPanel";
import { ResultCard } from "@/components/ResultCard";
import { ReferenceModal } from "@/components/ReferenceModal";
import { PartDetailsEditor } from "@/components/PartDetailsEditor";
import { MeasurePartScreen } from "@/components/MeasurePartScreen";
import type { PartDimensions } from "@/components/MeasurePartScreen";
import { BrowseByAisle } from "@/components/BrowseByAisle";
import { BrowseByCategory } from "@/components/BrowseByCategory";
import { useApp, DEFAULT_SETTINGS, type TextSize, type ThemeMode, type DimensionUnit, type PinnedPart } from "@/contexts/AppContext";
import { parseBin } from "@/lib/aisleHierarchy";
import { useFocusEffect, router } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { secondaryBtnBase } from "@/styles/shared";
import { reportStorageError } from "@/utils/storageErrorReporter";
import { retryAsync } from "@/utils/retryAsync";
import { evictLRU, QUERY_CACHE_MAX_ENTRIES } from "@/utils/queryCacheBound";
import { FUSE_CACHE_KEY, FUSE_CACHE_SYNCED_AT_KEY, getFuseCacheSyncedAt, FUSE_SYNC_MAX_AGE_MS } from "@/utils/offlineBarcode";
import {
  QUERY_CACHE_KEY,
  buildQueryKey,
  buildSearchBody,
  pruneExpired,
  formatStaleCacheWarning,
  formatRelativeAge,
  resolveOfflineFallback,
  fetchInventoryPages,
} from "@/utils/searchHelpers";
import type { QueryCache } from "@/utils/searchHelpers";
import { useTrackScreen } from "@/utils/useTrackScreen";
import { searchResetEvent } from "@/utils/searchResetEvent";


const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : "http://localhost:8080/api";


type QueryCacheEntry = { timestamp: number; results: SearchResult[] };

async function loadQueryCache(): Promise<QueryCache<SearchResult>> {
  try {
    const raw = await AsyncStorage.getItem(QUERY_CACHE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as QueryCache<SearchResult>;
  } catch { return {}; }
}

async function saveQueryCache(cache: QueryCache<SearchResult>): Promise<void> {
  // Bound the cache so a long session of unique searches can't grow it without
  // limit. Evict by LRU (oldest timestamp first) before persisting.
  const bounded = evictLRU(cache, QUERY_CACHE_MAX_ENTRIES);
  try {
    await AsyncStorage.setItem(QUERY_CACHE_KEY, JSON.stringify(bounded));
  } catch (err) {
    reportStorageError("Could not save offline search cache", err);
  }
}

async function readNewestCacheTimestamp(): Promise<string> {
  try {
    const raw = await AsyncStorage.getItem(QUERY_CACHE_KEY);
    if (!raw) return "No cached data";
    const cache = JSON.parse(raw) as QueryCache<SearchResult>;
    const entries = Object.values(cache);
    if (entries.length === 0) return "No cached data";
    const newest = Math.max(...entries.map((e: QueryCacheEntry) => e.timestamp));
    return formatRelativeAge(newest);
  } catch {
    return "No cached data";
  }
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
  minLength: "",
  maxLength: "",
  minWidth: "",
  maxWidth: "",
  minHeight: "",
  maxHeight: "",
  minDiameter: "",
  maxDiameter: "",
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

export default function SearchScreen() {
  "use no memo";
  useTrackScreen("Search");
  const colors = useColors();
  const { logout, clearCache, settings, updateSetting, textFontScale, isLoading: settingsLoading, isAdmin, adminToken, registerLogoutHandler, setPendingMapFocus, showToast, setPinnedParts, pendingMeasureSearch, setPendingMeasureSearch } = useApp();
  type SearchMode = "search" | "aisle" | "category";
  const [mode, setMode] = useState<SearchMode>("search");
  const [activeCategorySlug, setActiveCategorySlug] = useState<string | null>(null);
  const [activeCategoryLabel, setActiveCategoryLabel] = useState<string | null>(null);
  const activeCategorySlugRef = useRef<string | null>(null);
  useEffect(() => { activeCategorySlugRef.current = activeCategorySlug; }, [activeCategorySlug]);
  const [filters, setFilters] = useState<FilterValues>(DEFAULT_FILTERS);
  const [filterHeaderHeight, setFilterHeaderHeight] = useState(120);
  const [detailsItem, setDetailsItem] = useState<InventoryItem | null>(null);
  const [measureItem, setMeasureItem] = useState<InventoryItem | null>(null);
  // Banner shown when a dimension-filtered search returns 0 exact results
  const [showSimilarSizeBanner, setShowSimilarSizeBanner] = useState(false);

  const handleShowOnMap = useCallback((item: InventoryItem) => {
    const bins = item.binLocations ?? [];
    if (bins.length === 0) {
      showToast("No bin location assigned — add a bin to this item first.");
      return;
    }
    const newPins: PinnedPart[] = [];
    let firstParsed: ReturnType<typeof parseBin> | null = null;
    for (const bin of bins) {
      const parsed = parseBin(bin);
      if (parsed) {
        if (!firstParsed) firstParsed = parsed;
        newPins.push({ binCode: bin, label: item.catalog, aisleNum: parsed.aisle });
      }
    }
    if (!firstParsed) {
      showToast(`No map zone found for "${bins[0]}" — bin format not recognised.`);
      return;
    }
    setPinnedParts(newPins);
    setPendingMapFocus({
      aisleNum: firstParsed.aisle,
      label: `Aisle ${String(firstParsed.aisle).padStart(2, "0")} · Section ${firstParsed.section}`,
    });
    router.navigate("/(tabs)/map");
  }, [setPendingMapFocus, setPinnedParts, showToast]);

  const handleVariantsToggle = useCallback((item: InventoryItem) => (variantItems: InventoryItem[], isOpen: boolean) => {
    if (!isOpen) {
      // Only remove variant pins that belong to THIS item via groupId.
      // Other expanded cards' variant pins remain on the map, allowing
      // multiple cards to be expanded simultaneously without interfering.
      setPinnedParts((prev) => prev.filter(p => !(p.variant && p.groupId === item.id)));
      return;
    }
    const variantPins: PinnedPart[] = [];
    for (const v of variantItems) {
      for (const bin of (v.binLocations ?? [])) {
        const parsed = parseBin(bin);
        if (parsed && v.id !== item.id) {
          variantPins.push({ binCode: bin, label: v.catalog, aisleNum: parsed.aisle, variant: true, groupId: item.id });
        }
      }
    }
    // Clear any existing pins for THIS item before adding fresh ones
    setPinnedParts((prev) => [
      ...prev.filter(p => !(p.variant && p.groupId === item.id)),
      ...variantPins,
    ]);
  }, [setPinnedParts]);

  const [offlineResults, setOfflineResults] = useState<SearchResult[] | null>(null);
  // Local string state for the custom threshold TextInput in Settings
  const [confThresholdInput, setConfThresholdInput] = useState(String(DEFAULT_SETTINGS.defaultConfidenceThreshold));
  const [isOffline, setIsOffline] = useState(false);
  const [, setOfflineCacheType] = useState<"exact" | "fuse" | null>(null);
  const [fuseSyncedAt, setFuseSyncedAt] = useState<number | null>(null);
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
  // Concurrency guard: prevents a second syncAllInventory from starting while
  // one is already in flight (e.g. user taps Refresh while a background retry
  // is running), which would race on setSyncProgress and the Fuse index.
  const isSyncingRef = useRef(false);
  // Ref to the FlatList so the tab-press reset can scroll back to the top.
  const flatListRef = useRef<FlatList<FlatListItem> | null>(null);
  // Ref to the latest handleClear so the tab-press subscription (mounted once)
  // always calls the up-to-date version without a stale closure.
  const handleClearRef = useRef<() => void>(() => {});
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
      setOfflineResults(null);
      setIsOffline(false);
      setOfflineCacheType(null);
      setFuseSyncedAt(null);
      setDimensionCounts(undefined);
      setShowSimilarSizeBanner(false);
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
    // Prevent concurrent syncs from racing on setSyncProgress and the Fuse index.
    if (isSyncingRef.current) return;
    isSyncingRef.current = true;

    // Cancel any pending auto-retry before starting a new attempt
    if (syncRetryTimerRef.current !== null) {
      clearTimeout(syncRetryTimerRef.current);
      syncRetryTimerRef.current = null;
    }
    setSyncError(false);
    setSyncRetryPending(false);
    try {
      const allItems = await fetchInventoryPages(
        async (page, pageSize) => {
          const data: { items: InventoryItem[]; total: number } = await retryAsync(async () => {
            const res = await fetch(`${API_BASE}/inventory?page=${page}&limit=${pageSize}`);
            if (!res.ok) throw new Error(`Sync failed: ${res.status}`);
            return res.json();
          });
          return data;
        },
        500,
        (loaded, total) => setSyncProgress({ loaded, total }),
      );
      buildFuseIndex(allItems);

      // Prune cached search results whose items were deleted server-side.
      // The full sync gives us the authoritative item set; any cached entry
      // referencing an id no longer present is stale and must be removed so
      // offline searches never surface deleted inventory.
      const liveIds = new Set(allItems.map(item => item.id));
      loadQueryCache().then(cache => {
        let dirty = false;
        const pruned: QueryCache<SearchResult> = {};
        for (const [key, entry] of Object.entries(cache)) {
          const kept = entry.results.filter(r => liveIds.has(r.item.id));
          if (kept.length !== entry.results.length) dirty = true;
          if (kept.length > 0) {
            pruned[key] = { ...entry, results: kept };
          } else {
            dirty = true; // entry fully emptied — drop it
          }
        }
        if (dirty) saveQueryCache(pruned);
      }).catch(() => {});

      syncRetryAttemptRef.current = 0; // success — reset backoff counter
      try {
        const syncedAt = Date.now();
        await AsyncStorage.setItem(FUSE_CACHE_KEY, JSON.stringify(allItems));
        // Record when this authoritative full sync completed. The mount effect
        // uses this to trigger a background re-sync when the cache is stale,
        // which prunes items deleted server-side since the last sync.
        await AsyncStorage.setItem(FUSE_CACHE_SYNCED_AT_KEY, String(syncedAt));
        // Update in-memory state so any active offline warning clears immediately
        // without requiring a remount.
        setFuseSyncedAt(syncedAt);
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
      isSyncingRef.current = false;
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
          setFuseSyncedAt(syncedAt);
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
      const kw = [f.keywords, f.catalog, f.vendor, f.category, f.voltage, f.amperage]
        .filter(Boolean).join(" ");
      const result = resolveOfflineFallback({
        queryKey,
        cache: pruned,
        fuseSearch: runFuseSearch,
        keywords: kw,
      });
      setIsOffline(true);
      setOfflineCacheType(result.cacheType);
      setOfflineResults(result.results);
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
        setDimensionCounts(data.dimensionCounts as Record<string, Record<string, number>> | undefined);

        // Show the "similar size" suggestion banner when the search returned
        // zero results and at least one dimension filter was active.
        const f = filtersRef.current;
        const hasDimFilters =
          f.minLength.trim() !== "" || f.maxLength.trim() !== "" ||
          f.minWidth.trim() !== "" || f.maxWidth.trim() !== "" ||
          f.minHeight.trim() !== "" || f.maxHeight.trim() !== "" ||
          f.minDiameter.trim() !== "" || f.maxDiameter.trim() !== "";
        const zeroResults = (data.results?.length ?? 0) === 0 && (data.sizeUnknownResults?.length ?? 0) === 0;
        setShowSimilarSizeBanner(zeroResults && hasDimFilters);

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

  // Consume a pending measure search set by the Photo tab's Measure flow.
  // When the Photo tab resolves dimensions and navigates the user back here,
  // this effect picks up the MeasureSearchParams object, applies the dimension
  // bounds to the active filters, and fires a search automatically.
  useFocusEffect(useCallback(() => {
    if (!pendingMeasureSearch) return;
    setPendingMeasureSearch(null);
    const merged: FilterValues = {
      ...filtersRef.current,
      minLength:   pendingMeasureSearch.minLength   ?? "",
      maxLength:   pendingMeasureSearch.maxLength   ?? "",
      minWidth:    pendingMeasureSearch.minWidth    ?? "",
      maxWidth:    pendingMeasureSearch.maxWidth    ?? "",
      minHeight:   pendingMeasureSearch.minHeight   ?? "",
      maxHeight:   pendingMeasureSearch.maxHeight   ?? "",
      minDiameter: pendingMeasureSearch.minDiameter ?? "",
      maxDiameter: pendingMeasureSearch.maxDiameter ?? "",
    };
    setFilters(merged);
    setTimeout(() => {
      const body = buildSearchBody(merged, activeCategorySlugRef.current);
      searchMutation.mutate({ data: body });
    }, 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingMeasureSearch]));

  const handleChange = (key: keyof FilterValues, value: string | number) => {
    setFilters(f => ({ ...f, [key]: value }));
    // Any manual filter edit dismisses the "similar size" suggestion banner
    setShowSimilarSizeBanner(false);
  };

  const SEARCH_TIMEOUT_MS = 8000;

  const handleSearch = () => {
    // Guard: do not fire a search when there is nothing to search for.
    // This mirrors the canSearch computation below and also protects the
    // onSubmitEditing path (keyboard Return), which bypasses the button's
    // disabled prop.
    const flt = filtersRef.current;
    const hasSizeInput =
      flt.minLength.trim() !== "" || flt.maxLength.trim() !== "" ||
      flt.minDiameter.trim() !== "" || flt.maxDiameter.trim() !== "";
    const hasAnyInput =
      flt.keywords.trim() !== "" || flt.catalog.trim() !== "" ||
      flt.vendor.trim() !== "" || flt.color.trim() !== "" ||
      flt.size.trim() !== "" || flt.material.trim() !== "" ||
      flt.textNumbers.trim() !== "" || hasSizeInput ||
      activeCategorySlugRef.current != null;
    if (!hasAnyInput) return;

    setPinnedParts([]);
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

  const handleClear = () => {
    if (searchTimeoutRef.current) { clearTimeout(searchTimeoutRef.current); searchTimeoutRef.current = null; }
    searchAbortedRef.current = false;
    setMode("search");
    setActiveCategorySlug(null);
    setActiveCategoryLabel(null);
    activeCategorySlugRef.current = null;
    setFilters({ ...DEFAULT_FILTERS, confidenceThreshold: settings.defaultConfidenceThreshold });
    searchMutation.reset();
    setOfflineResults(null);
    setIsOffline(false);
    setOfflineCacheType(null);
    setDimensionCounts(undefined);
    setShowSimilarSizeBanner(false);
    setPinnedParts([]);
  };

  // Keep handleClearRef pointing at the latest closure so the tab-press
  // subscription effect (mounted once) never calls a stale version.
  useEffect(() => { handleClearRef.current = handleClear; });

  // Subscribe to the search-reset event emitted by _layout.tsx when the user
  // taps the Search tab while it is already focused.
  useEffect(() => {
    return searchResetEvent.subscribe(() => {
      handleClearRef.current();
      flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
    });
  }, []);

  // Re-run the last search with each dimension bound widened by ±10%
  const handleSimilarSizeSearch = () => {
    const f = filtersRef.current;
    const expand = (val: string, factor: number): string => {
      const n = parseFloat(val);
      if (isNaN(n)) return val;
      return String(Math.round(n * factor * 1000) / 1000);
    };
    const expanded: FilterValues = {
      ...f,
      minLength:   f.minLength.trim()   !== "" ? expand(f.minLength,   0.9) : f.minLength,
      maxLength:   f.maxLength.trim()   !== "" ? expand(f.maxLength,   1.1) : f.maxLength,
      minWidth:    f.minWidth.trim()    !== "" ? expand(f.minWidth,    0.9) : f.minWidth,
      maxWidth:    f.maxWidth.trim()    !== "" ? expand(f.maxWidth,    1.1) : f.maxWidth,
      minHeight:   f.minHeight.trim()   !== "" ? expand(f.minHeight,   0.9) : f.minHeight,
      maxHeight:   f.maxHeight.trim()   !== "" ? expand(f.maxHeight,   1.1) : f.maxHeight,
      minDiameter: f.minDiameter.trim() !== "" ? expand(f.minDiameter, 0.9) : f.minDiameter,
      maxDiameter: f.maxDiameter.trim() !== "" ? expand(f.maxDiameter, 1.1) : f.maxDiameter,
    };
    setShowSimilarSizeBanner(false);
    setFilters(expanded);
    setPinnedParts([]);
    setOfflineResults(null);
    setIsOffline(false);
    setOfflineCacheType(null);
    searchAbortedRef.current = false;
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    const body = buildSearchBody(expanded, activeCategorySlugRef.current);
    searchMutation.mutate({ data: body });
    searchTimeoutRef.current = setTimeout(() => {
      searchTimeoutRef.current = null;
      searchAbortedRef.current = true;
      searchMutation.reset();
      runOfflineFallback();
    }, SEARCH_TIMEOUT_MS);
  };

  const handleCategorySelect = useCallback((slug: string, label: string) => {
    setMode("search");
    setActiveCategorySlug(slug);
    setActiveCategoryLabel(label);
    activeCategorySlugRef.current = slug;
    setPinnedParts([]);
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


  const handleMeasureConfirm = useCallback(async (dims: PartDimensions) => {
    const item = measureItem;
    setMeasureItem(null);
    if (!item || !adminToken) return;
    try {
      const res = await fetch(`${API_BASE}/inventory/${item.id}/dimensions`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify(dims),
      });
      if (!res.ok) throw new Error(`PATCH dimensions failed: ${res.status}`);
      const updated = fuseItemsRef.current.map(it =>
        it.id === item.id ? { ...it, dimensions: dims } : it,
      );
      buildFuseIndex(updated);
      AsyncStorage.setItem(FUSE_CACHE_KEY, JSON.stringify(updated)).catch(err => {
        reportStorageError("Could not save offline inventory cache", err);
      });
      showToast("Dimensions saved.");
    } catch {
      showToast("Could not save dimensions — please try again.");
    }
  }, [measureItem, adminToken, buildFuseIndex, showToast]);

  const results: SearchResult[] = offlineResults ?? (searchMutation.data?.results ?? []);
  const sizeUnknownResults: SearchResult[] = isOffline ? [] : (searchMutation.data?.sizeUnknownResults ?? []);
  const belowThreshold = searchMutation.data?.belowThreshold ?? 0;
  const hasResults = searchMutation.isSuccess || offlineResults !== null;

  // True when the user has entered at least one dimension bound.
  // The search button must remain enabled in this state even if the keyword
  // field is empty — the API runs a dedicated SQL scan using expression indexes
  // when size-range filters are the only input.
  const hasActiveSizeFilter =
    filters.minLength.trim() !== "" ||
    filters.maxLength.trim() !== "" ||
    filters.minDiameter.trim() !== "" ||
    filters.maxDiameter.trim() !== "";

  // The search button is enabled when the user has provided any searchable
  // input — text fields, a size-range bound, or a browsed category.
  const canSearch =
    filters.keywords.trim() !== "" ||
    filters.catalog.trim() !== "" ||
    filters.vendor.trim() !== "" ||
    filters.color.trim() !== "" ||
    filters.size.trim() !== "" ||
    filters.material.trim() !== "" ||
    filters.textNumbers.trim() !== "" ||
    hasActiveSizeFilter ||
    activeCategorySlug != null;

  type FlatListItem =
    | { kind: "result"; result: SearchResult; index: number }
    | { kind: "sizeUnknownHeader"; count: number }
    | { kind: "sizeUnknown"; result: SearchResult; index: number };

  const flatListData: FlatListItem[] = [
    ...results.map((result, index) => ({ kind: "result" as const, result, index })),
    ...(sizeUnknownResults.length > 0
      ? [
          { kind: "sizeUnknownHeader" as const, count: sizeUnknownResults.length },
          ...sizeUnknownResults.map((result, index) => ({ kind: "sizeUnknown" as const, result, index })),
        ]
      : []),
  ];
  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.headerTitle, { color: colors.foreground, fontSize: Math.round(20 * textFontScale) }]}>⚡ Parts ID</Text>
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
              <Pressable
                onPress={() => {
                  syncAllInventory();
                  NetInfo.fetch().then(state => setIsOffline(!state.isConnected));
                }}
                style={[styles.statusBadge, { backgroundColor: colors.primary + "18" }]}
              >
                <Text style={[styles.statusBadgeText, { color: colors.primary }]}>
                  {`✓ Ready · ${cachedCount} items`}
                </Text>
              </Pressable>
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
        <View style={[styles.modalOverlay, { backgroundColor: colors.overlay }]}>
          <View style={[styles.logoutModal, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.logoutModalTitle, { color: colors.foreground }]}>Settings</Text>

            <ScrollView
              showsVerticalScrollIndicator={false}
              style={{ maxHeight: 480 }}
              contentContainerStyle={{ paddingBottom: 4 }}
              keyboardShouldPersistTaps="handled"
            >

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

            {/* Shelf view row */}
            <View style={[styles.settingsRow, { borderColor: colors.border }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.settingsRowLabel, { color: colors.foreground }]}>Shelf view</Text>
                <Text style={[styles.settingsRowHint, { color: colors.mutedForeground }]}>
                  Show visual shelf planks when browsing by aisle.
                </Text>
              </View>
              <Switch
                value={settings.shelfViewEnabled}
                onValueChange={v => updateSetting("shelfViewEnabled", v)}
                trackColor={{ false: colors.border, true: colors.primary }}
                thumbColor={settings.shelfViewEnabled ? colors.primaryForeground : colors.mutedForeground}
              />
            </View>

            {/* Scan sound row */}
            <View style={[styles.settingsRow, { borderColor: colors.border }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.settingsRowLabel, { color: colors.foreground }]}>Scan sound</Text>
                <Text style={[styles.settingsRowHint, { color: colors.mutedForeground }]}>
                  Play a chime on each successful barcode assignment.
                </Text>
              </View>
              <Switch
                value={settings.scanSound}
                onValueChange={v => updateSetting("scanSound", v)}
                trackColor={{ false: colors.border, true: colors.primary }}
                thumbColor={settings.scanSound ? colors.primaryForeground : colors.mutedForeground}
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
            <View style={[styles.settingsRow, { borderColor: colors.border, flexDirection: "column", gap: 8 }]}>
              <View>
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
                        paddingHorizontal: 16,
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

            {/* Measure unit row */}
            <View style={[styles.settingsRow, { borderColor: colors.border }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.settingsRowLabel, { color: colors.foreground }]}>Measure unit</Text>
                <Text style={[styles.settingsRowHint, { color: colors.mutedForeground }]}>
                  Unit used for dimension display across search cards, detail view, and the measure screen.
                </Text>
              </View>
              <View style={styles.textSizePicker}>
                {(["mm", "cm", "in"] as DimensionUnit[]).map(u => (
                  <Pressable
                    key={u}
                    onPress={() => updateSetting("dimensionUnit", u)}
                    style={[
                      styles.secondaryBtn,
                      styles.textSizeBtn,
                      {
                        backgroundColor: settings.dimensionUnit === u ? colors.primary : colors.muted,
                        borderColor: settings.dimensionUnit === u ? colors.primary : colors.border,
                      },
                    ]}
                  >
                    <Text style={[
                      styles.textSizeBtnLabel,
                      { color: settings.dimensionUnit === u ? colors.primaryForeground : colors.foreground },
                    ]}>
                      {u}
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

            {/* Admin links */}
            {isAdmin ? (
              <View style={[styles.settingsRow, { borderColor: colors.border, flexDirection: "column", gap: 8 }]}>
                <Text style={[styles.settingsRowLabel, { color: colors.foreground }]}>Admin</Text>
                <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                  <Pressable
                    onPress={() => { setShowLogoutModal(false); router.push("/admin"); }}
                    style={[styles.secondaryBtn, { borderColor: colors.primary + "88", backgroundColor: colors.primary + "11", paddingHorizontal: 14, paddingVertical: 8 }]}
                  >
                    <Text style={{ color: colors.primary, fontSize: 13, fontFamily: "Inter_600SemiBold" }}>Dashboard</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => { setShowLogoutModal(false); router.push("/ai-log"); }}
                    style={[styles.secondaryBtn, { borderColor: colors.border, paddingHorizontal: 14, paddingVertical: 8 }]}
                  >
                    <Text style={{ color: colors.foreground, fontSize: 13, fontFamily: "Inter_500Medium" }}>AI Log</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => { setShowLogoutModal(false); router.push("/admin-inbox"); }}
                    style={[styles.secondaryBtn, { borderColor: colors.border, paddingHorizontal: 14, paddingVertical: 8 }]}
                  >
                    <Text style={{ color: colors.foreground, fontSize: 13, fontFamily: "Inter_500Medium" }}>Inbox</Text>
                  </Pressable>
                </View>
              </View>
            ) : null}

            {/* Footer */}
            <Text style={[styles.logoutModalHint, { color: colors.mutedForeground, marginTop: 16 }]}>
              Changes are saved automatically.
            </Text>

            </ScrollView>

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

      {/* Offline banner */}
      {isOffline ? (
        <View style={[styles.offlineBanner, { backgroundColor: colors.warning + "15", borderBottomColor: colors.warning + "44" }]}>
          <Text style={[styles.offlineBannerText, { color: colors.warning }]}>
            Internet Offline—using local search
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
              borderColor: '#555',
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
            disabled={searchMutation.isPending || !canSearch}
            style={[styles.searchBarSearchBtn, {
              backgroundColor: (searchMutation.isPending || !canSearch) ? colors.muted : colors.primary,
              borderWidth: 1,
              borderColor: (searchMutation.isPending || !canSearch) ? colors.border : '#000',
            }]}
          >
            <Text style={[styles.searchBarSearchBtnText, { color: '#000' }]}>
              {searchMutation.isPending ? "…" : "🔍 Search"}
            </Text>
          </Pressable>
          {(hasResults || filters.keywords || hasActiveSizeFilter) ? (
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
      {mode === "aisle" ? (
        <BrowseByAisle
          inventory={fuseItemsRef.current}
          isSyncing={syncProgress !== null}
          shelfViewEnabled={settings.shelfViewEnabled}
          fontScale={textFontScale}
          onClose={() => setMode("search")}
          isAdmin={isAdmin}
          adminToken={adminToken}
          onPartAdded={() => syncAllInventory()}
          onRefresh={syncAllInventory}
          onShowOnMap={handleShowOnMap}
        />
      ) : mode === "category" ? (
        <BrowseByCategory
          onSelectCategory={handleCategorySelect}
          onClose={() => setMode("search")}
          fontScale={textFontScale}
        />
      ) : (
      <>
        <FlatList
          ref={flatListRef}
          data={flatListData}
          keyExtractor={item => item.kind === "sizeUnknownHeader" ? "__size-unknown-header__" : String(item.result.item.id) + (item.kind === "sizeUnknown" ? "-unknown" : "")}
          style={{ flex: 1 }}
          refreshControl={
            <RefreshControl
              refreshing={syncProgress !== null}
              onRefresh={syncAllInventory}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
        ListHeaderComponent={() => (
          <View>
            {/* Results header */}
            {hasResults ? (
              <View>
                <View style={styles.resultsHeader}>
                  <Text style={[styles.resultsCount, { color: colors.foreground }]}>
                    {results.length + sizeUnknownResults.length} {isOffline ? "offline" : ""} match{results.length + sizeUnknownResults.length !== 1 ? "es" : ""} found
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
            {isOffline && offlineResults !== null && offlineResults.length > 0 && (fuseSyncedAt == null || Date.now() - fuseSyncedAt > FUSE_SYNC_MAX_AGE_MS) ? (
              <View style={[styles.staleCacheNote, { backgroundColor: colors.warning + "15", borderColor: colors.warning + "44" }]}>
                <Text style={[styles.staleCacheNoteText, { color: colors.warning }]}>
                  ⚠ {formatStaleCacheWarning(fuseSyncedAt)}
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
                {showSimilarSizeBanner ? (
                  <Pressable
                    onPress={handleSimilarSizeSearch}
                    style={[styles.similarSizeBanner, {
                      backgroundColor: colors.primary + "14",
                      borderColor: colors.primary + "55",
                    }]}
                  >
                    <Text style={[styles.similarSizeBannerIcon, { color: colors.primary }]}>📐</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.similarSizeBannerTitle, { color: colors.primary }]}>
                        No exact match — try nearby sizes?
                      </Text>
                      <Text style={[styles.similarSizeBannerHint, { color: colors.primary + "bb" }]}>
                        Tap to widen each dimension by ±10% and search again
                      </Text>
                    </View>
                  </Pressable>
                ) : null}
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
        renderItem={({ item: listItem }) => {
          if (listItem.kind === "sizeUnknownHeader") {
            return (
              <View style={[styles.sizeUnknownHeader, { backgroundColor: colors.warning + "14", borderColor: colors.warning + "44" }]}>
                <Text style={[styles.sizeUnknownHeaderIcon, { color: colors.warning }]}>📏</Text>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.sizeUnknownHeaderTitle, { color: colors.warning }]}>
                    Size not measured ({listItem.count} {listItem.count === 1 ? "item" : "items"})
                  </Text>
                  <Text style={[styles.sizeUnknownHeaderHint, { color: colors.warning + "bb" }]}>
                    These items match your search but have no dimension data on file.
                  </Text>
                </View>
              </View>
            );
          }
          const { result, index } = listItem;
          return (
            <View style={styles.resultItem}>
              <ResultCard
                result={result}
                onEditItem={isAdmin ? (item) => router.push({ pathname: "/edit-item", params: { item: JSON.stringify(item) } }) : undefined}
                onShowOnMap={handleShowOnMap}
                onMeasure={isAdmin && listItem.kind === "sizeUnknown" ? setMeasureItem : undefined}
                onVariantsToggle={handleVariantsToggle(result.item)}
                rank={index}
                fontScale={textFontScale}
                sizeUnknown={listItem.kind === "sizeUnknown"}
              />
            </View>
          );
        }}
        contentContainerStyle={[styles.listContent, { paddingTop: filterHeaderHeight + 8 }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="none"
      />

        {/* Floating filter overlay — stacked above results */}
        <View
          style={styles.filterOverlayWrapper}
          onLayout={(e) => setFilterHeaderHeight(e.nativeEvent.layout.height)}
        >
          {!hasResults ? (
            <View style={styles.modeToggleRow}>
              <Text style={[styles.modeToggleLabel, { color: colors.foreground }]}>Browse:</Text>
              {([
                { key: "aisle" as SearchMode, label: "By Aisle", icon: "map-pin" as const },
                { key: "category" as SearchMode, label: "By Category", icon: "tag" as const },
              ]).map(m => (
                <Pressable
                  key={m.key}
                  onPress={() => setMode(m.key)}
                  style={[
                    styles.modeToggleBtn,
                    {
                      backgroundColor: mode === m.key ? colors.primary + "22" : colors.card,
                      borderColor: mode === m.key ? colors.primary + "88" : colors.border,
                    },
                  ]}
                >
                  <Feather name={m.icon} size={13} color={colors.foreground} />
                  <Text style={[styles.modeToggleBtnText, { color: colors.foreground }]}>
                    {m.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
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
          <View style={[styles.filterOverlay, { backgroundColor: colors.card }]}>
            <FilterPanel
              values={filters}
              onChange={handleChange}
              dimensionCounts={dimensionCounts}
            />
          </View>
        </View>
      </>
      )}
      </View>


      <PartDetailsEditor
        item={detailsItem}
        adminToken={adminToken}
        onClose={() => setDetailsItem(null)}
        onShowOnMap={handleShowOnMap}
      />

      <ReferenceModal open={showReference} onClose={() => setShowReference(false)} />

      {isAdmin && adminToken ? (
        <MeasurePartScreen
          visible={measureItem !== null}
          onClose={() => setMeasureItem(null)}
          onConfirm={handleMeasureConfirm}
          initialDims={null}
          adminToken={adminToken}
        />
      ) : null}
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
  modalOverlay: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
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
    justifyContent: "center",
  },
  searchBarClearBtnText: { fontSize: 14, fontFamily: "Inter_500Medium", textAlign: "center" },
  filterOverlayWrapper: {
    position: "absolute",
    top: 0,
    left: 12,
    right: 12,
    zIndex: 20,
  },
  filterOverlay: {
    borderRadius: 12,
    padding: 16,
  },
  modeToggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 8,
  },
  modeToggleLabel: { fontSize: 12, fontFamily: "Inter_600SemiBold", textDecorationLine: "underline" },
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
  staleCacheNote: {
    marginHorizontal: 16, marginBottom: 8, padding: 10,
    borderRadius: 8, borderWidth: 1,
  },
  staleCacheNoteText: { fontSize: 12, fontFamily: "Inter_500Medium" },
  emptyContainer: { alignItems: "center", padding: 40 },
  emptyEmoji: { fontSize: 48, marginBottom: 12 },
  emptyTitle: { fontSize: 18, fontFamily: "Inter_700Bold", marginBottom: 8 },
  emptyHint: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20, marginBottom: 8 },
  similarSizeBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 12,
    marginBottom: 4,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    width: "100%",
  },
  similarSizeBannerIcon: { fontSize: 22 },
  similarSizeBannerTitle: { fontSize: 14, fontFamily: "Inter_600SemiBold", marginBottom: 2 },
  similarSizeBannerHint: { fontSize: 12, fontFamily: "Inter_400Regular", lineHeight: 16 },
  welcomeContainer: { padding: 24, alignItems: "center" },
  welcomeEmoji: { fontSize: 48, marginBottom: 12 },
  welcomeTitle: { fontSize: 20, fontFamily: "Inter_700Bold", marginBottom: 8 },
  welcomeHint: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20, marginBottom: 20 },
  tipCard: { width: "100%", padding: 16, borderRadius: 8, borderWidth: 1 },
  tipTitle: { fontSize: 14, fontFamily: "Inter_600SemiBold", marginBottom: 8 },
  tipText: { fontSize: 13, fontFamily: "Inter_400Regular", marginBottom: 4, lineHeight: 18 },
  resultItem: { paddingHorizontal: 12 },
  sizeUnknownHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginHorizontal: 12,
    marginTop: 8,
    marginBottom: 4,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    gap: 10,
  },
  sizeUnknownHeaderIcon: { fontSize: 18, marginTop: 1 },
  sizeUnknownHeaderTitle: { fontSize: 13, fontFamily: "Inter_600SemiBold", marginBottom: 2 },
  sizeUnknownHeaderHint: { fontSize: 12, fontFamily: "Inter_400Regular", lineHeight: 16 },
  listContent: { paddingBottom: 0 },
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
});
