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
 * An authenticated, approved administrator is admitted regardless of which
 * second-factor claims (if any) are present on the Clerk session. MFA is a
 * Clerk account-level setting outside this application's authorization
 * boundary; this middleware only checks Clerk session validity, approval
 * status, and admin role.
 *
 * 401 — no Clerk session
 * 403 — authenticated but not an admin
 */

/**
 * Re-check admin access for routes that may include privileged content but
 * must remain usable by ordinary approved users. This deliberately does not
 * trust res.locals.appUser: role and status are read again from the database.
 */
export async function hasCurrentAdminAccess(req: Request): Promise<boolean> {
  const userId = getAuth(req)?.userId;
  if (!userId) return false;

  if (process.env.ADMIN_CLERK_USER_ID === userId) return true;

  const rows = await db
    .select({ role: usersTable.role, status: usersTable.status })
    .from(usersTable)
    .where(eq(usersTable.clerkUserId, userId))
    .limit(1);

  return rows[0]?.role === "admin" && rows[0]?.status === "approved";
}

/**
 * Returns the Clerk identity that passed the app and admin guards.
 *
 * Routes use this instead of independently choosing between appUser and the
 * Clerk session, so resource ownership always follows the approved app user.
 */
export function getAdminClerkUserId(req: Request, res: Response): string {
  const appUser = res.locals.appUser as { clerkUserId?: string } | undefined;
  return appUser?.clerkUserId ?? getAuth(req)?.userId ?? "unknown";
}

type AppUser = {
  clerkUserId: string;
  status?: string;
  role?: string;
};

function logBootstrapAdminRequest(req: Request, res: Response, clerkUserId: string): void {
  // Emit an audit-level warning for every request made under the bootstrap
  // admin identity so these privileged actions are visible in deployment logs.
  if (res.locals.isBootstrapAdmin) {
    logger.warn({
      bootstrapAdmin: true,
      path: req.path,
      method: req.method,
      clerkUserId,
      requestId: res.locals.requestId as string | undefined,
    }, "Bootstrap admin request");
  }
}

function requireApprovedAdmin(req: Request, res: Response, next: NextFunction): void {
  const appUser = res.locals.appUser as
    | AppUser
    | undefined;

  if (appUser) {
    if (appUser.status === "approved" && appUser.role === "admin") {
      logBootstrapAdminRequest(req, res, appUser.clerkUserId);
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
    logBootstrapAdminRequest(req, res, userId);
    next();
    return;
  }

  (async () => {
    try {
      const rows = await db
        .select({ role: usersTable.role, status: usersTable.status })
        .from(usersTable)
        .where(eq(usersTable.clerkUserId, userId))
        .limit(1);

      if (rows[0]?.role === "admin" && rows[0]?.status === "approved") {
        next();
      } else {
        res.status(403).json({ error: "Admin access required" });
      }
    } catch {
      res.status(500).json({ error: "Admin authorization check failed. Please try again." });
    }
  })();
}

/**
 * Admin guard shared by every privileged route. Retained under two names
 * (`requireApprovedAdminAuth` and `requireAdminAuth`) so route declarations
 * keep signalling their intended audience even though both now enforce the
 * same authenticated-approved-admin contract.
 */
export function requireApprovedAdminAuth(req: Request, res: Response, next: NextFunction): void {
  requireApprovedAdmin(req, res, next);
}

/** Admin guard for sensitive operations. */
export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  requireApprovedAdmin(req, res, next);
}
