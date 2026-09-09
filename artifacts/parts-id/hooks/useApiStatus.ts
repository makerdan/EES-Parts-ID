import { HealthCheckResponse } from "@workspace/api-zod";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, AppStateStatus } from "react-native";

export type ApiStatus = "ok" | "degraded" | "error" | "unknown";
export type BotProbeStatus = "ok" | "timeout" | "404" | "error";
export type ReadinessIssue =
  | {
      detail: "startup_not_ready";
      startupStatus: "pending" | "timed_out" | "failed";
    }
  | {
      detail: "database_unreachable" | "schema_unavailable";
    };
export type RestartState =
  | "idle"
  | "requesting"
  | "authorization"
  | "rejected"
  | "timeout"
  | "server_failure"
  | "recovering"
  | "recovered"
  | "recovery_failed"
  | "cancelled";

export interface ApiStatusResult {
  status: ApiStatus;
  readinessIssue: ReadinessIssue | null;
  checking: boolean;
  lastCheckedAt: number | null;
  restarting: boolean;
  restartState: RestartState;
  triggerRestart: () => Promise<RestartState>;
  dismissRestartNotice: () => void;
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

function parseReadinessIssue(raw: unknown): ReadinessIssue | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as Record<string, unknown>;
  if (payload.status !== "error") return null;

  if (payload.detail === "database_unreachable" || payload.detail === "schema_unavailable") {
    return { detail: payload.detail };
  }

  if (payload.detail !== "startup_not_ready") return null;
  if (
    payload.startup_status !== "pending" &&
    payload.startup_status !== "timed_out" &&
    payload.startup_status !== "failed"
  ) {
    return null;
  }
  return {
    detail: "startup_not_ready",
    startupStatus: payload.startup_status,
  };
}

