import { useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

const ZONES_CACHE_KEY = "parts_id_warehouse_zones_v1";
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export type ApiWarehouseZone = {
  id: number;
  aisleId: string;
  label: string;
  sectionParity: string;
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
  timestamp: number;
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

  const fetchZones = async (force = false) => {
    setError(false);
    if (!force) {
      try {
        const raw = await AsyncStorage.getItem(ZONES_CACHE_KEY);
        if (raw) {
          const cached: ZoneCache = JSON.parse(raw);
          if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
            if (mountedRef.current) {
              setZones(cached.zones);
              setLoading(false);
            }
            return;
          }
        }
      } catch { /* ignore cache errors */ }
    }

    try {
      const res = await fetch(`${API_BASE}/warehouse-zones`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: { zones: ApiWarehouseZone[] } = await res.json();
      if (mountedRef.current) {
        setZones(data.zones);
        setLoading(false);
      }
      try {
        const entry: ZoneCache = { timestamp: Date.now(), zones: data.zones };
        await AsyncStorage.setItem(ZONES_CACHE_KEY, JSON.stringify(entry));
      } catch { /* ignore cache write errors */ }
    } catch {
      if (mountedRef.current) {
        setError(true);
        setLoading(false);
        // Fall back to cached data even if stale
        try {
          const raw = await AsyncStorage.getItem(ZONES_CACHE_KEY);
          if (raw) {
            const cached: ZoneCache = JSON.parse(raw);
            setZones(cached.zones);
          }
        } catch { /* ignore */ }
      }
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    fetchZones();
    return () => { mountedRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { zones, loading, error, refetch: () => fetchZones(true) };
}
