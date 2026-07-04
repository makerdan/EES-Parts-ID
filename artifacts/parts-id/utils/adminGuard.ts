/**
 * Pure helper for the admin guard used in admin-only screens.
 *
 * Returns true when the guard should fire a redirect:
 *   - loading is finished (isLoading === false), AND
 *   - the user is not an admin.
 *
 * While auth state is still resolving (isLoading === true) the guard must stay
 * silent so it does not race against the Clerk + role check.
 */
export function shouldRedirectNonAdmin(isLoading: boolean, isAdmin: boolean): boolean {
  return !isLoading && !isAdmin;
}
