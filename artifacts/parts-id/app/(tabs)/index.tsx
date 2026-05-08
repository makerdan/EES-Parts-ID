/**
 * Search tab — the default landing screen and most-used surface.
 *
 * Hits POST /inventory/search (server-side trigram + ilike + dictionary
 * expansion) for online queries, with a Fuse.js client-side fallback
 * over the cached inventory in AppContext when the worker is offline.
 * Results render via ResultCard with FilterPanel chips and the
 * ResultRefinementBar for client-side refinement.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Fuse from "fuse.js";
import { useNavigation, useRouter } from "expo-router";
import { useSearchInventory } from "@workspace/api-client-react";
import type { InventoryItem, SearchResult } from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";
import { FilterPanel, ConfidenceSlider, CHIP_DIMS, type FilterValues } from "@/components/FilterPanel";
import { ResultCard } from "@/components/ResultCard";
import {
  ResultRefinementBar,
  applyRefinement,
  extractHighlightTokens,
  type RefinementState,
} from "@/components/ResultRefinementBar";
import { ReferenceModal } from "@/components/ReferenceModal";
import { KeywordEditor } from "@/components/KeywordEditor";
import BrowseTaxonomy, { type CategoryTreeNode } from "@/components/BrowseTaxonomy";
import { BrowseByAisle } from "@/components/BrowseByAisle";
import { useApp, DEFAULT_SETTINGS, type TextSize, type ThemeMode } from "@/contexts/AppContext";
import { Feather } from "@expo/vector-icons";
import { secondaryBtnBase } from "@/styles/shared";
import { parseTradeSizeInches, isConduitOrPipe } from "@/lib/tradeSize";
import { syncAllInventory as syncAllInventoryCore } from "@/lib/syncInventory";

const FUSE_CACHE_KEY = "parts_id_fuse_cache_v3";
const QUERY_CACHE_KEY = "parts_id_query_cache_v2";
const INVENTORY_VERSION_KEY = "parts_id_inventory_version";
const BROWSE_MODE_KEY = "parts_id_browse_mode_v1";
// Offline taxonomy assignments — { inventoryId → typeSlug } so Browse mode
// can list a Type's parts from the local Fuse cache when the network is down.
const ASSIGNMENTS_CACHE_KEY = "parts_id_category_assignments_v1";
// Cached category tree key — must match BrowseTaxonomy.tsx.
const BROWSE_TREE_CACHE_KEY = "parts_id_browse_tree_v1";

interface AssignmentRecord {
  inventoryId: number;
  typeSlug: string;
}

type Mode = "search" | "browse";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Old cache keys that should be cleaned up on first load
const STALE_CACHE_KEYS = ["parts_id_fuse_cache_v2", "parts_id_query_cache_v1"];

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : "http://localhost:8080/api";


type QueryCacheEntry = { timestamp: number; results: SearchResult[] };
type QueryCache = Record<string, QueryCacheEntry>;

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

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
  const { logout, clearCache, settings, updateSetting, textFontScale, isLoading: settingsLoading } = useApp();
  const [filters, setFilters] = useState<FilterValues>(DEFAULT_FILTERS);
  const [editItem, setEditItem] = useState<InventoryItem | null>(null);
  // Local overrides for items edited in the "Edit Part Details" modal — keeps
  // the displayed result card in sync with what was just saved on the server
  // without needing to re-run the search. Stored as Partial<InventoryItem> per
  // item id (currently description and/or aiKeywords).
  const [itemOverrides, setItemOverrides] = useState<Map<number, Partial<InventoryItem>>>(() => new Map());
  const [offlineResults, setOfflineResults] = useState<SearchResult[] | null>(null);
  // Local string state for the custom threshold TextInput in Settings
  const [confThresholdInput, setConfThresholdInput] = useState(String(DEFAULT_SETTINGS.defaultConfidenceThreshold));
  const [isOffline, setIsOffline] = useState(false);
  const [offlineCacheType, setOfflineCacheType] = useState<"exact" | "fuse" | null>(null);
  const [showLogoutModal, setShowLogoutModal] = useState(false);
  const [showRefModal, setShowRefModal] = useState(false);
  const [cacheClearedMsg, setCacheClearedMsg] = useState<string | null>(null);
  const [cacheAge, setCacheAge] = useState<string | null>(null);
  const [dimensionCounts, setDimensionCounts] = useState<Record<string, Record<string, number>> | undefined>(undefined);
  // ── Browse-by-Aisle overlay (separate from the taxonomy Browse mode) ─────
  // Opens a full-screen drill-down view (Aisle → Section → Shelf → Parts)
  // sourced from the local Fuse cache. Closing returns the worker to the
  // exact Search/Browse state they had — we don't touch `filters` or `mode`.
  const [aisleBrowseOpen, setAisleBrowseOpen] = useState(false);
  // ── Search vs Browse mode ─────────────────────────────────────────────────
  const [mode, setMode] = useState<Mode>("search");
  const [browseResults, setBrowseResults] = useState<SearchResult[] | null>(null);
  const [browseSelectedNode, setBrowseSelectedNode] = useState<CategoryTreeNode | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  // Restore last-used mode from AsyncStorage
  useEffect(() => {
    AsyncStorage.getItem(BROWSE_MODE_KEY).then(raw => {
      if (raw === "browse" || raw === "search") setMode(raw);
    }).catch(() => undefined);
  }, []);
  const switchMode = useCallback((next: Mode) => {
    setMode(next);
    AsyncStorage.setItem(BROWSE_MODE_KEY, next).catch(() => undefined);
  }, []);
  // When the user picks a node in Browse mode, fetch its items and surface
  // them through the same FlatList the search results use. Drilling further
  // (selecting a non-leaf) clears the displayed items so the user only sees
  // results once they reach a focused enough node.
  const fetchBrowseItems = useCallback((node: CategoryTreeNode) => {
    setBrowseLoading(true);
    setBrowseError(null);

    // Build the items URL with the same chip filters the user has set on
    // Search — Browse + chip refinement should compose, not be mutually
    // exclusive. confidenceThreshold is also forwarded so the existing
    // results-quality slider works in Browse too.
    const f = filtersRef.current;
    const params = new URLSearchParams();
    params.set("limit", "200");
    if (f.confidenceThreshold > 0) params.set("confidenceThreshold", String(f.confidenceThreshold));
    for (const dim of CHIP_DIMS) {
      const v = f[dim.key];
      if (typeof v === "string" && v.trim() !== "") params.set(String(dim.key), v);
    }

    fetch(`${API_BASE}/categories/${encodeURIComponent(node.slug)}/items?${params.toString()}`)
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ items: InventoryItem[] }>;
      })
      .then(data => {
        const wrapped: SearchResult[] = data.items.map(item => ({
          item,
          confidence: 1,
          matchReason: `In ${node.name}`,
          seriesLabel: undefined,
          variants: [],
        }));
        setBrowseResults(wrapped);
      })
      .catch(async err => {
        // Offline fallback: read the cached { inventoryId → typeSlug } map and
        // intersect with the cached Fuse items. Same chip filters are applied
        // client-side so refinement still works without the network.
        try {
          const raw = await AsyncStorage.getItem(ASSIGNMENTS_CACHE_KEY);
          if (raw) {
            const assignments = JSON.parse(raw) as AssignmentRecord[];
            const idsForType = new Set(
              assignments.filter(a => a.typeSlug === node.slug).map(a => a.inventoryId),
            );
            const cached = fuseItemsRef.current.filter(it => idsForType.has(it.id));
            const filteredCached = cached.filter(it => {
              const text = `${it.vendor} ${it.catalog} ${it.description} ${(it.aiKeywords ?? []).join(" ")}`.toLowerCase();
              for (const dim of CHIP_DIMS) {
                const v = f[dim.key];
                if (typeof v === "string" && v.trim() !== "") {
                  if (!text.includes(v.toLowerCase())) return false;
                }
              }
              return true;
            });
            const wrapped: SearchResult[] = filteredCached.slice(0, 200).map(item => ({
              item,
              confidence: 1,
              matchReason: `In ${node.name} (offline)`,
              seriesLabel: undefined,
              variants: [],
            }));
            setBrowseResults(wrapped);
            setBrowseError(null);
            return;
          }
        } catch { /* fall through to surfacing the original error */ }
        setBrowseError(String(err));
      })
      .finally(() => setBrowseLoading(false));
  }, []);

  const handleBrowseNodeChange = useCallback((node: CategoryTreeNode | null) => {
    setBrowseSelectedNode(node);
    if (!node || node.level !== "type") {
      setBrowseResults(null);
      return;
    }
    fetchBrowseItems(node);
  }, [fetchBrowseItems]);

  // Re-run the Browse fetch when chip filters change so chip parity matches
  // Search UX: the user can adjust filters after picking a Type and the
  // results refresh without re-tapping the leaf.
  useEffect(() => {
    if (mode !== "browse") return;
    if (!browseSelectedNode || browseSelectedNode.level !== "type") return;
    fetchBrowseItems(browseSelectedNode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, mode, browseSelectedNode, fetchBrowseItems]);

  // ── Drill-down refinement on already-returned results ──────────────────────
  // The refinement bar (chips + "Add keywords" input) appears whenever a
  // search returns results so workers can narrow the in-memory list without
  // another round-trip — works the same whether chips were used up front or
  // the user ran a plain search.
  const [refinement, setRefinement] = useState<RefinementState>({});
  // Local Fuse index seeded from AsyncStorage cache
  const fuseRef = useRef<Fuse<InventoryItem> | null>(null);
  const fuseItemsRef = useRef<InventoryItem[]>([]);
  // Search telemetry — last searchEventId returned by the server; null when
  // the server is offline, the insert timed out, or the worker is browsing.
  const searchEventIdRef = useRef<number | null>(null);
  const [cachedCount, setCachedCount] = useState(0);
  const [syncProgress, setSyncProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [syncError, setSyncError] = useState(false);
  const [syncRetry, setSyncRetry] = useState<{ attempt: number; max: number } | null>(null);
  // Explicit "sync is running" flag — set true the moment syncAllInventory starts
  // (before the first page returns), so the search guard fires even during the
  // initial fetch latency before syncProgress has any value.
  const [isSyncing, setIsSyncing] = useState(false);
  // Sync-in-progress warning popup (shown if user tries to search before sync finishes)
  const [syncWarningSec, setSyncWarningSec] = useState<number | null>(null);
  // Tracks when current sync started so we can estimate remaining seconds
  const syncStartedAtRef = useRef<number | null>(null);
  const syncInFlightRef = useRef(false);
  // Animated value for flashing the sync badge in the header
  const syncPulse = useRef(new Animated.Value(1)).current;
  // Track the running pulse animation so we can stop it before starting a new one
  // (prevents stacked loops from rapid Search taps).
  const syncPulseAnimRef = useRef<Animated.CompositeAnimation | null>(null);
  // Track latest filters in a ref so the onError closure always reads current values
  const filtersRef = useRef<FilterValues>(filters);
  useEffect(() => { filtersRef.current = filters; }, [filters]);
  // Timeout + abort tracking for slow-connection fallback
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchAbortedRef = useRef(false);

  // Keep the Settings modal text input in sync with the slider / persisted value.
  // This runs on every settings change so the input always reflects what was saved.
  useEffect(() => {
    setConfThresholdInput(String(settings.defaultConfidenceThreshold));
  }, [settings.defaultConfidenceThreshold]);

  // Apply the persisted default to the ACTIVE search filters exactly once —
  // when settings finish loading from AsyncStorage (settingsLoading: true→false).
  // After that point, changes made in the Settings modal do NOT overwrite the
  // threshold the worker has already chosen for the current search.
  // handleClear() already applies the new default when starting a fresh search.
  useEffect(() => {
    if (settingsLoading) return;
    setFilters(f => ({ ...f, confidenceThreshold: settings.defaultConfidenceThreshold }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsLoading]);

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

  // Fetch all inventory items in pages and build the Fuse cache.
  // Core logic lives in lib/syncInventory.ts so it can be unit-tested in
  // isolation; this wrapper wires up the component state callbacks and the
  // UI-only syncStartedAtRef timing used for the warning popup.
  const syncAllInventory = useCallback(async (serverVersion?: string) => {
    // Guard here mirrors the core guard so we only touch syncStartedAtRef
    // when a new sync is actually going to start. Without this, a concurrent
    // call would reset the timestamp that the warning-popup ETA relies on.
    if (syncInFlightRef.current) return;
    syncStartedAtRef.current = Date.now();
    await syncAllInventoryCore({
      apiBase: API_BASE,
      syncInFlightRef,
      callbacks: {
        setIsSyncing,
        setSyncProgress,
        setSyncError,
        setSyncRetry,
        buildFuseIndex,
      },
      storage: AsyncStorage,
      fuseKey: FUSE_CACHE_KEY,
      versionKey: INVENTORY_VERSION_KEY,
      assignmentsKey: ASSIGNMENTS_CACHE_KEY,
      treeKey: BROWSE_TREE_CACHE_KEY,
      serverVersion,
    });
    syncStartedAtRef.current = null;
  }, [buildFuseIndex]);

  // Auto-dismiss the warning popup the moment sync finishes — prevents the modal
  // from lingering after the underlying condition is gone.
  useEffect(() => {
    if (!isSyncing && syncWarningSec !== null) setSyncWarningSec(null);
  }, [isSyncing, syncWarningSec]);

  // Pulse the sync badge 3 times to draw attention. Stops any in-flight pulse
  // first so rapid taps don't stack overlapping animation loops.
  const flashSyncBadge = useCallback(() => {
    if (syncPulseAnimRef.current) syncPulseAnimRef.current.stop();
    syncPulse.setValue(1);
    const anim = Animated.sequence([
      Animated.timing(syncPulse, { toValue: 0.25, duration: 220, useNativeDriver: true }),
      Animated.timing(syncPulse, { toValue: 1, duration: 220, useNativeDriver: true }),
      Animated.timing(syncPulse, { toValue: 0.25, duration: 220, useNativeDriver: true }),
      Animated.timing(syncPulse, { toValue: 1, duration: 220, useNativeDriver: true }),
      Animated.timing(syncPulse, { toValue: 0.25, duration: 220, useNativeDriver: true }),
      Animated.timing(syncPulse, { toValue: 1, duration: 220, useNativeDriver: true }),
    ]);
    syncPulseAnimRef.current = anim;
    anim.start(() => {
      // Reset opacity to 1 in case the animation was interrupted mid-cycle.
      syncPulse.setValue(1);
      syncPulseAnimRef.current = null;
    });
  }, [syncPulse]);

  // Stop any in-flight pulse animation when the screen unmounts.
  useEffect(() => {
    return () => {
      if (syncPulseAnimRef.current) syncPulseAnimRef.current.stop();
    };
  }, []);

  // Seed local Fuse index from AsyncStorage on mount; sync from API if cache is empty
  useEffect(() => {
    // Remove stale cache keys from old versions (fire-and-forget)
    AsyncStorage.multiRemove(STALE_CACHE_KEYS).catch(() => {});

    AsyncStorage.multiGet([FUSE_CACHE_KEY, INVENTORY_VERSION_KEY])
      .then(async ([[, rawItems], [, storedVersion]]) => {
        // Always check server version to detect enrichment / import changes
        let serverVersion: string | null = null;
        try {
          const vRes = await fetch(`${API_BASE}/inventory/version`);
          if (vRes.ok) {
            const vData = (await vRes.json()) as { updatedAt: string | null };
            serverVersion = vData.updatedAt;
          }
        } catch {
          // Network unavailable — proceed with cached data as-is
        }

        // Treat storedVersion === null as "version unknown" — force a full sync so we
        // never silently serve a Fuse cache that pre-dates enrichment or imports.
        const cacheStale =
          serverVersion !== null &&
          (storedVersion === null || serverVersion > storedVersion);

        if (!rawItems || cacheStale) {
          // Cache empty or server has newer data — clear both caches and re-sync
          if (cacheStale) {
            await AsyncStorage.multiRemove([FUSE_CACHE_KEY, QUERY_CACHE_KEY]).catch(() => {});
          }
          if (!syncInFlightRef.current) syncAllInventory(serverVersion ?? undefined);
          return;
        }

        let items: InventoryItem[];
        try {
          items = JSON.parse(rawItems) as InventoryItem[];
        } catch {
          // Corrupt cache — clear it and re-sync
          await AsyncStorage.multiRemove([FUSE_CACHE_KEY, QUERY_CACHE_KEY]).catch(() => {});
          if (!syncInFlightRef.current) syncAllInventory(serverVersion ?? undefined);
          return;
        }
        buildFuseIndex(items);

        // If we got a new server version, store it (cache items were already up-to-date)
        if (serverVersion && serverVersion !== storedVersion) {
          AsyncStorage.setItem(INVENTORY_VERSION_KEY, serverVersion).catch(() => {});
        }
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
    // Clear telemetry ID: offline results are not from the server so any
    // click would be misattributed. Nulling here ensures no stale ID leaks.
    searchEventIdRef.current = null;
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
        setDimensionCounts(data.dimensionCounts as Record<string, Record<string, number>> | undefined);
        // Capture the telemetry event id so result-tap clicks can be correlated.
        searchEventIdRef.current = (data as unknown as { _telemetry?: { searchEventId?: number | null } })._telemetry?.searchEventId ?? null;

        // Check if inventory changed since we last synced; if so, trigger a full re-sync
        // so the Fuse index and query cache reflect the latest enrichment/import data.
        // The query-cache write is serialized inside this chain so it never races with
        // a concurrent multiRemove (which would let stale entries slip back in).
        const queryKey = buildQueryKey(filtersRef.current);
        fetch(`${API_BASE}/inventory/version`)
          .then(r => r.ok ? r.json() as Promise<{ updatedAt: string | null }> : Promise.reject())
          .then(async v => {
            if (!v.updatedAt) {
              // No version available — still write query-cache entry
              const cache = await loadQueryCache();
              const pruned = pruneExpired(cache);
              pruned[queryKey] = { timestamp: Date.now(), results: data.results ?? [] };
              saveQueryCache(pruned);
              return;
            }
            const storedVersion = await AsyncStorage.getItem(INVENTORY_VERSION_KEY);
            // Treat storedVersion === null as "version unknown" — same as stale
            if (storedVersion === null || v.updatedAt > storedVersion) {
              // Server has newer (or unknown) data — purge stale caches and trigger full re-sync.
              // Query-cache write is intentionally skipped: syncAllInventory will seed fresh data.
              await AsyncStorage.multiRemove([FUSE_CACHE_KEY, QUERY_CACHE_KEY]).catch(() => {});
              if (!syncInFlightRef.current) syncAllInventory(v.updatedAt);
              return;
            }

            // Inventory unchanged — merge search results into the existing Fuse cache,
            // persist the version stamp, and write the query-cache entry atomically.
            if (data.results?.length) {
              const newItems = data.results.map(r => r.item);
              const merged = [...fuseItemsRef.current];
              for (const item of newItems) {
                const idx = merged.findIndex(m => m.id === item.id);
                if (idx >= 0) merged[idx] = item;
                else merged.push(item);
              }
              buildFuseIndex(merged);
              AsyncStorage.multiSet([
                [FUSE_CACHE_KEY, JSON.stringify(merged)],
                [INVENTORY_VERSION_KEY, v.updatedAt],
              ]).catch(() => {});
            }

            // Write query-cache entry after confirming inventory is current
            const cache = await loadQueryCache();
            const pruned = pruneExpired(cache);
            pruned[queryKey] = { timestamp: Date.now(), results: data.results ?? [] };
            saveQueryCache(pruned);
          })
          .catch(async () => {
            // Version fetch failed — fall back to merging search results and writing query cache
            if (data.results?.length) {
              const newItems = data.results.map(r => r.item);
              const merged = [...fuseItemsRef.current];
              for (const item of newItems) {
                const idx = merged.findIndex(m => m.id === item.id);
                if (idx >= 0) merged[idx] = item;
                else merged.push(item);
              }
              buildFuseIndex(merged);
              AsyncStorage.setItem(FUSE_CACHE_KEY, JSON.stringify(merged)).catch(() => {});
            }
            const cache = await loadQueryCache();
            const pruned = pruneExpired(cache);
            pruned[queryKey] = { timestamp: Date.now(), results: data.results ?? [] };
            saveQueryCache(pruned);
          });
      },
      onError: () => {
        if (searchTimeoutRef.current) { clearTimeout(searchTimeoutRef.current); searchTimeoutRef.current = null; }
        searchEventIdRef.current = null; // error path — no valid result list shown
        if (!searchAbortedRef.current) runOfflineFallback(); // timeout already ran fallback — skip
      },
    },
  });

  const handleChange = (key: keyof FilterValues, value: string | number) => {
    setFilters(f => ({ ...f, [key]: value }));
  };

  // Fire a click telemetry event when a result card is first expanded.
  // The fetch is intentionally unawaited (fire-and-forget); we never block
  // the expand animation on telemetry success.
  const logResultClick = useCallback((resultId: number, rank: number) => {
    const seId = searchEventIdRef.current;
    if (!seId) return;
    fetch(`${API_BASE}/search/click`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        searchEventId: seId,
        resultId,
        resultRank: rank,
        action: "view",
      }),
    }).catch(() => {}); // swallow — telemetry is non-critical
  }, []);

  const SEARCH_TIMEOUT_MS = 8000;

  const handleSearch = () => {
    // If inventory is still syncing, block the search and warn the user.
    // We estimate remaining time from the throughput observed so far.
    // Guard on `isSyncing` (not just `syncProgress`) so the popup also fires
    // during the initial fetch before the first page returns.
    if (isSyncing) {
      let estSec: number;
      if (syncProgress && syncProgress.loaded > 0) {
        const startedAt = syncStartedAtRef.current ?? Date.now();
        const elapsedSec = Math.max(1, (Date.now() - startedAt) / 1000);
        const itemsPerSec = syncProgress.loaded / elapsedSec;
        const remaining = Math.max(0, syncProgress.total - syncProgress.loaded);
        estSec = Math.ceil(remaining / itemsPerSec);
      } else {
        // No progress yet — show a conservative default so the user knows to wait.
        estSec = 30;
      }
      // Floor at 5 s so we never tell the user "0 seconds".
      setSyncWarningSec(Math.max(5, estSec));
      flashSyncBadge();
      return;
    }
    Keyboard.dismiss();
    setOfflineResults(null);
    setIsOffline(false);
    setOfflineCacheType(null);
    searchAbortedRef.current = false;
    searchEventIdRef.current = null; // new search started — clear stale telemetry ID
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    // A new search resets any in-memory drill-down state — chips, "Add
    // keywords" input, and any other refinement future fields — so the bar
    // never silently lingers across searches.
    setRefinement({});
    const body = buildSearchBody(filters);
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
    searchEventIdRef.current = null; // results cleared — no click can be attributed
    setFilters({ ...DEFAULT_FILTERS, confidenceThreshold: settings.defaultConfidenceThreshold });
    searchMutation.reset();
    setOfflineResults(null);
    setIsOffline(false);
    setOfflineCacheType(null);
    setDimensionCounts(undefined);
    setRefinement({});
    // Returning to the empty Search screen also exits Browse mode — this
    // is the only way out now that the Browse toggle is hidden while
    // browsing. Reset the browse selection too so reopening Browse
    // starts at the top of the taxonomy.
    switchMode("search");
    setBrowseSelectedNode(null);
    setBrowseResults(null);
    setBrowseError(null);
    // Also dismiss the Browse-by-Aisle overlay so a repeat-tap of the
    // Search tab (or the "New Search" button / app-title tap) always
    // lands the worker back on the empty welcome state, regardless of
    // which secondary view they were in.
    setAisleBrowseOpen(false);
  };

  // Tap-Search-tab-to-reset: when the worker is already on the Search tab
  // and has results (or typed filters) on screen, tapping the Search tab
  // again should bring them back to the empty welcome state — same
  // behavior as the "New Search" button. We stash handleClear in a ref so
  // the listener subscribes exactly once and never resubscribes mid-search.
  const handleClearRef = useRef(handleClear);
  useEffect(() => { handleClearRef.current = handleClear; });
  const navigation = useNavigation();
  const router = useRouter();
  // Cap the Settings modal so on small iPhones (and at the in-app "L"
  // text size) the rows scroll inside the card instead of pushing
  // Done / Sign Out off-screen. We subtract the safe-area insets and a
  // bit of padding so the card never crowds the notch or home indicator.
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const settingsModalMaxHeight = Math.max(
    320,
    windowHeight - insets.top - insets.bottom - 64,
  );
  useEffect(() => {
    // `tabPress` is emitted by the React Navigation Tabs navigator on
    // every tap of the tab bar item, regardless of whether the screen
    // is already focused. Subscribe on BOTH this screen's navigation
    // and its parent — under expo-router's nested Stack→Tabs structure
    // the event reliably surfaces on the parent. This path covers
    // Android, web, and the classic (blur) iOS tab bar.
    //
    // NOTE: `tabPress` is NOT emitted by `expo-router/unstable-native-tabs`
    // on iOS — UITabBarController handles repeated tab selection
    // entirely natively (popToRoot / scrollToTop "special effects")
    // without re-emitting React Navigation events. The
    // `repeatTapResetScrollRef` ScrollView below is what catches the
    // native repeat-tap on iOS Liquid Glass and routes it to the same
    // `handleClear` flow.
    const unsubs: Array<() => void> = [];
    const handler = () => {
      if (navigation.isFocused()) handleClearRef.current();
    };
    unsubs.push(navigation.addListener("tabPress" as never, handler));
    const parent = navigation.getParent();
    if (parent) unsubs.push(parent.addListener("tabPress" as never, handler));
    return () => { for (const u of unsubs) u(); };
  }, [navigation]);

  // ── Tap-Search-tab-to-reset on iOS NativeTabs (Task #134) ─────────
  // `expo-router/unstable-native-tabs` does not emit `tabPress` events
  // for repeated taps on the focused tab — UITabBarController handles
  // them natively via react-native-screens' `repeatedTabSelection`
  // "special effects" (popToRoot / scrollToTop). We piggy-back on the
  // scrollToTop effect: it walks the first-subview chain (see
  // `RNSScrollViewFinder.findScrollViewInFirstDescendantChainFrom`)
  // and animates the first UIScrollView it finds back to its top.
  //
  // We keep an invisible 1×1 ScrollView pinned as the literal first
  // child inside this screen's SafeAreaView, hold it at contentOffset
  // y=1, and listen for the system scrolling it back to 0. When that
  // fires (and the screen is focused), we trigger the same
  // `handleClear` reset the classic-tab `tabPress` listener does, then
  // restore the offset so the next repeat tap fires again.
  //
  // Guarded to iOS only because this trick relies on UIKit semantics;
  // on Android/web the `tabPress` listener above handles the gesture
  // and this ScrollView would never be triggered anyway.
  const repeatTapResetScrollRef = useRef<ScrollView>(null);
  const repeatTapReadyRef = useRef(false);
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    // Defer one frame so the ScrollView has laid out (otherwise the
    // initial scrollTo silently no-ops because contentSize is still 0).
    const id = setTimeout(() => {
      repeatTapResetScrollRef.current?.scrollTo({ y: 1, animated: false });
      repeatTapReadyRef.current = true;
    }, 50);
    return () => clearTimeout(id);
  }, []);
  const onRepeatTapReset = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!repeatTapReadyRef.current) return;
    if (e.nativeEvent.contentOffset.y > 0.5) return;
    if (!navigation.isFocused()) return;
    handleClearRef.current();
    // Restore offset so subsequent repeat taps still trigger.
    requestAnimationFrame(() => {
      repeatTapResetScrollRef.current?.scrollTo({ y: 1, animated: false });
    });
  }, [navigation]);

  // Called by KeywordEditor after debounced save — update local Fuse index
  // immediately AND record an override so the currently-displayed result card
  // reflects the new keywords without waiting for the next search.
  const handleKeywordsChanged = useCallback((id: number, keywords: string[]) => {
    const items = fuseItemsRef.current.map(item =>
      item.id === id ? { ...item, aiKeywords: keywords } : item,
    );
    buildFuseIndex(items);
    AsyncStorage.setItem(FUSE_CACHE_KEY, JSON.stringify(items)).catch(() => {});
    setItemOverrides(prev => {
      const next = new Map(prev);
      next.set(id, { ...(next.get(id) ?? {}), aiKeywords: keywords });
      return next;
    });
  }, [buildFuseIndex]);

  // Same idea for descriptions edited via "Edit Part Details" — keeps the open
  // card in sync with what was just saved on the server.
  const handleDescriptionChanged = useCallback((id: number, description: string) => {
    const items = fuseItemsRef.current.map(item =>
      item.id === id ? { ...item, description } : item,
    );
    buildFuseIndex(items);
    AsyncStorage.setItem(FUSE_CACHE_KEY, JSON.stringify(items)).catch(() => {});
    setItemOverrides(prev => {
      const next = new Map(prev);
      next.set(id, { ...(next.get(id) ?? {}), description });
      return next;
    });
  }, [buildFuseIndex]);

  const handleSeriesChanged = useCallback((id: number, seriesName: string | null) => {
    setItemOverrides(prev => {
      const next = new Map(prev);
      next.set(id, { ...(next.get(id) ?? {}), seriesName });
      return next;
    });
  }, []);

  const rawResults: SearchResult[] =
    mode === "browse"
      ? browseResults ?? []
      : offlineResults ?? (searchMutation.data?.results ?? []);
  // Merge in any local edits so the result card immediately reflects what was
  // just saved through the modal. Variants are patched the same way.
  const results: SearchResult[] = useMemo(() => {
    const apply = (it: InventoryItem): InventoryItem => {
      const ov = itemOverrides.get(it.id);
      return ov ? { ...it, ...ov } : it;
    };
    const merged = itemOverrides.size === 0
      ? rawResults
      : rawResults.map(r => ({
          ...r,
          item: apply(r.item),
          variants: (r.variants ?? []).map(apply),
        }));

    // Default ordering: when no explicit sort is asked for, break ties on
    // relevance score by ascending trade-size for conduit / pipe items.
    // The server returns Browse results with uniform confidence (1.0), so
    // this reorders Browse cleanly small → large; in Search mode it only
    // affects results that are otherwise equivalently ranked.
    type Indexed = { r: SearchResult; idx: number; size: number | null };
    const indexed: Indexed[] = merged.map((r, idx) => {
      const it = r.item;
      const blob = `${it.catalog ?? ""} ${it.vendor ?? ""} ${it.description ?? ""}`;
      const size = isConduitOrPipe(blob)
        ? parseTradeSizeInches(it.catalog) ?? parseTradeSizeInches(it.description)
        : null;
      return { r, idx, size };
    });
    indexed.sort((a, b) => {
      // Primary key: relevance (confidence) descending, preserving the
      // server's ranking when scores differ meaningfully.
      const cd = (b.r.confidence ?? 0) - (a.r.confidence ?? 0);
      if (Math.abs(cd) > 1e-6) return cd;
      // Secondary key: trade size ascending; items without a parseable
      // size keep their original relative order after sized items.
      if (a.size !== null && b.size !== null) {
        if (a.size !== b.size) return a.size - b.size;
        return a.idx - b.idx;
      }
      if (a.size !== null) return -1;
      if (b.size !== null) return 1;
      return a.idx - b.idx;
    });
    return indexed.map(x => x.r);
  }, [rawResults, itemOverrides]);
  const belowThreshold = searchMutation.data?.belowThreshold ?? 0;
  const hasResults =
    mode === "browse"
      ? browseResults !== null
      : searchMutation.isSuccess || offlineResults !== null;
  // Results actually shown in the list — `results` filtered by any active
  // drill-down chips. When refinement is empty this is just `results`.
  const visibleResults: SearchResult[] = useMemo(
    () => applyRefinement(results, refinement),
    [results, refinement],
  );
  const refinementActive = Object.values(refinement).some(v => typeof v === "string" && v.trim() !== "");
  // Tokens passed to each ResultCard to highlight matched terms in the
  // visible text. Sourced from the same `refinement` state used by
  // applyRefinement so highlighting stays in sync with what the bar is
  // actually filtering on.
  const highlightTokens = useMemo(() => extractHighlightTokens(refinement), [refinement]);
  // Show the drill-down bar after any search that returned results. The bar
  // always renders the "Add keywords" input, plus chip rows when there's
  // variation across the result set (or chips were used up front).
  const showRefinementBar = hasResults && results.length > 0;
  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      {/*
        Invisible 1×1 ScrollView, MUST stay the literal first child of
        this SafeAreaView so iOS's `RNSScrollViewFinder` (first-subview
        chain walk) lands on it before any other ScrollView/FlatList in
        the screen. Catches the iOS NativeTabs repeated-tab-selection
        gesture and routes it to `handleClear`. See `onRepeatTapReset`
        above for the full explanation. iOS-only — no-op elsewhere.
      */}
      {Platform.OS === "ios" ? (
        <ScrollView
          ref={repeatTapResetScrollRef}
          // IMPORTANT: scrollsToTop must be FALSE here. iOS uses the
          // `scrollsToTop` flag for the status-bar tap gesture and
          // refuses to scroll any view if multiple on-screen
          // scrollviews have it enabled — leaving the default `true`
          // would silently break status-bar-tap-to-scroll on the
          // visible results FlatList. The repeat-tab-tap path we
          // care about uses `RNSScrollViewFinder`, which calls
          // `setContentOffset` directly and does NOT consult this
          // flag, so disabling it here costs us nothing.
          scrollsToTop={false}
          scrollEnabled={false}
          showsVerticalScrollIndicator={false}
          onMomentumScrollEnd={onRepeatTapReset}
          contentContainerStyle={styles.repeatTapResetContent}
          style={styles.repeatTapResetScroll}
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
      ) : null}
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <View style={{ flex: 1 }}>
          {/* Tapping the app title resets the Search screen back to the
              empty welcome state (same effect as the "New Search" button
              and tapping the Search tab while focused). */}
          <Pressable onPress={() => handleClearRef.current()} hitSlop={8}>
            <Text style={[styles.headerTitle, { color: colors.foreground }]}>Parts ID</Text>
          </Pressable>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 }}>
            {/* Sync progress — while fetching all inventory for offline cache */}
            {syncProgress ? (
              <Animated.View style={[styles.statusBadge, { backgroundColor: colors.muted, opacity: syncPulse }]}>
                <ActivityIndicator size={10} color={colors.mutedForeground} style={{ marginRight: 4 }} />
                <Text style={[styles.statusBadgeText, { color: colors.mutedForeground }]}>
                  {`Syncing ${syncProgress.loaded} / ${syncProgress.total}`}
                </Text>
              </Animated.View>
            ) : syncRetry ? (
              <Animated.View style={[styles.statusBadge, { backgroundColor: colors.warning + "22", opacity: syncPulse }]}>
                <ActivityIndicator size={10} color={colors.warning} style={{ marginRight: 4 }} />
                <Text style={[styles.statusBadgeText, { color: colors.warning }]}>
                  {`Retrying (${syncRetry.attempt}/${syncRetry.max})…`}
                </Text>
              </Animated.View>
            ) : syncError ? (
              <Pressable
                onPress={() => syncAllInventory()}
                style={[styles.statusBadge, { backgroundColor: colors.destructive + "18" }]}
              >
                <Feather name="alert-circle" size={10} color={colors.destructive} style={{ marginRight: 4 }} />
                <Text style={[styles.statusBadgeText, { color: colors.destructive }]}>
                  Sync failed — tap to retry
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
          <Pressable
            onPress={() => setShowRefModal(true)}
            style={[styles.headerBtn, styles.logoutBtn, { backgroundColor: colors.muted, borderColor: colors.border }]}
            accessibilityRole="button"
            accessibilityLabel="Open electrical reference"
          >
            <Feather name="book-open" size={16} color={colors.mutedForeground} />
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
        {/*
          KeyboardAvoidingView lifts the entire card on iOS when the
          keyboard appears, so the pinned footer (Done / Sign Out) and
          the focused custom-confidence input both stay visible. On
          Android the platform already resizes the window for us.
        */}
        <KeyboardAvoidingView
          style={[styles.modalOverlay, { backgroundColor: colors.overlay }]}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          {/*
            Settings card (Task #127): title pinned, rows scroll inside a
            keyboard-aware ScrollView, footer (Done / Sign Out) pinned at
            the bottom so it's reachable on every iPhone size and at every
            in-app text size. maxHeight is computed from the window minus
            safe-area insets so the card never extends off-screen.
          */}
          <View
            style={[
              styles.settingsModalCard,
              {
                backgroundColor: colors.card,
                borderColor: colors.border,
                maxHeight: settingsModalMaxHeight,
              },
            ]}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <View style={{ width: 3, height: 18, borderRadius: 2, backgroundColor: colors.primary }} />
              <Text style={[styles.settingsModalTitle, { marginBottom: 0, color: colors.foreground }]}>Settings</Text>
            </View>

            <KeyboardAwareScrollViewCompat
              style={styles.settingsModalScroll}
              contentContainerStyle={styles.settingsModalScrollContent}
              bottomOffset={20}
            >
              {/* Clear cache row */}
              <View style={[styles.settingsRow, { borderColor: colors.border }]}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.settingsRowLabel, { color: colors.foreground }]}>Search cache</Text>
                  <Text style={[styles.settingsRowHint, { color: colors.mutedForeground }]}>
                    Clears locally cached results.
                  </Text>
                  {cacheAge ? (
                    <Text style={[styles.settingsRowHint, { color: colors.mutedForeground, marginTop: 2 }]}>
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
                    Result text size.
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
                    Override system appearance.
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

              {/* Visual shelf view toggle */}
              <View style={[styles.settingsRow, { borderColor: colors.border }]}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.settingsRowLabel, { color: colors.foreground }]}>Visual shelf view</Text>
                  <Text style={[styles.settingsRowHint, { color: colors.mutedForeground }]}>
                    Show parts physically arranged on the shelf in Browse by Aisle.
                  </Text>
                </View>
                <Switch
                  value={settings.shelfViewEnabled}
                  onValueChange={v => updateSetting("shelfViewEnabled", v)}
                  trackColor={{ false: colors.muted, true: colors.primary + "99" }}
                  thumbColor={settings.shelfViewEnabled ? colors.primary : colors.mutedForeground}
                />
              </View>

              {/* Warehouse shelf view toggle */}
              <View style={[styles.settingsRow, { borderColor: colors.border }]}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.settingsRowLabel, { color: colors.foreground }]}>Warehouse shelf view</Text>
                  <Text style={[styles.settingsRowHint, { color: colors.mutedForeground }]}>
                    Shows all shelves in a section at once.
                  </Text>
                </View>
                <Switch
                  value={settings.warehouseShelfView}
                  onValueChange={v => updateSetting("warehouseShelfView", v)}
                  trackColor={{ false: colors.muted, true: colors.primary + "99" }}
                  thumbColor={settings.warehouseShelfView ? colors.primary : colors.mutedForeground}
                />
              </View>

              {/* Default confidence threshold row */}
              <View style={[styles.settingsRow, { borderColor: colors.border, flexDirection: "column", gap: 2 }]}>
                <Text style={[styles.settingsRowLabel, { color: colors.foreground }]}>Default min confidence</Text>
                <Text style={[styles.settingsRowHint, { color: colors.mutedForeground }]}>
                  Pre-fills the slider on new searches; doesn't change the current one.
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
            </KeyboardAwareScrollViewCompat>

            {/* Pinned footer */}
            <View style={[styles.settingsModalFooter, { borderTopColor: colors.border }]}>
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
        </KeyboardAvoidingView>
      </Modal>

      {/* Sync-in-progress warning — shown if user tries to search before sync completes */}
      <Modal
        visible={syncWarningSec !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setSyncWarningSec(null)}
      >
        <View style={[styles.modalOverlay, { backgroundColor: colors.overlay }]}>
          <View style={[styles.logoutModal, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <View style={{ width: 3, height: 18, borderRadius: 2, backgroundColor: colors.primary }} />
              <Text style={[styles.logoutModalTitle, { marginBottom: 0, color: colors.foreground }]}>
                Inventory still syncing
              </Text>
            </View>
            <Text style={[styles.logoutModalHint, { color: colors.mutedForeground }]}>
              {`Please wait about ${syncWarningSec ?? 0} second${syncWarningSec === 1 ? "" : "s"} for the inventory to finish loading before searching.`}
            </Text>
            <View style={styles.logoutModalBtns}>
              <Pressable
                onPress={() => setSyncWarningSec(null)}
                style={[styles.logoutModalConfirm, { backgroundColor: colors.primary }]}
              >
                <Text style={[styles.logoutModalConfirmText, { color: colors.primaryForeground }]}>OK</Text>
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

      {/* ── Browse-by-Aisle entry point — hidden while results are showing
          so the list can fill most of the screen. ─────────────────────── */}
      {!aisleBrowseOpen && !hasResults ? (
        <Pressable
          onPress={() => setAisleBrowseOpen(true)}
          style={[styles.aisleEntryBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
          accessibilityRole="button"
          accessibilityLabel="Browse parts by aisle, section, and shelf"
        >
          <Feather name="map-pin" size={16} color={colors.primary} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.aisleEntryTitle, { color: colors.foreground }]}>
              Browse by Aisle
            </Text>
            <Text style={[styles.aisleEntryHint, { color: colors.mutedForeground }]}>
              Walk the warehouse: Aisle › Section › Shelf
            </Text>
          </View>
          <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
        </Pressable>
      ) : null}

      {/* ── Browse-by-Aisle overlay ──────────────────────────────────────── */}
      {aisleBrowseOpen ? (
        <BrowseByAisle
          inventory={fuseItemsRef.current}
          cacheReady={!isSyncing}
          onClose={() => setAisleBrowseOpen(false)}
          fontScale={textFontScale}
          onEditKeywords={setEditItem}
          shelfViewEnabled={settings.shelfViewEnabled}
        />
      ) : null}

      {/* ── Search bar — only shown in Search mode (Browse drives its own picker) ── */}
      {!aisleBrowseOpen && mode === "search" ? (
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
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              {!searchMutation.isPending && <Feather name="search" size={16} color="#000" />}
              <Text style={[styles.searchBarSearchBtnText, { color: '#000' }]}>
                {searchMutation.isPending ? "…" : "Search"}
              </Text>
            </View>
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
      ) : null}

      {!aisleBrowseOpen ? (
      <>
      {/* ── Browse mode toggle ──────────────────────────────────────────── */}
      {/* Only visible in Search mode — once the worker is browsing the
          taxonomy, the toggle is hidden to free up vertical space. To
          return to Search mode, tap the "⚡ Parts ID" title in the
          header (which clears state) or re-tap the Search tab. */}
      {mode !== "browse" && !hasResults ? (
        <View style={[styles.modeToggleRow, { borderColor: colors.border }]}>
          <Pressable
            onPress={() => switchMode("browse")}
            style={[
              styles.modeToggleBtn,
              {
                backgroundColor: colors.card,
                borderColor: "rgba(0,0,0,0.75)",
              },
            ]}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Feather name="folder" size={14} color={colors.foreground} />
              <Text style={[styles.modeToggleText, { color: colors.foreground }]}>Browse Categories</Text>
            </View>
          </Pressable>
        </View>
      ) : null}

      {/* ── Advanced Filters (Search mode) OR Browse panel (Browse mode) ──
          In Browse mode we let this region grow (flex: 1) since the welcome
          state is hidden and there are usually no Search results competing
          for vertical room. */}
      <ScrollView
        style={mode === "browse" ? { maxHeight: "90%" } : hasResults ? { maxHeight: 96 } : { maxHeight: "50%" }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.filterCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <FilterPanel
            values={filters}
            onChange={handleChange}
            dimensionCounts={dimensionCounts}
          />
        </View>
        {mode === "browse" ? (
          <View>
            <BrowseTaxonomy onSelectNode={handleBrowseNodeChange} />
            {browseLoading ? (
              <Text style={[styles.refinementHint, { color: colors.mutedForeground }]}>
                Loading items in {browseSelectedNode?.name ?? "category"}…
              </Text>
            ) : null}
            {browseError ? (
              <Text style={[styles.refinementHint, { color: colors.destructive }]}>
                Couldn't load items: {browseError}
              </Text>
            ) : null}
            {browseSelectedNode && !browseLoading && (browseResults?.length ?? 0) > 0 ? (
              <Text style={[styles.refinementHint, { color: colors.mutedForeground }]}>
                Showing items in {browseSelectedNode.name}.
              </Text>
            ) : null}
          </View>
        ) : null}
      </ScrollView>

      <FlatList
        data={visibleResults}
        keyExtractor={item => String(item.item.id)}
        // IMPORTANT: pass a JSX element here, NOT an inline `() => (...)`
        // function. An inline arrow creates a fresh component type on every
        // render, which makes FlatList unmount/remount the header subtree
        // and silently swallow in-flight Pressable taps — this is what
        // broke the "New Search" button.
        ListHeaderComponent={(
          <View>
            {/* Results header */}
            {hasResults ? (
              <View>
                <View style={styles.resultsHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.resultsCount, { color: colors.foreground }]}>
                      {refinementActive
                        ? `${visibleResults.length} of ${results.length} shown`
                        : `${results.length} ${isOffline ? "offline " : ""}match${results.length !== 1 ? "es" : ""} found`}
                    </Text>
                    {refinementActive ? (
                      <Pressable onPress={() => setRefinement({})} hitSlop={6}>
                        <Text style={[styles.clearRefinementLink, { color: colors.primary }]}>
                          Clear refinement
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                  <Pressable
                    onPress={handleClear}
                    style={[styles.secondaryBtn, styles.newSearchBtn, { borderColor: colors.border }]}
                  >
                    <Text style={[styles.newSearchText, { color: colors.primary }]}>New Search</Text>
                  </Pressable>
                </View>
                {/* Drill-down refinement bar — "Add keywords" input + chip
                    rows for any result-set variation. Always shown after a
                    search returning results. */}
                {showRefinementBar ? (
                  <ResultRefinementBar
                    results={results}
                    refinement={refinement}
                    onChange={setRefinement}
                  />
                ) : null}
                {/* Refinement filtered everything out */}
                {refinementActive && visibleResults.length === 0 ? (
                  <View style={[styles.refinementEmpty, { borderColor: colors.border, backgroundColor: colors.card }]}>
                    <Text style={[styles.refinementEmptyText, { color: colors.mutedForeground }]}>
                      No results match the current refinement. Tap a chip again to remove it, or
                    </Text>
                    <Pressable onPress={() => setRefinement({})} hitSlop={6}>
                      <Text style={[styles.clearRefinementLink, { color: colors.primary, marginTop: 4 }]}>
                        Clear refinement
                      </Text>
                    </Pressable>
                  </View>
                ) : null}
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
                  Searching Database…
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
                <Feather name="search" size={48} color={colors.mutedForeground} style={{ marginBottom: 12 }} />
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

          </View>
        )}
        renderItem={({ item: result, index }) => (
          <View style={styles.resultItem}>
            <ResultCard result={result} onEditKeywords={setEditItem} rank={index} fontScale={textFontScale} highlightTokens={highlightTokens} onFirstExpand={() => logResultClick(result.item.id, index)} />
          </View>
        )}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="none"
      />
      </>
      ) : null}

      <ReferenceModal open={showRefModal} onClose={() => setShowRefModal(false)} />

      <KeywordEditor
        item={editItem}
        onClose={() => setEditItem(null)}
        onKeywordsChanged={handleKeywordsChanged}
        onDescriptionChanged={handleDescriptionChanged}
        onSeriesChanged={handleSeriesChanged}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  // Invisible 1×1 ScrollView used to catch the iOS NativeTabs
  // repeated-tab-selection gesture. Absolutely positioned and pinned to
  // 1×1 so it never affects layout, with content height > frame height
  // so the system can actually animate contentOffset back to 0.
  repeatTapResetScroll: {
    position: "absolute",
    top: 0,
    left: 0,
    width: 1,
    height: 1,
    opacity: 0,
  },
  repeatTapResetContent: { height: 2 },
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
  // iOS renders the 9 pt "Settings" label slightly wider than Android/web,
  // so the previous fixed 48 px width caused it to wrap onto two lines.
  // Bump the width on iOS only; other platforms keep the original size.
  logoutBtn: {
    width: Platform.OS === "ios" ? 60 : 48,
    flexDirection: "column",
    gap: 2,
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  logoutBtnLabel: { fontSize: 9, fontFamily: "Inter_500Medium", letterSpacing: 0.2 },
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
  },
  searchBarClearBtnText: { fontSize: 14, fontFamily: "Inter_500Medium" },
  filterCard: {
    marginHorizontal: 12,
    // Extra bottom margin opens up breathing room between the (collapsed)
    // Advanced Filters bar and the results list directly below it.
    marginBottom: 12,
    // Slimmer outer padding makes the card itself thinner; combined with
    // the slimmer FilterPanel container padding, the collapsed bar takes
    // noticeably less vertical space.
    padding: 8,
    borderRadius: 12,
    borderWidth: 1,
  },
  aisleEntryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 12,
    marginTop: 12,
    marginBottom: 4,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  aisleEntryTitle: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  aisleEntryHint: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  modeToggleRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 12,
    // Tighter bottom padding pulls the Advanced Filters card up so it sits
    // closer to the search bar and further from the results list.
    paddingBottom: 2,
  },
  modeToggleBtn: {
    paddingVertical: 8,
    paddingHorizontal: 18,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
  },
  modeToggleText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  resultsHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  resultsCount: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  clearRefinementLink: { fontSize: 12, fontFamily: "Inter_500Medium", marginTop: 2 },
  // Small inline status text rendered under the Browse panel (loading,
  // error, "showing items in X"). Re-introduced after task #101 removed
  // the original refinementHint usage on the search side.
  refinementHint: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  refinementEmpty: {
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
  },
  refinementEmptyText: { fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 18 },
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
  emptyTitle: { fontSize: 18, fontFamily: "Inter_700Bold", marginBottom: 8 },
  emptyHint: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20, marginBottom: 8 },
  resultItem: { paddingHorizontal: 12 },
  listContent: { paddingBottom: 120 },
  // Settings modal (Task #127). The card has a title row, a scrolling
  // body, and a pinned footer; the card is column-flex so the footer
  // hugs the bottom regardless of body content.
  settingsModalCard: {
    width: "100%",
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 12,
    flexDirection: "column",
  },
  settingsModalTitle: { fontSize: 18, fontFamily: "Inter_700Bold", marginBottom: 4 },
  settingsModalScroll: { flexShrink: 1 },
  settingsModalScrollContent: { paddingBottom: 8 },
  settingsModalFooter: {
    flexDirection: "row",
    gap: 10,
    paddingTop: 10,
    marginTop: 4,
    borderTopWidth: 1,
  },
  settingsRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    paddingVertical: 9,
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
