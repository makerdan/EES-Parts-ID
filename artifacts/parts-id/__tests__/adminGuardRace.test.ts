/**
 * @jest-environment node
 *
 * Regression tests for the admin guard race condition in edit-item.tsx.
 *
 * The bug: the guard ran on mount and saw `adminToken === null` because
 * AppContext initialises it as null while SecureStore loads asynchronously.
 * It would immediately call router.replace("/(tabs)") before storage finished.
 *
 * The fix: only redirect when isLoading is false AND adminToken is null.
 * These tests lock that contract against the pure helper `shouldRedirectNonAdmin`.
 */
import { shouldRedirectNonAdmin } from "../utils/adminGuard";

describe("adminGuard – shouldRedirectNonAdmin", () => {
  it("(a) does NOT redirect while isLoading is true, even when adminToken is null", () => {
    expect(shouldRedirectNonAdmin(true, null)).toBe(false);
  });

  it("(b) DOES redirect when isLoading becomes false and adminToken is still null", () => {
    expect(shouldRedirectNonAdmin(false, null)).toBe(true);
  });

  it("(c) does NOT redirect when isLoading is false and adminToken is set", () => {
    expect(shouldRedirectNonAdmin(false, "some-admin-token")).toBe(false);
  });

  it("(d) does NOT redirect when both isLoading is true and a token is present", () => {
    expect(shouldRedirectNonAdmin(true, "some-admin-token")).toBe(false);
  });
});
