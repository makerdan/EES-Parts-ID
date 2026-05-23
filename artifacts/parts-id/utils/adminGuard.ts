/**
 * Pure helper for the admin guard used in edit-item.tsx.
 *
 * Returns true when the guard should fire a redirect:
 *   - loading is finished (isLoading === false), AND
 *   - no admin token is present.
 *
 * While the app is still reading from SecureStore (isLoading === true) the
 * guard must stay silent so it does not race against async storage init.
 */
export function shouldRedirectNonAdmin(isLoading: boolean, adminToken: string | null): boolean {
  return !isLoading && adminToken === null;
}
