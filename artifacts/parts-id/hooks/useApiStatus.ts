import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, AppStateStatus } from "react-native";

export type ApiStatus = "ok" | "degraded" | "error" | "unknown";
export type BotProbeStatus = "ok" | "timeout" | "404" | "error";

export interface ApiStatusResult {
  status: ApiStatus;
  restarting: boolean;
  triggerRestart: () => Promise<void>;
  bots: Record<string, BotProbeStatus>;
  probeSingleBot: (botName: string) => Promise<void>;
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
  const [bots, setBots] = useState<Record<string, BotProbeStatus>>({});
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const restartingRef = useRef(false);
  const isFocusedRef = useRef(false);

  const poll = useCallback(async () => {
    if (restartingRef.current) return;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await fetch(`${apiBase}/healthz`, { cache: "no-store", signal: controller.signal });
      clearTimeout(timeoutId);
      if (!res.ok) {
        setStatus("error");
        setBots({});
        return;
      }
      const data = await res.json();
      const s = data?.status;
      if (s === "ok" || s === "degraded" || s === "error") {
        setStatus(s);
      } else {
        setStatus("error");
      }
      if (data?.bots && typeof data.bots === "object" && !Array.isArray(data.bots)) {
        const VALID: Record<string, true> = { ok: true, timeout: true, "404": true, error: true };
        const validated: Record<string, BotProbeStatus> = {};
        for (const [k, v] of Object.entries(data.bots)) {
          if (typeof v === "string" && VALID[v]) validated[k] = v as BotProbeStatus;
        }
        setBots(validated);
      } else {
        setBots({});
      }
    } catch {
      clearTimeout(timeoutId);
      setStatus("error");
      setBots({});
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
      isFocusedRef.current = true;
      setStatus("unknown");
      startPolling();
      return () => {
        isFocusedRef.current = false;
        stopPolling();
      };
    }, [adminToken, startPolling, stopPolling]),
  );

  // Resume polling when the app returns to the foreground, regardless of
  // which tab navigation event last fired.
  useEffect(() => {
    const subscription = AppState.addEventListener(
      "change",
      (nextState: AppStateStatus) => {
        if (nextState === "active" && isFocusedRef.current && adminToken) {
          setStatus("unknown");
          startPolling();
        }
      },
    );
    return () => {
      subscription.remove();
    };
  }, [adminToken, startPolling]);

  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, [stopPolling]);

  const probeSingleBot = useCallback(async (botName: string): Promise<void> => {
    if (!adminToken) return;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await fetch(
        `${apiBase}/admin/ai-status/probe/${encodeURIComponent(botName)}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}` },
          signal: controller.signal,
          cache: "no-store",
        },
      );
      clearTimeout(timeoutId);
      if (!res.ok) return;
      const data = await res.json();
      if (data?.bots && typeof data.bots === "object" && !Array.isArray(data.bots)) {
        const VALID: Record<string, true> = { ok: true, timeout: true, "404": true, error: true };
        const validated: Record<string, BotProbeStatus> = {};
        for (const [k, v] of Object.entries(data.bots)) {
          if (typeof v === "string" && VALID[v]) validated[k] = v as BotProbeStatus;
        }
        setBots(validated);
      }
    } catch {
      clearTimeout(timeoutId);
    }
  }, [apiBase, adminToken]);

  const triggerRestart = useCallback(async () => {
    if (!adminToken || restartingRef.current) return;
    restartingRef.current = true;
    setRestarting(true);
    setStatus("unknown");
    stopPolling();
    const restartController = new AbortController();
    const restartTimeoutId = setTimeout(() => restartController.abort(), 10_000);
    try {
      await fetch(`${apiBase}/admin/restart`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` },
        signal: restartController.signal,
      });
    } catch {
      // Expected — process exits so the connection drops before a response arrives,
      // or the 10 s timeout fires if the server stalls before shutting down
    } finally {
      clearTimeout(restartTimeoutId);
    }
    // Poll until the server comes back (up to ~30 s)
    const maxAttempts = 20;
    let attempts = 0;
    const resumePoll = async () => {
      attempts++;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5_000);
      try {
        const res = await fetch(`${apiBase}/healthz`, { cache: "no-store", signal: controller.signal });
        clearTimeout(timeoutId);
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
        clearTimeout(timeoutId);
        // Server still restarting (or timed out)
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

  return { status, restarting, triggerRestart, bots, probeSingleBot };
}
