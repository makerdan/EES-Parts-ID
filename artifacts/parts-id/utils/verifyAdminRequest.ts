/**
 * Extracted async logic for verifying admin status via GET /admin/me.
 *
 * Separated from AppContext so it can be unit-tested without mounting the
 * full provider.
 *
 * Behaviour contract
 * ──────────────────
 * • ok response  { isAdmin: true }  → setIsAdmin(true),  setAdminToken(token)
 * • ok response  { isAdmin: false } → setIsAdmin(false), setAdminToken(null)
 * • non-ok HTTP response            → setIsAdmin(false), setAdminToken(null)
 * • network error (fetch throws)    → admin state LEFT UNCHANGED
 *   Rationale: a transient network blip or rolling deploy restart should not
 *   revoke an admin's session.  Only an explicit server rejection does.
 * • signal aborted                  → returns early, no state change
 */

export type VerifyAdminRequestDeps = {
  apiBase: string;
  token: string;
  signal?: AbortSignal;
  setIsAdmin: (v: boolean) => void;
  setAdminToken: (v: string | null) => void;
};

export async function verifyAdminRequest({
  apiBase,
  token,
  signal,
  setIsAdmin,
  setAdminToken,
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
      setIsAdmin(admin);
      setAdminToken(admin ? token : null);
    } else {
      setIsAdmin(false);
      setAdminToken(null);
    }
  } catch {
    // Transient network errors (blips, rolling deploys) — leave admin state
    // unchanged.  Only an explicit non-ok HTTP response clears admin status.
  }
}
