import { clerkClient,getAuth } from "@clerk/express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { and, eq, ne } from "drizzle-orm";
import { type NextFunction,type Request, type Response } from "express";

import { logger } from "../lib/logger";
import { isPublicRoute } from "../routes/routeAccessMatrix";

/**
 * Resolve a Clerk user's *primary* email address rather than blindly taking the
 * first entry in the list. Clerk designates one address as primary via
 * `primaryEmailAddressId`; when the user changes their primary email this is the
 * value that should follow. Falls back to the first address if no primary is
 * designated (e.g. single-email accounts).
 */
function resolvePrimaryEmail(clerkUser: {
  primaryEmailAddressId?: string | null;
  emailAddresses: Array<{ id: string; emailAddress: string }>;
}): string {
  const primary = clerkUser.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId);
  return primary?.emailAddress ?? clerkUser.emailAddresses[0]?.emailAddress ?? "";
}

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
  if (isPublicRoute(req.method, req.path)) {
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
      // Resolve the real email from Clerk the same way the standard new-user
      // flow does. Failing to fetch the email must never block the admin from
      // authenticating, so fall back to preserving whatever is already stored.
      let email = "";
      try {
        const clerkUser = await clerkClient.users.getUser(userId);
        email = resolvePrimaryEmail(clerkUser);
      } catch (clerkErr) {
        const requestId = res.locals.requestId as string | undefined;
        logger.error(
          { err: clerkErr, userId, requestId },
          "requireAppAuth: Clerk email fetch failed for bootstrap admin",
        );
      }

      // Persist the admin row. When we resolved an email it must be written
      // through, but the `users` table enforces a partial unique index on
      // non-empty email — a *different* row may already hold this same email
      // (e.g. the admin previously authenticated under a different Clerk id, or
      // a stale duplicate). A plain upsert only handles conflicts on
      // clerk_user_id, so an email collision would surface as an unhandled
      // uniqueness violation and 500 every authenticated admin request.
      //
      // To stay collision-safe we consolidate inside a single transaction:
      // delete any *other* row holding this email, then upsert the canonical
      // admin row keyed by the bootstrap admin's clerk_user_id. The net result
      // is exactly one row for the admin, carrying the real email with
      // role=admin/status=approved.
      //
      // A write failure here (for any reason) must never lock the admin out, so
      // it is caught and logged while access is still granted below.
      try {
        if (email) {
          await db.transaction(async (tx) => {
            await tx
              .delete(usersTable)
              .where(and(eq(usersTable.email, email), ne(usersTable.clerkUserId, userId)));
            await tx
              .insert(usersTable)
              .values({ clerkUserId: userId, email, status: "approved", role: "admin" })
              .onConflictDoUpdate({
                target: usersTable.clerkUserId,
                set: { email, status: "approved", role: "admin", updatedAt: new Date() },
              });
          });
        } else {
          // No email resolved (Clerk fetch failed) — leave any stored email
          // untouched and just force approved+admin so the admin keeps access.
          await db
            .insert(usersTable)
            .values({ clerkUserId: userId, email, status: "approved", role: "admin" })
            .onConflictDoUpdate({
              target: usersTable.clerkUserId,
              set: { status: "approved", role: "admin", updatedAt: new Date() },
            });
        }
      } catch (writeErr) {
        const requestId = res.locals.requestId as string | undefined;
        logger.error(
          { err: writeErr, userId, requestId },
          "requireAppAuth: bootstrap admin row write failed; preserving admin access",
        );
      }
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
        email = resolvePrimaryEmail(clerkUser);
      } catch (clerkErr) {
        const requestId = res.locals.requestId as string | undefined;
        logger.error({ err: clerkErr, userId, requestId }, "requireAppAuth: Clerk email fetch failed");
        res.status(500).json({ error: "Failed to retrieve user profile. Please try again." });
        return;
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
