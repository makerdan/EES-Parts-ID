import { HealthCheckResponse } from "@workspace/api-zod";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, AppStateStatus } from "react-native";

export type ApiStatus = "ok" | "degraded" | "error" | "unknown";
export type BotProbeStatus = "ok" | "timeout" | "404" | "error";

export interface ApiStatusResult {
  status: ApiStatus;
  restarting: boolean;
  triggerRestart: () => Promise<void>;
  checkStatus: () => Promise<void>;
  bots: Record<string, BotProbeStatus>;
  probeSingleBot: (botName: string) => Promise<void>;
  reportNetworkFailure: () => void;
}

interface UseApiStatusOptions {
  apiBase: string;
  adminToken: string | null;
  intervalMs?: number;
  restartPostTimeoutMs?: number;
  resumePollTimeoutMs?: number;
}

export function useApiStatus({
  apiBase,
  adminToken,
  intervalMs = 15_000,
  restartPostTimeoutMs = 10_000,
  resumePollTimeoutMs = 5_000,
}: UseApiStatusOptions): ApiStatusResult {
  const [status, setStatus] = useState<ApiStatus>("unknown");
  const [restarting, setRestarting] = useState(false);
  const [bots, setBots] = useState<Record<string, BotProbeStatus>>({});
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const restartingRef = useRef(false);
  const isFocusedRef = useRef(false);
  const isMountedRef = useRef(true);
  const restartTimerIdsRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);

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
      const raw = await res.json();
      const parsed = HealthCheckResponse.safeParse(raw);
      if (!parsed.success) {
        console.warn("[useApiStatus] Unexpected healthz shape:", parsed.error.message);
        setStatus("error");
        setBots({});
        return;
      }
      setStatus(parsed.data.status);
      setBots(parsed.data.bots ?? {});
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
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      stopPolling();
      for (const id of restartTimerIdsRef.current) clearTimeout(id);
      restartTimerIdsRef.current = [];
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
      const raw = await res.json();
      const parsed = HealthCheckResponse.safeParse(raw);
      if (parsed.success && parsed.data.bots) {
        setBots(parsed.data.bots);
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
    const restartTimeoutId = setTimeout(() => restartController.abort(), restartPostTimeoutMs);
    try {
      await fetch(`${apiBase}/admin/restart`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` },
        signal: restartController.signal,
      });
    } catch {
      // Expected — process exits so the connection drops before a response arrives,
      // or the timeout fires if the server stalls before shutting down
    } finally {
      clearTimeout(restartTimeoutId);
    }
    // Poll until the server comes back (up to ~30 s)
    const maxAttempts = 20;
    let attempts = 0;
    const resumePoll = async () => {
      attempts++;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), resumePollTimeoutMs);
      try {
        const res = await fetch(`${apiBase}/healthz`, { cache: "no-store", signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.ok) {
          const data = await res.json();
          const s = data?.status;
          restartingRef.current = false;
          restartTimerIdsRef.current = [];
          if (isMountedRef.current) {
            setStatus(s === "ok" || s === "degraded" || s === "error" ? s : "ok");
            setRestarting(false);
            startPolling();
          }
          return;
        }
      } catch {
        clearTimeout(timeoutId);
        // Server still restarting (or timed out)
      }
      if (attempts < maxAttempts) {
        const tid = setTimeout(resumePoll, 1500);
        restartTimerIdsRef.current.push(tid);
      } else {
        restartingRef.current = false;
        restartTimerIdsRef.current = [];
        if (isMountedRef.current) {
          setStatus("error");
          setRestarting(false);
          startPolling();
        }
      }
    };
    const tid = setTimeout(resumePoll, 1500);
    restartTimerIdsRef.current.push(tid);
  }, [adminToken, apiBase, restartPostTimeoutMs, resumePollTimeoutMs, startPolling, stopPolling]);

  const reportNetworkFailure = useCallback(() => {
    setStatus("error");
    setBots({});
  }, []);

  return { status, restarting, triggerRestart, checkStatus: poll, bots, probeSingleBot, reportNetworkFailure };
}
