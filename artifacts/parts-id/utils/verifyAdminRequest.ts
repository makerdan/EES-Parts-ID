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
 * • non-ok HTTP response            → if wasAdmin, onDemotion(); setIsAdmin(false), setAdminToken(null)
 * • network error (fetch throws)    → admin state LEFT UNCHANGED
 *   Rationale: a transient network blip or rolling deploy restart should not
 *   revoke an admin's session.  Only an explicit server rejection does.
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
};

export async function verifyAdminRequest({
  apiBase,
  token,
  signal,
  wasAdmin = false,
  setIsAdmin,
  setAdminToken,
  onDemotion,
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
    } else {
      if (shouldNotifyDemotion(wasAdmin, false)) {
        onDemotion?.();
      }
      setIsAdmin(false);
      setAdminToken(null);
    }
  } catch {
    // Transient network errors (blips, rolling deploys) — leave admin state
    // unchanged.  Only an explicit non-ok HTTP response clears admin status.
  }
}