export function useApiStatus({
  apiBase,
  adminToken,
  intervalMs = 15_000,
  restartPostTimeoutMs = 10_000,
  resumePollTimeoutMs = 5_000,
}: UseApiStatusOptions): ApiStatusResult {
  const [status, setStatus] = useState<ApiStatus>("unknown");
  const [readinessIssue, setReadinessIssue] = useState<ReadinessIssue | null>(null);
  const [checking, setChecking] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [restartState, setRestartState] = useState<RestartState>("idle");
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
  const recoveryResolveRef = useRef<((state: RestartState) => void) | null>(null);

  const poll = useCallback(async () => {
    if (!isMountedRef.current || restartingRef.current || pollInFlightRef.current) return;
    pollInFlightRef.current = true;
    const generation = generationRef.current;
    const controller = new AbortController();
    pollControllerRef.current = controller;
    setChecking(true);
    const timeoutId = setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await fetch(`${apiBase}/healthz`, { cache: "no-store", signal: controller.signal });
      if (!isMountedRef.current || generation !== generationRef.current) return;
      if (!res.ok) {
        let issue: ReadinessIssue | null = null;
        try {
          issue = parseReadinessIssue(await res.json());
        } catch {
          // Keep non-readiness failures generic.
        }
        setStatus("error");
        setReadinessIssue(issue);
        setBots({});
        return;
      }
      const raw = await res.json();
      const parsed = HealthCheckResponse.safeParse(raw);
      if (!parsed.success) {
        console.warn("[useApiStatus] Unexpected healthz shape:", parsed.error.message);
        setStatus("error");
        setReadinessIssue(null);
        setBots({});
        return;
      }
      setStatus(parsed.data.status);
      setReadinessIssue(null);
      setBots(parsed.data.bots ?? {});
      setRestartState("idle");
    } catch {
      if (isMountedRef.current && generation === generationRef.current) {
        setStatus("error");
        setReadinessIssue(null);
        setBots({});
      }
    } finally {
      clearTimeout(timeoutId);
      if (pollControllerRef.current === controller) pollControllerRef.current = null;
      pollInFlightRef.current = false;
      if (isMountedRef.current && generation === generationRef.current) {
        setChecking(false);
        setLastCheckedAt(Date.now());
      }
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
    const wasRestarting = restartingRef.current;
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
    const resolveRecovery = recoveryResolveRef.current;
    recoveryResolveRef.current = null;
    resolveRecovery?.("cancelled");
    for (const id of restartTimerIdsRef.current) clearTimeout(id);
    restartTimerIdsRef.current = [];
    restartingRef.current = false;
    if (isMountedRef.current) {
      setRestarting(false);
      if (wasRestarting) setRestartState("cancelled");
    }
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
          if (!restartingRef.current) {
            setStatus("unknown");
            startPolling();
          }
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
      if (!res.ok) {
        setBots((current) => ({ ...current, [botName]: "error" }));
        return;
      }
      const raw = await res.json();
      // The admin single-bot endpoint returns the refreshed bot summary
      // (`{ bots }`), not the full `/healthz` payload (`{ status, bots }`).
      // Validate the shared bot shape without requiring an unrelated status.
      const parsed = HealthCheckResponse.pick({ bots: true }).safeParse(raw);
      if (parsed.success && parsed.data.bots) {
        setBots(parsed.data.bots);
      }
    } catch {
      // Aborts caused by blur/unmount/token changes are intentionally ignored.
      if (isMountedRef.current && generation === generationRef.current && !controller.signal.aborted) {
        setBots((current) => ({ ...current, [botName]: "error" }));
      }
    } finally {
      clearTimeout(timeoutId);
      probeControllersRef.current.delete(controller);
    }
  }, [apiBase, adminToken]);

  const triggerRestart = useCallback(async (): Promise<RestartState> => {
    if (!isMountedRef.current) return "cancelled";
    if (!adminToken) {
      setRestartState("authorization");
      return "authorization";
    }
    if (restartingRef.current) return "rejected";

    restartingRef.current = true;
    setRestarting(true);
    setStatus("unknown");
    setRestartState("requesting");
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
    let restartStateAfterRequest: RestartState = "server_failure";
    try {
      const res = await fetch(`${apiBase}/admin/restart`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` },
        signal: restartController.signal,
      });
      if (res.status === 401 || res.status === 403) {
        restartStateAfterRequest = "authorization";
      } else if (!res.ok) {
        restartStateAfterRequest = res.status >= 500 ? "server_failure" : "rejected";
      } else {
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        const accepted = res.status === 202
          && typeof body === "object"
          && body !== null
          && (body as { restarting?: unknown }).restarting === true;
        restartStateAfterRequest = accepted ? "recovering" : "server_failure";
      }
    } catch {
      // A timed-out request is different from a network/server failure. Neither
      // response permits recovery polling because the server did not accept it.
      restartStateAfterRequest = restartController.signal.aborted ? "timeout" : "server_failure";
    } finally {
      clearTimeout(restartTimeoutId);
      if (restartControllerRef.current === restartController) restartControllerRef.current = null;
    }

    if (!isMountedRef.current || generation !== generationRef.current || !adminToken) {
      return "cancelled";
    }

    if (restartStateAfterRequest !== "recovering") {
      restartingRef.current = false;
      setRestarting(false);
      setRestartState(restartStateAfterRequest);
      return restartStateAfterRequest;
    }

    setRestartState("recovering");

    // Poll until the server comes back (up to ~30 s)
    const maxAttempts = 20;
    let attempts = 0;
    return new Promise<RestartState>((resolve) => {
      recoveryResolveRef.current = resolve;
      const finishRecovery = (state: RestartState): void => {
        if (recoveryResolveRef.current !== resolve) return;
        recoveryResolveRef.current = null;
        resolve(state);
      };

      const resumePoll = async () => {
        attempts++;
        const controller = new AbortController();
        recoveryControllerRef.current = controller;
        const timeoutId = setTimeout(() => controller.abort(), resumePollTimeoutMs);
        try {
          const res = await fetch(`${apiBase}/healthz`, { cache: "no-store", signal: controller.signal });
          if (!isMountedRef.current || generation !== generationRef.current) {
            finishRecovery("cancelled");
            return;
          }
          if (res.ok) {
            const parsed = HealthCheckResponse.safeParse(await res.json());
            if (parsed.success && (parsed.data.status === "ok" || parsed.data.status === "degraded")) {
              restartingRef.current = false;
              restartTimerIdsRef.current = [];
              if (isMountedRef.current && generation === generationRef.current) {
                setStatus(parsed.data.status);
                setReadinessIssue(null);
                setBots(parsed.data.bots ?? {});
                setRestartState("recovered");
                setRestarting(false);
                finishRecovery("recovered");
                startPolling();
              }
              return;
            }
          }
        } catch {
          // Server still restarting (or timed out)
        } finally {
          clearTimeout(timeoutId);
          if (recoveryControllerRef.current === controller) recoveryControllerRef.current = null;
          if (isMountedRef.current && generation === generationRef.current) {
            setLastCheckedAt(Date.now());
          }
        }
        if (!isMountedRef.current || generation !== generationRef.current) {
          finishRecovery("cancelled");
          return;
        }
        if (attempts < maxAttempts) {
          const tid = setTimeout(resumePoll, 1500);
          restartTimerIdsRef.current.push(tid);
        } else {
          restartingRef.current = false;
          restartTimerIdsRef.current = [];
          if (isMountedRef.current && generation === generationRef.current) {
            setStatus("error");
            setReadinessIssue(null);
            setRestartState("recovery_failed");
            setRestarting(false);
            finishRecovery("recovery_failed");
            startPolling();
          }
        }
      };
      const tid = setTimeout(resumePoll, 1500);
      restartTimerIdsRef.current.push(tid);
    });
  }, [adminToken, apiBase, restartPostTimeoutMs, resumePollTimeoutMs, startPolling, stopPolling]);

  const reportNetworkFailure = useCallback(() => {
    if (!isMountedRef.current) return;
    setStatus("error");
    setReadinessIssue(null);
    setBots({});
  }, []);

  const dismissRestartNotice = useCallback(() => {
    if (!isMountedRef.current) return;
    setRestartState("idle");
  }, []);

  return {
    status,
    readinessIssue,
    checking,
    lastCheckedAt,
    restarting,
    restartState,
    triggerRestart,
    dismissRestartNotice,
    checkStatus: poll,
    bots,
    probeSingleBot,
    reportNetworkFailure,
  };
}
