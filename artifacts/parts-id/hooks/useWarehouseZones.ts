/**
 * useWarehouseZones — fetches warehouse zone definitions from the API.
 *
 * Behaviour:
 * - Returns cached data immediately if available.
 * - Always starts a background fetch to keep data fresh (no TTL gate).
 * - Skips duplicate in-flight fetches (fetchingRef guard).
 * - Re-fetches on app foreground via AppState subscription.
 * - Caller can trigger an explicit refresh via `refetch()` (e.g. on tab focus).
 * - Error badge is suppressed when cached zones are already loaded — the map
 *   works offline as long as a prior successful fetch has been cached.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";

import { API_BASE } from "@/utils/apiBase";
import { fetchWithAuth, getAuthToken, subscribeToTokenAvailable, unsubscribeFromTokenAvailable } from "@/utils/appAuth";
import { retryAsync } from "@/utils/retryAsync";

const ZONES_CACHE_KEY = "parts_id_warehouse_zones_v1";

export type ApiWarehouseZone = {
  id: number;
  aisleId: string;
  sectionNum: number;
  isInventory: boolean;
  svgX: number;
  svgY: number;
  svgWidth: number;
  svgHeight: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

type ZoneCache = {
  zones: Array<ApiWarehouseZone>;
};

export function useWarehouseZones() {
  const [zones, setZones] = useState<Array<ApiWarehouseZone>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const mountedRef = useRef(true);
  const fetchingRef = useRef(false);
  // True once we have zones from either cache or a successful fetch.
  // When true, background-refresh failures are silent (map works offline).
  const hasDataRef = useRef(false);

  const backgroundFetch = useCallback(async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      const data: { zones: Array<ApiWarehouseZone> } = await retryAsync(async () => {
        const res = await fetchWithAuth(`${API_BASE}/warehouse-zones`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      });
      if (mountedRef.current) {
        setZones(data.zones);
        setError(false);
        setLoading(false);
        hasDataRef.current = true;
      }
      const entry: ZoneCache = { zones: data.zones };
      await AsyncStorage.setItem(ZONES_CACHE_KEY, JSON.stringify(entry)).catch(() => {});
    } catch (err) {
      if (mountedRef.current) {
        // Suppress the error badge when the failure is auth-related:
        //   • no token present at fetch time (cold-start race), OR
        //   • the server returned 401 (token expired / not yet issued).
        // In both cases the tokenAvailable subscriber will re-fire backgroundFetch
        // once auth settles, so showing an error badge here is a false alarm.
        const isAuthFailure =
          getAuthToken() === null ||
          (err instanceof Error && err.message === "HTTP 401");
        if (!hasDataRef.current && !isAuthFailure) {
          setError(true);
        }
        setLoading(false);
      }
    } finally {
      fetchingRef.current = false;
    }
  }, []);

  // Initial load: serve cache immediately, then background-refresh.
  useEffect(() => {
    mountedRef.current = true;

    (async () => {
      try {
        const raw = await AsyncStorage.getItem(ZONES_CACHE_KEY);
        if (raw) {
          const cached: ZoneCache = JSON.parse(raw);
          if (mountedRef.current) {
            setZones(cached.zones);
            setLoading(false);
            hasDataRef.current = true;
          }
        }
      } catch { /* ignore corrupt cache */ }

      backgroundFetch();
    })();

    return () => { mountedRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch when app returns to foreground.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (state === "active") {
        backgroundFetch();
      }
    });
    return () => sub.remove();
  }, [backgroundFetch]);

  // Re-fetch once auth settles if the initial fetch fired before a token was
  // available (cold-start race: token refresh in flight on first tab visit).
  // Only triggers when a token transitions null → non-null and we still have
  // no data, so it does not fire on routine background token refreshes.
  useEffect(() => {
    const handleTokenAvailable = () => {
      if (!hasDataRef.current) {
        backgroundFetch();
      }
    };
    subscribeToTokenAvailable(handleTokenAvailable);
    return () => unsubscribeFromTokenAvailable(handleTokenAvailable);
  }, [backgroundFetch]);

  const refetch = useCallback(() => {
    backgroundFetch();
  }, [backgroundFetch]);

  return { zones, loading, error, refetch };
}
