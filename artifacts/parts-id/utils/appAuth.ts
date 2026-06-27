/**
 * Module-level app-session and admin token store.
 *
 * Allows hooks and standalone fetch calls to include the correct
 * Authorization header without threading the token through every component.
 * AppContext calls setAppToken / setAdminToken whenever either token changes.
 */

let _appToken: string | null = null;
let _adminToken: string | null = null;

export function setAppToken(token: string | null): void {
  _appToken = token;
}

export function setAdminToken(token: string | null): void {
  _adminToken = token;
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
