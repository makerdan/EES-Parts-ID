import { getAuth } from "@clerk/express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { type NextFunction,type Request, type Response } from "express";

import { logger } from "../lib/logger";

/**
 * Role-based admin guard for admin-only API endpoints.
 *
 * This middleware runs AFTER `requireAppAuth` (mounted on all /api routes),
 * which validates the Clerk session, enforces approval status, and populates
 * `res.locals.appUser` with the resolved user row (including `role`). The
 * common case therefore only reads that pre-resolved value.
 *
 * The designated bootstrap admin (`ADMIN_CLERK_USER_ID`) is always treated as
 * an admin, matching the guarantee enforced in `requireAppAuth`.
 *
 * MFA enforcement:
 *   When the environment variable ENFORCE_ADMIN_MFA=true is set, admin users
 *   must have completed a second authentication factor (TOTP, phone code, or
 *   hardware key) as evidenced by the `amr` claim in their Clerk session token.
 *   Sessions that only contain password authentication (`pwd`) receive:
 *     403 { error: "MFA required for admin access", code: "MFA_REQUIRED" }
 *   To enable: set ENFORCE_ADMIN_MFA=true in the API server's environment.
 *   Admins enroll via the Clerk account portal (Settings → Security → Two-step
 *   verification), or in-app via the Clerk user profile component.
 *
 * 401 — no Clerk session
 * 403 — authenticated but not an admin
 * 403 { code: "MFA_REQUIRED" } — admin session lacks a completed MFA factor
 */

/** Second-factor method values that satisfy the MFA requirement. */
const MFA_FACTORS = new Set(["totp", "phone_code", "phishing_resistant_hw_key"]);

/**
 * Returns true when the Clerk session attached to the request contains at least
 * one recognised second-factor entry in the `amr` claim.
 */
function sessionHasMfa(req: Request): boolean {
  const clerkAuth = getAuth(req);
  const claims = clerkAuth?.sessionClaims as Record<string, unknown> | null | undefined;
  const amr = claims?.["amr"];
  if (!Array.isArray(amr)) return false;
  return (amr as Array<unknown>).some((factor) => typeof factor === "string" && MFA_FACTORS.has(factor));
}

/**
 * When ENFORCE_ADMIN_MFA=true, returns 403 { code: "MFA_REQUIRED" } if the
 * session does not include a second factor. Returns false when the check is
 * disabled or when MFA is satisfied (caller should call next()).
 */
function rejectIfMfaMissing(req: Request, res: Response): boolean {
  if (process.env.ENFORCE_ADMIN_MFA !== "true") return false;
  if (sessionHasMfa(req)) return false;
  res.status(403).json({
    error: "MFA required for admin access",
    code: "MFA_REQUIRED",
  });
  return true;
}

export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const appUser = res.locals.appUser as
    | { clerkUserId: string; role?: string }
    | undefined;

  if (appUser) {
    if (appUser.role === "admin") {
      // Emit an audit-level warning for every request made under the bootstrap
      // admin identity so these privileged actions are visible in deployment logs.
      if (res.locals.isBootstrapAdmin) {
        logger.warn({
          bootstrapAdmin: true,
          path: req.path,
          method: req.method,
          clerkUserId: appUser.clerkUserId,
          requestId: res.locals.requestId as string | undefined,
        }, "Bootstrap admin request");
      }

      if (rejectIfMfaMissing(req, res)) return;
      next();
    } else {
      res.status(403).json({ error: "Admin access required" });
    }
    return;
  }

  // Defensive fallback: resolve directly from the Clerk session and DB in case
  // this guard is ever reached without requireAppAuth having populated locals.
  const clerkAuth = getAuth(req);
  const userId = clerkAuth?.userId;

  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const adminClerkUserId = process.env.ADMIN_CLERK_USER_ID;
  if (adminClerkUserId && userId === adminClerkUserId) {
    if (rejectIfMfaMissing(req, res)) return;
    next();
    return;
  }

  (async () => {
    try {
      const rows = await db
        .select({ role: usersTable.role })
        .from(usersTable)
        .where(eq(usersTable.clerkUserId, userId))
        .limit(1);

      if (rows[0]?.role === "admin") {
        if (rejectIfMfaMissing(req, res)) return;
        next();
      } else {
        res.status(403).json({ error: "Admin access required" });
      }
    } catch {
      res.status(500).json({ error: "Admin authorization check failed. Please try again." });
    }
  })();
}
