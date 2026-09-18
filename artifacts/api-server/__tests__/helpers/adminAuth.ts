/**
 * Test helper for authenticating as an admin under the role-based auth model.
 *
 * The server no longer uses HMAC admin tokens; admin access is granted to Clerk
 * identities whose `users.role === "admin"`. The bootstrap admin
 * (`ADMIN_CLERK_USER_ID`) is always treated as admin+approved.
 *
 * This module sets `ADMIN_CLERK_USER_ID` to a fixed test id as an import
 * side-effect, and exposes drop-in replacements for the old `signAdminToken` /
 * `setRevokedBefore` exports so existing integration tests only need their
 * import source swapped:
 *
 *   - `signAdminToken()` returns the bootstrap-admin Clerk user id. Combined
 *     with the @clerk/express mock (which reads `Authorization: Bearer <token>`
 *     as the Clerk user id), a request carrying this token authenticates as the
 *     bootstrap admin.
 *   - `setRevokedBefore()` is a no-op (token revocation no longer exists).
 */

export const ADMIN_TEST_USER_ID = `jest-admin-user-${process.pid}-${process.env.JEST_WORKER_ID ?? "single"}`;

const originalAdminClerkUserId = process.env.ADMIN_CLERK_USER_ID;
process.env.ADMIN_CLERK_USER_ID = ADMIN_TEST_USER_ID;

// This helper is imported for its default bootstrap-admin identity by many
// suites. Restore the process-global value when the importing suite finishes
// so a later suite in the same worker cannot inherit this identity.
if (typeof afterAll === "function") {
  afterAll(() => {
    if (originalAdminClerkUserId === undefined) {
      delete process.env.ADMIN_CLERK_USER_ID;
    } else {
      process.env.ADMIN_CLERK_USER_ID = originalAdminClerkUserId;
    }
  });
}

/** Returns a Bearer value that authenticates as the bootstrap admin. */
export function signAdminToken(_ts?: number, _secret?: string): string {
  return ADMIN_TEST_USER_ID;
}

/** No-op shim: token revocation was removed with the HMAC auth model. */
export function setRevokedBefore(_ts?: number): void {
  // intentionally empty
}
