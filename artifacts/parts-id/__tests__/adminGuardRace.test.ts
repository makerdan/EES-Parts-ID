/**
 * @jest-environment node
 *
 * Regression tests for the admin guard race condition in admin-only screens.
 *
 * The bug: the guard ran on mount and saw the user as non-admin because
 * AppContext resolves admin status asynchronously (Clerk + GET /admin/me).
 * It would immediately call router.replace("/(tabs)") before that settled.
 *
 * The fix: only redirect when isLoading is false AND the user is not an admin.
 * These tests lock that contract against the pure helper `shouldRedirectNonAdmin`.
 */
import { shouldRedirectNonAdmin } from "../utils/adminGuard";

describe("adminGuard – shouldRedirectNonAdmin", () => {
  it("(a) does NOT redirect while isLoading is true, even when not an admin", () => {
    expect(shouldRedirectNonAdmin(true, false)).toBe(false);
  });

  it("(b) DOES redirect when isLoading becomes false and the user is not an admin", () => {
    expect(shouldRedirectNonAdmin(false, false)).toBe(true);
  });

  it("(c) does NOT redirect when isLoading is false and the user is an admin", () => {
    expect(shouldRedirectNonAdmin(false, true)).toBe(false);
  });

  it("(d) does NOT redirect when both isLoading is true and the user is an admin", () => {
    expect(shouldRedirectNonAdmin(true, true)).toBe(false);
  });
});
