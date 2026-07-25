/**
 * useMapAnchors — fetches and mutates map anchor-point calibration data.
 *
 * Anchors are only fetched when the user is an admin (adminToken required).
 * The hook exposes:
 *   anchors       — the current 0–3 saved anchor rows
 *   upsertAnchor  — save or update a slot (1, 2, or 3)
 *   deleteAnchor  — clear a slot (1, 2, or 3)
 *   refetch       — manual refresh
 *   loading       — true while the first fetch is in-flight
 *   error         — true if the last fetch failed
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { API_BASE } from "@/utils/apiBase";

export interface MapAnchor {
  id: number;
  name: string;
  svgX: number;
  svgY: number;
  worldX: number;
  worldY: number;
  updatedAt: string;
}

export interface UpsertAnchorPayload {
  name: string;
  svgX: number;
  svgY: number;
  worldX: number;
  worldY: number;
}

export function useMapAnchors(adminToken: string | null) {
  const [anchors, setAnchors] = useState<Array<MapAnchor>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const mountedRef = useRef(true);

  const refetch = useCallback(async () => {
    if (!adminToken || !API_BASE) return;
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`${API_BASE}/admin/map-anchors`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { anchors: Array<MapAnchor> };
      if (mountedRef.current) {
        setAnchors(data.anchors);
        setError(false);
      }
    } catch {
      if (mountedRef.current) setError(true);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [adminToken]);

  useEffect(() => {
    mountedRef.current = true;
    if (adminToken) refetch();
    return () => { mountedRef.current = false; };
  }, [adminToken, refetch]);

  const upsertAnchor = useCallback(
    async (slot: 1 | 2 | 3, payload: UpsertAnchorPayload): Promise<boolean> => {
      if (!adminToken || !API_BASE) return false;
      try {
        const res = await fetch(`${API_BASE}/admin/map-anchors/${slot}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify(payload),
        });
        if (!res.ok) return false;
        await refetch();
        return true;
      } catch {
        return false;
      }
    },
    [adminToken, refetch],
  );

  const deleteAnchor = useCallback(
    async (slot: 1 | 2 | 3): Promise<boolean> => {
      if (!adminToken || !API_BASE) return false;
      try {
        const res = await fetch(`${API_BASE}/admin/map-anchors/${slot}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${adminToken}` },
        });
        if (!res.ok) return false;
        await refetch();
        return true;
      } catch {
        return false;
      }
    },
    [adminToken, refetch],
  );

  return { anchors, loading, error, refetch, upsertAnchor, deleteAnchor };
}
