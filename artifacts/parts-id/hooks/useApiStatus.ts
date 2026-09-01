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
  const generationRef = useRef(0);
  const pollInFlightRef = useRef(false);
  const pollControllerRef = useRef<AbortController | null>(null);
  const probeControllersRef = useRef<Set<AbortController>>(new Set());
  const restartControllerRef = useRef<AbortController | null>(null);
  const recoveryControllerRef = useRef<AbortController | null>(null);

  const poll = useCallback(async () => {
    if (!isMountedRef.current || restartingRef.current || pollInFlightRef.current) return;
    pollInFlightRef.current = true;
    const generation = generationRef.current;
    const controller = new AbortController();
    pollControllerRef.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await fetch(`${apiBase}/healthz`, { cache: "no-store", signal: controller.signal });
      if (!isMountedRef.current || generation !== generationRef.current) return;
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
      if (isMountedRef.current && generation === generationRef.current) {
        setStatus("error");
        setBots({});
      }
    } finally {
      clearTimeout(timeoutId);
      if (pollControllerRef.current === controller) pollControllerRef.current = null;
      pollInFlightRef.current = false;
    }
  }, [apiBase]);

  // Idempotent: always clears any existing interval before starting a new one.
  const startPolling = useCallback(() => {
    if (!isMountedRef.current || !isFocusedRef.current || !adminToken) return;
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    generationRef.current++;
    pollControllerRef.current?.abort();
    pollControllerRef.current = null;
    pollInFlightRef.current = false;
    poll();
    intervalRef.current = setInterval(poll, intervalMs);
  }, [adminToken, intervalMs, poll]);

  const stopPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const cancelAllWork = useCallback(() => {
    generationRef.current++;
    stopPolling();
    pollControllerRef.current?.abort();
    pollControllerRef.current = null;
    pollInFlightRef.current = false;
    for (const controller of probeControllersRef.current) controller.abort();
    probeControllersRef.current.clear();
    restartControllerRef.current?.abort();
    restartControllerRef.current = null;
    recoveryControllerRef.current?.abort();
    recoveryControllerRef.current = null;
    for (const id of restartTimerIdsRef.current) clearTimeout(id);
    restartTimerIdsRef.current = [];
    restartingRef.current = false;
    if (isMountedRef.current) setRestarting(false);
  }, [stopPolling]);

  // Only poll when the admin is authenticated and the tab is focused.
  useFocusEffect(
    useCallback(() => {
      if (!adminToken) return;
      isFocusedRef.current = true;
      setStatus("unknown");
      startPolling();
      return () => {
        isFocusedRef.current = false;
        cancelAllWork();
      };
    }, [adminToken, cancelAllWork, startPolling]),
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
        if (nextState !== "active") {
          // A backgrounded screen must not keep requests or recovery timers alive.
          cancelAllWork();
        }
      },
    );
    return () => {
      subscription.remove();
    };
  }, [adminToken, cancelAllWork, startPolling]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      cancelAllWork();
    };
  }, [cancelAllWork]);

  // Invalidate requests created with an old API base or credential. This is
  // deliberately separate from the focus cleanup because either value can
  // change while the screen remains mounted and focused.
  useEffect(() => {
    return () => {
      cancelAllWork();
    };
  }, [apiBase, adminToken, cancelAllWork]);

  const probeSingleBot = useCallback(async (botName: string): Promise<void> => {
    if (!adminToken) return;
    if (!isMountedRef.current) return;
    const generation = generationRef.current;
    const controller = new AbortController();
    probeControllersRef.current.add(controller);
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
      if (!isMountedRef.current || generation !== generationRef.current) return;
      if (!res.ok) return;
      const raw = await res.json();
      const parsed = HealthCheckResponse.safeParse(raw);
      if (parsed.success && parsed.data.bots) {
        setBots(parsed.data.bots);
      }
    } catch {
      // Aborts caused by blur/unmount/token changes are intentionally ignored.
    } finally {
      clearTimeout(timeoutId);
      probeControllersRef.current.delete(controller);
    }
  }, [apiBase, adminToken]);

  const triggerRestart = useCallback(async () => {
    if (!isMountedRef.current || !adminToken || restartingRef.current) return;
    restartingRef.current = true;
    setRestarting(true);
    setStatus("unknown");
    stopPolling();
    generationRef.current++;
    pollControllerRef.current?.abort();
    pollControllerRef.current = null;
    recoveryControllerRef.current?.abort();
    recoveryControllerRef.current = null;
    for (const id of restartTimerIdsRef.current) clearTimeout(id);
    restartTimerIdsRef.current = [];
    const generation = generationRef.current;
    const restartController = new AbortController();
    restartControllerRef.current = restartController;
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
      if (restartControllerRef.current === restartController) restartControllerRef.current = null;
    }
    if (!isMountedRef.current || generation !== generationRef.current || !adminToken) return;
    // Poll until the server comes back (up to ~30 s)
    const maxAttempts = 20;
    let attempts = 0;
    const resumePoll = async () => {
      attempts++;
      const controller = new AbortController();
      recoveryControllerRef.current = controller;
      const timeoutId = setTimeout(() => controller.abort(), resumePollTimeoutMs);
      try {
        const res = await fetch(`${apiBase}/healthz`, { cache: "no-store", signal: controller.signal });
        if (!isMountedRef.current || generation !== generationRef.current) return;
        if (res.ok) {
          const data = await res.json();
          const s = data?.status;
          restartingRef.current = false;
          restartTimerIdsRef.current = [];
          if (isMountedRef.current && generation === generationRef.current) {
            setStatus(s === "ok" || s === "degraded" || s === "error" ? s : "ok");
            setRestarting(false);
            startPolling();
          }
          return;
        }
      } catch {
        // Server still restarting (or timed out)
      } finally {
        clearTimeout(timeoutId);
        if (recoveryControllerRef.current === controller) recoveryControllerRef.current = null;
      }
      if (!isMountedRef.current || generation !== generationRef.current) return;
      if (attempts < maxAttempts) {
        const tid = setTimeout(resumePoll, 1500);
        restartTimerIdsRef.current.push(tid);
      } else {
        restartingRef.current = false;
        restartTimerIdsRef.current = [];
        if (isMountedRef.current && generation === generationRef.current) {
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
    if (!isMountedRef.current) return;
    setStatus("error");
    setBots({});
  }, []);

  return { status, restarting, triggerRestart, checkStatus: poll, bots, probeSingleBot, reportNetworkFailure };
}
