import { getAuth } from "@clerk/express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { type NextFunction,type Request, type Response } from "express";

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
 * 401 — no Clerk session
 * 403 — authenticated but not an admin
 */
export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const appUser = res.locals.appUser as
    | { clerkUserId: string; role?: string }
    | undefined;

  if (appUser) {
    if (appUser.role === "admin") {
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
        next();
      } else {
        res.status(403).json({ error: "Admin access required" });
      }
    } catch {
      res.status(500).json({ error: "Admin authorization check failed. Please try again." });
    }
  })();
}
