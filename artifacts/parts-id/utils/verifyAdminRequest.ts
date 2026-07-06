/**
 * Extracted async logic for verifying admin status via GET /admin/me.
 *
 * Separated from AppContext so it can be unit-tested without mounting the
 * full provider.
 *
 * Behaviour contract
 * ──────────────────
 * • ok response  { isAdmin: true }  → setIsAdmin(true),  setAdminToken(token)
 * • ok response  { isAdmin: false } → if wasAdmin, onDemotion(); setIsAdmin(false), setAdminToken(null)
 * • 403 { code: "MFA_REQUIRED" }   → onMfaRequired?.(); setIsAdmin(false), setAdminToken(null)
 * • 401 HTTP response               → if wasAdmin, onDemotion(); setIsAdmin(false), setAdminToken(null)
 * • 5xx HTTP response               → admin state LEFT UNCHANGED (transient server error)
 * • other non-ok HTTP (4xx etc.)   → admin state LEFT UNCHANGED (non-authoritative)
 * • network error (fetch throws)    → admin state LEFT UNCHANGED
 *   Rationale: a transient network blip, rolling deploy restart, rate-limit,
 *   or unexpected 4xx from a proxy should not revoke an admin's session.
 *   Only an explicit server rejection (200 isAdmin:false, 401, 403) does.
 * • signal aborted                  → returns early, no state change
 */

import { shouldNotifyDemotion } from "@/utils/adminDemotionToast";

export type VerifyAdminRequestDeps = {
  apiBase: string;
  token: string;
  signal?: AbortSignal;
  /** Whether the user held admin status before this check. Used for demotion detection. */
  wasAdmin?: boolean;
  setIsAdmin: (v: boolean) => void;
  setAdminToken: (v: string | null) => void;
  /** Called when a demotion transition is detected (wasAdmin=true → isAdmin=false). */
  onDemotion?: () => void;
  /**
   * Called when the server rejects the admin request because the session lacks
   * a completed MFA factor (403 { code: "MFA_REQUIRED" }).
   * The caller (AppContext) should prompt the user to enable two-factor
   * authentication via their Clerk account settings.
   */
  onMfaRequired?: () => void;
};

export async function verifyAdminRequest({
  apiBase,
  token,
  signal,
  wasAdmin = false,
  setIsAdmin,
  setAdminToken,
  onDemotion,
  onMfaRequired,
}: VerifyAdminRequestDeps): Promise<void> {
  try {
    const resp = await fetch(`${apiBase}/admin/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (signal?.aborted) return;
    if (resp.ok) {
      const body = (await resp.json()) as { isAdmin?: boolean };
      const admin = !!body.isAdmin;
      if (shouldNotifyDemotion(wasAdmin, admin)) {
        onDemotion?.();
      }
      setIsAdmin(admin);
      setAdminToken(admin ? token : null);
    } else if (resp.status === 403) {
      let code: string | undefined;
      try {
        const body = (await resp.json()) as { code?: string };
        code = body.code;
      } catch {
        // ignore parse errors — treat as a generic 403
      }

      if (code === "MFA_REQUIRED") {
        onMfaRequired?.();
        setIsAdmin(false);
        setAdminToken(null);
        return;
      }

      if (shouldNotifyDemotion(wasAdmin, false)) {
        onDemotion?.();
      }
      setIsAdmin(false);
      setAdminToken(null);
    } else if (resp.status === 401) {
      if (shouldNotifyDemotion(wasAdmin, false)) {
        onDemotion?.();
      }
      setIsAdmin(false);
      setAdminToken(null);
    } else {
      // All other non-ok statuses (5xx server errors, 429 rate-limit, 400,
      // 404, proxy errors, etc.) are treated as non-authoritative transient
      // conditions — leave admin state unchanged.
    }
  } catch {
    // Transient network errors (blips, rolling deploys) — leave admin state
    // unchanged.  Only an explicit non-ok HTTP response clears admin status.
  }
}
