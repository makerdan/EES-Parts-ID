/**
 * Module-level app-session and admin token store.
 *
 * Allows hooks and standalone fetch calls to include the correct
 * Authorization header without threading the token through every component.
 * AppContext calls setAppToken / setAdminToken whenever either token changes.
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

let _appToken: string | null = null;
let _adminToken: string | null = null;
let _onUnauthorized: (() => void) | null = null;

/**
 * Optional async getter for the Clerk session token.
 * When set, fetchWithAuth calls it to obtain a fresh token on every request
 * instead of reading the stale _appToken string.
 */
let _appTokenGetter: (() => Promise<string | null>) | null = null;

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
  const wasAbsent = _appToken === null && _adminToken === null;
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

export function setAdminToken(token: string | null): void {
  const wasAbsent = _appToken === null && _adminToken === null;
  _adminToken = token;
  if (wasAbsent && token !== null) _notifyTokenAvailable();
}

/**
 * Register a callback that fires whenever fetchWithAuth receives a 401.
 * AppContext sets this on mount and clears it on unmount.
 */
export function setOnUnauthorized(fn: (() => void) | null): void {
  _onUnauthorized = fn;
}

/** Returns the best available auth token: admin takes precedence over app. */
export function getAuthToken(): string | null {
  return _adminToken ?? _appToken;
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
 *  1. Admin HMAC token (takes precedence — allows admin to act as any user)
 *  2. Async Clerk token getter (registered by AppContext on mount) — always fresh
 *  3. Sync _appToken fallback (legacy / test path)
 */
export async function fetchWithAuth(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  let token: string | null = _adminToken;
  if (!token) {
    if (_appTokenGetter) {
      token = await _appTokenGetter();
    } else {
      token = _appToken;
    }
  }
  const authHeaders: Record<string, string> = token
    ? { Authorization: `Bearer ${token}` }
    : {};
  const merged: RequestInit = {
    ...init,
    headers: {
      ...authHeaders,
      ...(init?.headers as Record<string, string> | undefined),
    },
  };
  const res = await fetch(url, merged);
  if (res.status === 401 && _onUnauthorized) {
    _onUnauthorized();
  }
  return res;
}
