/**
 * useWarehouseZones — fetches warehouse zone definitions from the API.
 *
 * Behaviour:
 * - Returns cached data immediately if available.
 * - Always starts a background fetch to keep data fresh (no TTL gate).
 * - Skips duplicate in-flight fetches (fetchingRef guard).
 * - Re-fetches on app foreground via AppState subscription.
 * - Caller can trigger an explicit refresh via `refetch()` (e.g. on tab focus).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

const ZONES_CACHE_KEY = "parts_id_warehouse_zones_v1";

export type ApiWarehouseZone = {
  id: number;
  aisleId: string;
  label: string;
  sectionParity: "odd" | "even" | "all";
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
  zones: ApiWarehouseZone[];
};

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : "http://localhost:8080/api";

export function useWarehouseZones() {
  const [zones, setZones] = useState<ApiWarehouseZone[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const mountedRef = useRef(true);
  const fetchingRef = useRef(false);

  // Background fetch — deduplicates concurrent calls via fetchingRef.
  // Does NOT reset the flag externally; only the fetch itself clears it.
  const backgroundFetch = useCallback(async () => {
    if (fetchingRef.current) return; // already in flight — skip
    fetchingRef.current = true;
    try {
      const res = await fetch(`${API_BASE}/warehouse-zones`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: { zones: ApiWarehouseZone[] } = await res.json();
      if (mountedRef.current) {
        setZones(data.zones);
        setError(false);
        setLoading(false);
      }
      const entry: ZoneCache = { zones: data.zones };
      await AsyncStorage.setItem(ZONES_CACHE_KEY, JSON.stringify(entry)).catch(() => {});
    } catch {
      if (mountedRef.current) {
        setError(true);
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
          }
        }
      } catch { /* ignore corrupt cache */ }

      // Always refresh in the background after serving the cache.
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

  // Explicit refetch for tab-focus calls from the screen.
  // Does not override the in-flight guard; backgroundFetch() will no-op if
  // a fetch is already running.
  const refetch = useCallback(() => {
    backgroundFetch();
  }, [backgroundFetch]);

  return { zones, loading, error, refetch };
}
