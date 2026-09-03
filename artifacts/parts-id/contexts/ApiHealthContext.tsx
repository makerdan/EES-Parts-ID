/**
 * ApiHealthContext
 *
 * Shares a single useApiStatus instance across the whole app so that any
 * screen — including admin screens that make their own raw fetch() calls —
 * can immediately signal a network failure to the banner without waiting for
 * the next periodic health-check poll.
 *
 * Usage:
 *   const { reportNetworkFailure } = useApiHealth();
 *
 * Call reportNetworkFailure() inside a catch block when you detect that
 * fetch() itself threw (i.e. err instanceof TypeError), NOT for 4xx/5xx
 * HTTP errors where the server is reachable and returned a response.
 */
import React, { createContext, useContext, useMemo } from "react";

import { useApp } from "@/contexts/AppContext";
import { type ApiStatusResult, useApiStatus } from "@/hooks/useApiStatus";
import { API_BASE } from "@/utils/apiBase";

const ApiHealthContext = createContext<ApiStatusResult | null>(null);

export function ApiHealthProvider({ children }: { children: React.ReactNode }) {
  const { isAdmin, adminToken } = useApp();
  const result = useApiStatus({
    apiBase: API_BASE,
    adminToken: isAdmin ? adminToken : null,
  });
  const {
    status,
    restarting,
    restartState,
    triggerRestart,
    checkStatus,
    bots,
    probeSingleBot,
    reportNetworkFailure,
  } = result;
  const contextValue = useMemo(() => ({
    status,
    restarting,
    restartState,
    triggerRestart,
    checkStatus,
    bots,
    probeSingleBot,
    reportNetworkFailure,
  }), [
    status,
    restarting,
    restartState,
    triggerRestart,
    checkStatus,
    bots,
    probeSingleBot,
    reportNetworkFailure,
  ]);
  return (
    <ApiHealthContext.Provider value={contextValue}>
      {children}
    </ApiHealthContext.Provider>
  );
}

export function useApiHealth(): ApiStatusResult {
  const ctx = useContext(ApiHealthContext);
  if (!ctx) throw new Error("useApiHealth must be used inside ApiHealthProvider");
  return ctx;
}
