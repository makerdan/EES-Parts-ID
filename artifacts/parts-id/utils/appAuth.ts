/**
 * Module-level app-session and admin token store.
 *
 * Allows hooks and standalone fetch calls to include the correct
 * Authorization header without threading the token through every component.
 * AppContext calls setAppToken / setAdminToken whenever either token changes.
 *
 * fetchWithAuth wraps the global fetch so every non-generated-client call site
 * gets automatic 401 → logout handling without duplicating that logic.
 */

let _appToken: string | null = null;
let _adminToken: string | null = null;
let _onUnauthorized: (() => void) | null = null;

export function setAppToken(token: string | null): void {
  _appToken = token;
}

export function setAdminToken(token: string | null): void {
  _adminToken = token;
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
 */
export async function fetchWithAuth(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const authHeaders = getAuthHeaders();
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
