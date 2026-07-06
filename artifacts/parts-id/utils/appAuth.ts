/**
 * Module-level app-session token store.
 *
 * Allows hooks and standalone fetch calls to include the correct
 * Authorization header without threading the token through every component.
 * AppContext registers a Clerk token getter (setAppTokenGetter) so fetchWithAuth
 * always resolves a fresh session token.
 *
 * fetchWithAuth wraps the global fetch so every non-generated-client call site
 * gets automatic 401 → logout handling without duplicating that logic.
 *
 * Token-available subscriptions:
 *   subscribeToTokenAvailable / unsubscribeFromTokenAvailable let hooks
 *   (e.g. useWarehouseZones) retry a failed fetch once auth settles on cold
 *   start. Subscribers are notified only when a token transitions from absent
 *   to present, so they don't fire on every routine token refresh.
 */

import { TimeoutError } from "@workspace/api-client-react";

export { DEFAULT_FETCH_TIMEOUT_MS } from "@workspace/api-client-react";

/**
 * Combines multiple AbortSignals into one that fires when any of them fires.
 * Falls back to a manual listener-based race when `AbortSignal.any` is not
 * available (e.g. older React Native runtimes).
 */
function combineSignals(
  signals: Array<AbortSignal | null | undefined>,
): AbortSignal | undefined {
  const valid = signals.filter((s): s is AbortSignal => s != null);
  if (valid.length === 0) return undefined;
  if (valid.length === 1) return valid[0];

  if (typeof AbortSignal !== "undefined" && typeof (AbortSignal as { any?: unknown }).any === "function") {
    return (AbortSignal as { any: (signals: Array<AbortSignal>) => AbortSignal }).any(valid);
  }

  const controller = new AbortController();
  for (const signal of valid) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

let _appToken: string | null = null;
let _onUnauthorized: (() => void) | null = null;

/**
 * Optional async getter for the Clerk session token.
 * When set, fetchWithAuth calls it to obtain a fresh token on every request
 * instead of reading the stale _appToken string.
 */
let _appTokenGetter: (() => Promise<string | null>) | null = null;
let _hasLoggedTokenGetterError = false;

const _tokenAvailableListeners = new Set<() => void>();

/** Subscribe to the moment a token first becomes available (null → non-null). */
export function subscribeToTokenAvailable(fn: () => void): void {
  _tokenAvailableListeners.add(fn);
}

/** Remove a previously-registered token-available listener. */
export function unsubscribeFromTokenAvailable(fn: () => void): void {
  _tokenAvailableListeners.delete(fn);
}

function _notifyTokenAvailable(): void {
  for (const fn of _tokenAvailableListeners) {
    try { fn(); } catch { /* listeners must not crash the setter */ }
  }
}

export function setAppToken(token: string | null): void {
  const wasAbsent = _appToken === null;
  _appToken = token;
  if (wasAbsent && token !== null) _notifyTokenAvailable();
}

/**
 * Register an async getter that resolves the current Clerk session token.
 * Called by AppContext on mount; cleared on unmount.
 * When set, fetchWithAuth uses this instead of _appToken so tokens are
 * always fresh (Clerk auto-refreshes expiring tokens inside getToken()).
 */
export function setAppTokenGetter(fn: (() => Promise<string | null>) | null): void {
  _appTokenGetter = fn;
}

/**
 * Trigger all token-available subscribers from outside this module.
 * AppContext calls this when approvalStatus transitions to "approved" so
 * hooks like useWarehouseZones can retry their initial fetch.
 */
export function notifyTokenAvailable(): void {
  _notifyTokenAvailable();
}

/**
 * Register a callback that fires whenever fetchWithAuth receives a 401.
 * AppContext sets this on mount and clears it on unmount.
 */
export function setOnUnauthorized(fn: (() => void) | null): void {
  _onUnauthorized = fn;
}

/** Returns the synchronous app token fallback (async getter is preferred). */
export function getAuthToken(): string | null {
  return _appToken;
}

/**
 * Returns an Authorization header record when a token is available, or an
 * empty object when neither token is set (e.g. before login completes).
 */
export function getAuthHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Authenticated fetch wrapper. Prepends the current Authorization header and
 * invokes the registered onUnauthorized handler on 401, allowing AppContext to
 * clear tokens and reset auth state centrally instead of per call site.
 *
 * Token resolution order:
 *  1. Async Clerk token getter (registered by AppContext on mount) — always fresh
 *  2. Sync _appToken fallback (legacy / test path)
 *
 * Pass `timeoutMs` to abort the request if no response arrives within that
 * duration. A `TimeoutError` is thrown in that case. If `init.signal` is also
 * provided, the timeout races against it — whichever fires first wins.
 */
export async function fetchWithAuth(
  url: string,
  init?: RequestInit,
  timeoutMs?: number,
): Promise<Response> {
  let token: string | null;
  if (_appTokenGetter) {
    try {
      token = await _appTokenGetter();
    } catch (err) {
      if (!_hasLoggedTokenGetterError) {
        console.warn("[fetchWithAuth] Clerk token getter threw — falling back to cached token:", err);
        _hasLoggedTokenGetterError = true;
      }
      token = _appToken;
    }
  } else {
    token = _appToken;
  }
  const authHeaders: Record<string, string> = token
    ? { Authorization: `Bearer ${token}` }
    : {};

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let effectiveSignal: AbortSignal | undefined = init?.signal as AbortSignal | undefined;

  if (timeoutMs != null) {
    const timeoutController = new AbortController();
    timeoutId = setTimeout(() => {
      timeoutController.abort(new TimeoutError(timeoutMs));
    }, timeoutMs);
    effectiveSignal = combineSignals([effectiveSignal, timeoutController.signal]);
  }

  const merged: RequestInit = {
    ...init,
    signal: effectiveSignal,
    headers: {
      ...authHeaders,
      ...(init?.headers as Record<string, string> | undefined),
    },
  };

  try {
    const res = await fetch(url, merged);
    if (res.status === 401 && _onUnauthorized) {
      _onUnauthorized();
    }
    return res;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
