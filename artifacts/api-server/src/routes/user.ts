import { clerkClient } from "@clerk/express";
import {
  GetUserHistoryResponse,
  UpdateUserHistoryResponse,
} from "@workspace/api-zod";
import {
  catalogPdfUploadPartTable,
  catalogPdfUploadSessionTable,
  db,
  type UserHistoryScanEntry,
  userHistoryTable,
  type UserHistoryViewedEntry,
  usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { type Response, Router } from "express";

import { logger } from "../lib/logger";
import { deleteCatalogPdfPart } from "../lib/objectStorage";

const router = Router();

const MAX_QUERY_HISTORY = 10;
const MAX_VIEWED_HISTORY = 10;
const MAX_SCAN_HISTORY = 50;

type UserHistoryPatch = {
  queryHistory?: Array<string>;
  viewedHistory?: Array<UserHistoryViewedEntry>;
  scanHistory?: Array<UserHistoryScanEntry>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Array<string>): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isViewedEntry(value: unknown): value is UserHistoryViewedEntry {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "catalog", "name", "vendor", "timestamp"])) {
    return false;
  }
  return (
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    value.id > 0 &&
    typeof value.catalog === "string" &&
    typeof value.name === "string" &&
    typeof value.vendor === "string" &&
    isValidTimestamp(value.timestamp)
  );
}

function isScanEntry(value: unknown): value is UserHistoryScanEntry {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["barcode", "found", "itemId", "catalog", "vendor", "timestamp", "adminAction"])
  ) {
    return false;
  }
  return (
    typeof value.barcode === "string" &&
    value.barcode.length > 0 &&
    typeof value.found === "boolean" &&
    (value.itemId === undefined ||
      (typeof value.itemId === "number" && Number.isSafeInteger(value.itemId) && value.itemId > 0)) &&
    (value.catalog === undefined || typeof value.catalog === "string") &&
    (value.vendor === undefined || typeof value.vendor === "string") &&
    isValidTimestamp(value.timestamp) &&
    (value.adminAction === undefined ||
      value.adminAction === "linked" ||
      value.adminAction === "created")
  );
}

function parseUserHistoryPatch(value: unknown): UserHistoryPatch | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["queryHistory", "viewedHistory", "scanHistory"]) ||
    Object.keys(value).length === 0
  ) {
    return null;
  }

  const patch: UserHistoryPatch = {};

  if ("queryHistory" in value) {
    const queries = value.queryHistory;
    if (
      !Array.isArray(queries) ||
      queries.length > MAX_QUERY_HISTORY ||
      !queries.every((query) => typeof query === "string" && query.trim().length > 0)
    ) {
      return null;
    }
    patch.queryHistory = queries;
  }

  if ("viewedHistory" in value) {
    const viewed = value.viewedHistory;
    if (
      !Array.isArray(viewed) ||
      viewed.length > MAX_VIEWED_HISTORY ||
      !viewed.every(isViewedEntry)
    ) {
      return null;
    }
    patch.viewedHistory = viewed;
  }

  if ("scanHistory" in value) {
    const scans = value.scanHistory;
    if (!Array.isArray(scans) || scans.length > MAX_SCAN_HISTORY || !scans.every(isScanEntry)) {
      return null;
    }
    patch.scanHistory = scans;
  }

  return patch;
}

function getAuthenticatedUserId(res: Response): string | null {
  const appUser = res.locals.appUser as { clerkUserId?: string } | undefined;
  return typeof appUser?.clerkUserId === "string" && appUser.clerkUserId.length > 0
    ? appUser.clerkUserId
    : null;
}

function emptyUserHistory() {
  return { queryHistory: [], viewedHistory: [], scanHistory: [] };
}

router.get("/history", async (_req, res) => {
  const clerkUserId = getAuthenticatedUserId(res);
  if (!clerkUserId) return res.status(401).json({ error: "Authentication required" });

  try {
    const [history] = await db
      .select({
        queryHistory: userHistoryTable.queryHistory,
        viewedHistory: userHistoryTable.viewedHistory,
        scanHistory: userHistoryTable.scanHistory,
      })
      .from(userHistoryTable)
      .where(eq(userHistoryTable.clerkUserId, clerkUserId))
      .limit(1);
    return res.json(GetUserHistoryResponse.parse(history ?? emptyUserHistory()));
  } catch (err) {
    logger.error({ err, clerkUserId }, "getUserHistory: DB read failed");
    return res.status(500).json({ error: "Failed to load history" });
  }
});

router.patch("/history", async (req, res) => {
  const clerkUserId = getAuthenticatedUserId(res);
  if (!clerkUserId) return res.status(401).json({ error: "Authentication required" });

  const patch = parseUserHistoryPatch(req.body);
  if (!patch) {
    return res.status(400).json({ error: "Invalid history update" });
  }

  try {
    await db
      .insert(userHistoryTable)
      .values({ clerkUserId, ...patch })
      .onConflictDoUpdate({
        target: userHistoryTable.clerkUserId,
        set: { ...patch, updatedAt: new Date() },
      });

    const [history] = await db
      .select({
        queryHistory: userHistoryTable.queryHistory,
        viewedHistory: userHistoryTable.viewedHistory,
        scanHistory: userHistoryTable.scanHistory,
      })
      .from(userHistoryTable)
      .where(eq(userHistoryTable.clerkUserId, clerkUserId))
      .limit(1);
    return res.json(UpdateUserHistoryResponse.parse(history ?? emptyUserHistory()));
  } catch (err) {
    logger.error({ err, clerkUserId }, "updateUserHistory: DB write failed");
    return res.status(500).json({ error: "Failed to save history" });
  }
});

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
    // Remove all staged PDF source parts owned by this account before removing
    // its database row. The operation is idempotent: missing objects are
    // already clean and failed deletes are logged for retry rather than
    // turning a successful account deletion into a partial data leak.
    const sessions = await db
      .select({ id: catalogPdfUploadSessionTable.id })
      .from(catalogPdfUploadSessionTable)
      .where(eq(catalogPdfUploadSessionTable.ownerClerkUserId, clerkUserId));
    for (const session of sessions) {
      const parts = await db
        .select({ partIndex: catalogPdfUploadPartTable.partIndex })
        .from(catalogPdfUploadPartTable)
        .where(eq(catalogPdfUploadPartTable.sessionId, session.id));
      await Promise.all(
        parts.map((part) => deleteCatalogPdfPart(session.id, part.partIndex)),
      );
      await db
        .delete(catalogPdfUploadPartTable)
        .where(eq(catalogPdfUploadPartTable.sessionId, session.id));
      await db
        .update(catalogPdfUploadSessionTable)
        .set({ cleanupAt: new Date(), updatedAt: new Date() })
        .where(eq(catalogPdfUploadSessionTable.id, session.id));
    }

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
