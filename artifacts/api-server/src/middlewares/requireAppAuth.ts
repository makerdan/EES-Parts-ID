import { clerkClient,getAuth } from "@clerk/express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { type NextFunction,type Request, type Response } from "express";

// Paths relative to /api that do not require any authentication token.
const PUBLIC_PATHS = new Set(["/healthz"]);

/**
 * Middleware that validates a Clerk session token on all /api/* routes except
 * the public whitelist above.
 *
 * The Clerk session (set by clerkMiddleware in app.ts) represents an individual
 * user. The user must exist in the `users` table with status='approved'. The
 * designated bootstrap admin (ADMIN_CLERK_USER_ID env var) is always forced to
 * status='approved' AND role='admin' so there is always a way in.
 *
 * On success the resolved user row is stored on `res.locals.appUser` so that
 * downstream guards (e.g. requireAdminAuth) can read the role without a second
 * database round-trip.
 *
 * 401 — no valid session
 * 403 { code: "pending" } — user awaiting approval
 * 403 { code: "banned" } — user permanently revoked
 */
export async function requireAppAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (PUBLIC_PATHS.has(req.path)) {
    next();
    return;
  }

  const clerkAuth = getAuth(req);
  const userId = clerkAuth?.userId;

  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const adminClerkUserId = process.env.ADMIN_CLERK_USER_ID;

    // Bootstrap admin: force status=approved AND role=admin on every request.
    if (adminClerkUserId && userId === adminClerkUserId) {
      await db
        .insert(usersTable)
        .values({ clerkUserId: userId, email: "", status: "approved", role: "admin" })
        .onConflictDoUpdate({
          target: usersTable.clerkUserId,
          set: { status: "approved", role: "admin", updatedAt: new Date() },
        });
      res.locals.appUser = { clerkUserId: userId, status: "approved", role: "admin" };
      res.locals.isBootstrapAdmin = true;
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
        if (!clerkUser.emailAddresses.length) {
          res.status(401).json({ error: "No email address associated with this account." });
          return;
        }
        email = clerkUser.emailAddresses[0]?.emailAddress ?? "";
      } catch {
        // Proceed without email; it can be updated later.
      }

      // Before inserting, check whether a row already exists for this email
      // (e.g. same person authenticated with a different Clerk ID previously).
      // If found, migrate the existing row to the current Clerk ID instead of
      // creating a duplicate.
      if (email) {
        const existingByEmail = await db
          .select()
          .from(usersTable)
          .where(eq(usersTable.email, email))
          .limit(1);

        if (existingByEmail.length > 0) {
          const updated = await db
            .update(usersTable)
            .set({ clerkUserId: userId, updatedAt: new Date() })
            .where(eq(usersTable.email, email))
            .returning();
          user = updated[0]!;
        }
      }

      if (!user) {
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
    }

    if (!user) {
      res.status(500).json({ error: "User record could not be created." });
      return;
    }

    if (user.status === "approved") {
      res.locals.appUser = user;
      next();
    } else if (user.status === "banned") {
      res.status(403).json({ code: "banned", error: "Your account has been disabled." });
    } else {
      res.status(403).json({ code: "pending", error: "Your account is awaiting approval." });
    }
  } catch (err) {
    next(err);
  }
}
