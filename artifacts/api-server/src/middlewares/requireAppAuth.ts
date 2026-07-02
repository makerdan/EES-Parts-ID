import { type Request, type Response, type NextFunction } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { verifyAdminToken, getRevokedBefore } from "../routes/admin";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// Paths relative to /api that do not require any authentication token.
// /admin/login must stay public so the admin-bootstrap call can reach the handler.
const PUBLIC_PATHS = new Set(["/healthz", "/admin/login"]);

/**
 * Middleware that validates either an admin HMAC token or a Clerk session token
 * on all /api/* routes except the public whitelist above.
 *
 * Admin HMAC tokens (from POST /admin/login) bypass user approval checks —
 * they are for the AdminGate and are validated with ADMIN_PASSWORD.
 *
 * Clerk session tokens represent individual user sessions. The user must exist
 * in the `users` table with status='approved'. The designated admin user
 * (ADMIN_CLERK_USER_ID env var) is always forced to approved status.
 *
 * 401 — no valid token
 * 403 { code: "pending" } — user awaiting approval
 * 403 { code: "banned" } — user permanently revoked
 */
export function requireAppAuth(req: Request, res: Response, next: NextFunction): void {
  if (PUBLIC_PATHS.has(req.path)) {
    next();
    return;
  }

  const auth = req.headers["authorization"] ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  // Try admin HMAC token first — if valid, bypass Clerk and user approval checks.
  const adminSecret = process.env.ADMIN_PASSWORD;
  const isValidAdmin = adminSecret
    ? verifyAdminToken(token, adminSecret, getRevokedBefore())
    : false;

  if (isValidAdmin) {
    next();
    return;
  }

  // Try Clerk session token (set by clerkMiddleware in app.ts).
  const clerkAuth = getAuth(req);
  const userId = clerkAuth?.userId;

  if (!userId) {
    res.status(401).json({ error: "Invalid or expired session. Please log in again." });
    return;
  }

  // Async: upsert user record and check approval status.
  (async () => {
    try {
      const adminClerkUserId = process.env.ADMIN_CLERK_USER_ID;

      // Admin user: force status to approved on every request.
      if (adminClerkUserId && userId === adminClerkUserId) {
        await db
          .insert(usersTable)
          .values({ clerkUserId: userId, email: "", status: "approved" })
          .onConflictDoUpdate({
            target: usersTable.clerkUserId,
            set: { status: "approved", updatedAt: new Date() },
          });
        next();
        return;
      }

      // Check if user already exists.
      const existing = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.clerkUserId, userId))
        .limit(1);

      let user = existing[0];

      if (!user) {
        // New user: fetch email from Clerk API, then insert with pending status.
        let email = "";
        try {
          const clerkUser = await clerkClient.users.getUser(userId);
          email = clerkUser.emailAddresses[0]?.emailAddress ?? "";
        } catch {
          // Proceed without email; it can be updated later.
        }

        const inserted = await db
          .insert(usersTable)
          .values({ clerkUserId: userId, email, status: "pending" })
          .onConflictDoNothing()
          .returning();

        if (inserted.length > 0) {
          user = inserted[0]!;
        } else {
          // Race condition: another request inserted first, re-query.
          const refetch = await db
            .select()
            .from(usersTable)
            .where(eq(usersTable.clerkUserId, userId))
            .limit(1);
          user = refetch[0]!;
        }
      }

      if (!user) {
        res.status(500).json({ error: "User record could not be created." });
        return;
      }

      if (user.status === "approved") {
        next();
      } else if (user.status === "banned") {
        res.status(403).json({ code: "banned", error: "Your account has been disabled." });
      } else {
        res.status(403).json({ code: "pending", error: "Your account is awaiting approval." });
      }
    } catch (err) {
      res.status(500).json({ error: "Authentication check failed. Please try again." });
    }
  })();
}
