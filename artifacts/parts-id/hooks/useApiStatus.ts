import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";

export type ApiStatus = "ok" | "degraded" | "error" | "unknown";

export interface ApiStatusResult {
  status: ApiStatus;
  restarting: boolean;
  triggerRestart: () => Promise<void>;
}

interface UseApiStatusOptions {
  apiBase: string;
  adminToken: string | null;
  intervalMs?: number;
}

export function useApiStatus({
  apiBase,
  adminToken,
  intervalMs = 15_000,
}: UseApiStatusOptions): ApiStatusResult {
  const [status, setStatus] = useState<ApiStatus>("unknown");
  const [restarting, setRestarting] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const restartingRef = useRef(false);

  const poll = useCallback(async () => {
    if (restartingRef.current) return;
    try {
      const res = await fetch(`${apiBase}/healthz`, { cache: "no-store" });
      if (!res.ok) {
        setStatus("error");
        return;
      }
      const data = await res.json();
      const s = data?.status;
      if (s === "ok" || s === "degraded" || s === "error") {
        setStatus(s);
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  }, [apiBase]);

  // Idempotent: always clears any existing interval before starting a new one.
  const startPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    poll();
    intervalRef.current = setInterval(poll, intervalMs);
  }, [poll, intervalMs]);

  const stopPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // Only poll when the admin is authenticated and the tab is focused.
  useFocusEffect(
    useCallback(() => {
      if (!adminToken) return;
      startPolling();
      return () => {
        stopPolling();
      };
    }, [adminToken, startPolling, stopPolling]),
  );

  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, [stopPolling]);

  const triggerRestart = useCallback(async () => {
    if (!adminToken || restartingRef.current) return;
    restartingRef.current = true;
    setRestarting(true);
    setStatus("unknown");
    stopPolling();
    try {
      await fetch(`${apiBase}/admin/restart`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
    } catch {
      // Expected — process exits so the connection drops before a response arrives
    }
    // Poll until the server comes back (up to ~30 s)
    const maxAttempts = 20;
    let attempts = 0;
    const resumePoll = async () => {
      attempts++;
      try {
        const res = await fetch(`${apiBase}/healthz`, { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          const s = data?.status;
          setStatus(s === "ok" || s === "degraded" || s === "error" ? s : "ok");
          restartingRef.current = false;
          setRestarting(false);
          startPolling();
          return;
        }
      } catch {
        // Server still restarting
      }
      if (attempts < maxAttempts) {
        setTimeout(resumePoll, 1500);
      } else {
        setStatus("error");
        restartingRef.current = false;
        setRestarting(false);
        startPolling();
      }
    };
    setTimeout(resumePoll, 1500);
  }, [adminToken, apiBase, startPolling, stopPolling]);

  return { status, restarting, triggerRestart };
}
