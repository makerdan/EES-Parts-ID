/**
 * useWarehouseZones — fetches warehouse zone definitions from the API.
 *
 * Behaviour:
 * - Returns cached data immediately if available.
 * - Starts a background fetch to keep data fresh; skips if a fetch completed
 *   within the last FOREGROUND_REFETCH_TTL_MS (2 minutes) to avoid hammering
 *   the server on every foreground resume.
 * - Skips duplicate in-flight fetches (fetchingRef guard).
 * - Re-fetches on app foreground only when data is stale per TTL.
 * - Token-available re-fetch is skipped when a fetch is already in-flight.
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

/** Minimum time between foreground-triggered re-fetches (2 minutes). */
const FOREGROUND_REFETCH_TTL_MS = 2 * 60 * 1000;

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
  // Timestamp (Date.now()) of the last successful background fetch.
  // Used by the foreground AppState listener to skip re-fetches that are
  // younger than FOREGROUND_REFETCH_TTL_MS.
  const lastFetchedAtRef = useRef<number | null>(null);
  // True once we have zones from either cache or a successful fetch.
  // When true, background-refresh failures are silent (map works offline).
  const hasDataRef = useRef(false);
  // True when a 401 was received while hasDataRef is already true (mid-session
  // token expiry). The tokenAvailable subscriber uses this to trigger a reload
  // even though we already have cached data, so fresh data arrives once the
  // user re-authenticates instead of waiting for the next foreground event.
  const tokenExpiredMidSessionRef = useRef(false);

  const refetch = useCallback(async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    // Capture token presence before the fetch begins.  This lets us tell the
    // difference between two superficially similar failure modes that both
    // end with getAuthToken() === null by the time the catch block runs:
    //
    //   • Cold-start race: no token was ever present → suppress the error badge
    //     and wait for the tokenAvailable subscriber to re-fire once the token
    //     arrives.  Showing a badge here would be a false alarm.
    //
    //   • Mid-session expiry with no cache: a token WAS present when we fired
    //     but the server returned 401 and onUnauthorized cleared it.  The user
    //     has no cached data to fall back on, so the map is genuinely broken
    //     and the error badge should appear.
    const hadToken = getAuthToken() !== null;
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
        tokenExpiredMidSessionRef.current = false;
        lastFetchedAtRef.current = Date.now();
      }
      const entry: ZoneCache = { zones: data.zones };
      await AsyncStorage.setItem(ZONES_CACHE_KEY, JSON.stringify(entry)).catch(() => {});
    } catch (err) {
      if (mountedRef.current) {
        const is401 = err instanceof Error && err.message === "HTTP 401";
        // True cold-start race: no token was present before the fetch, so the
        // tokenAvailable subscriber will re-fire when auth settles.
        const isColdStartRace = !hadToken;
        // Suppress the error badge when:
        //   • we already have cached data (the map is still usable), OR
        //   • it is a genuine cold-start race (token not yet issued).
        // In all other cases surface the error so the user is not left staring
        // at an empty, badge-free map with no way to know something is wrong.
        const suppressError = hasDataRef.current || isColdStartRace;
        if (!suppressError) {
          setError(true);
        }
        // Mid-session expiry: we already have data but the token just expired.
        // Mark it so the tokenAvailable subscriber will reload once a new token
        // arrives (e.g. after the user re-authenticates).
        if (hasDataRef.current && (is401 || isColdStartRace)) {
          tokenExpiredMidSessionRef.current = true;
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

      refetch();
    })();

    return () => { mountedRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch when app returns to foreground, but only if data is older than
  // FOREGROUND_REFETCH_TTL_MS. This prevents hammering the server on every
  // short app-switch (e.g. copy-paste from another app).
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (state !== "active") return;
      const lastFetchedAt = lastFetchedAtRef.current;
      if (lastFetchedAt !== null && Date.now() - lastFetchedAt < FOREGROUND_REFETCH_TTL_MS) {
        return;
      }
      refetch();
    });
    return () => sub.remove();
  }, [refetch]);

  // Re-fetch once auth settles in two cases:
  //   1. Cold-start race: initial fetch fired before a token was available.
  //   2. Mid-session expiry: a 401 was received while zones were already loaded,
  //      meaning the token expired and was cleared by onUnauthorized. We reload
  //      once the user re-authenticates so fresh data arrives promptly.
  // Routine background token refreshes (token still present) do NOT trigger
  // a reload — the guard ensures this only fires after a null→non-null transition.
  // Additionally, if a fetch is already in-flight (e.g. the mount effect started
  // one before the token settled), we skip the redundant call entirely rather
  // than relying solely on the fetchingRef guard inside refetch.
  useEffect(() => {
    const handleTokenAvailable = () => {
      if (fetchingRef.current) return;
      if (!hasDataRef.current || tokenExpiredMidSessionRef.current) {
        refetch();
      }
    };
    subscribeToTokenAvailable(handleTokenAvailable);
    return () => unsubscribeFromTokenAvailable(handleTokenAvailable);
  }, [refetch]);

  return { zones, loading, error, refetch };
}
