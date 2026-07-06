import { clerkClient } from "@clerk/express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { Router } from "express";

import { logger } from "../lib/logger";

const router = Router();

// DELETE /user/me — self-service account deletion.
// Deletes the authenticated caller's own DB row and Clerk identity.
// Returns 204 on success. Returns a clear error body on failure.
// An authenticated user can only ever delete their own account via this route.
router.delete("/me", async (req, res) => {
  const appUser = res.locals.appUser as { clerkUserId?: string } | undefined;
  const clerkUserId = appUser?.clerkUserId;

  if (!clerkUserId) {
    return res.status(401).json({ error: "Authentication required" });
  }

  // The bootstrap admin cannot be deleted via self-service — it would
  // immediately re-appear on next sign-in via requireAppAuth.
  if (clerkUserId === process.env.ADMIN_CLERK_USER_ID) {
    return res.status(400).json({ error: "The bootstrap admin account cannot be deleted" });
  }

  try {
    const deleted = await db
      .delete(usersTable)
      .where(eq(usersTable.clerkUserId, clerkUserId))
      .returning();

    if (deleted.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
  } catch (err) {
    logger.error({ err, clerkUserId }, "deleteUserMe: DB delete failed");
    return res.status(500).json({ error: "Failed to delete account. Please try again." });
  }

  // Attempt Clerk deletion after DB row is gone. If Clerk fails, the DB row is
  // already removed — surface the error so the caller knows the Clerk identity
  // is still live (and could allow auto-recreation via requireAppAuth).
  try {
    await clerkClient.users.deleteUser(clerkUserId);
  } catch (err) {
    logger.error({ err, clerkUserId }, "deleteUserMe: Clerk deleteUser failed after DB delete");
    return res.status(502).json({
      error:
        "Your local account was removed but the identity provider deletion failed. " +
        "Please contact support to complete account removal.",
    });
  }

  return res.status(204).send();
});

export default router;
