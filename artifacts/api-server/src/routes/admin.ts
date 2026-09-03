import { clerkClient, getAuth } from "@clerk/express";
import { AdminProfilePayloadSchema, ShelfPreferencesPayloadSchema } from "@workspace/api-zod";
import { adminAuditLogTable, adminPreferencesTable, db, usersTable } from "@workspace/db";
import { desc, eq, lt } from "drizzle-orm";
import { Router } from "express";

import { type AIProvider,getProvider, setProvider } from "../lib/aiProvider";
import { logger } from "../lib/logger";
import { requireAdminAuth } from "../middlewares/requireAdminAuth";

const router = Router();

const RESTART_DELAY_MS = 200;

/**
 * The restart route deliberately uses a replaceable exit function. Tests can
 * stub this seam without ever terminating the Jest worker, while production
 * still delegates to the real process exit.
 */
export const restartRuntime = {
  exit(code: number): void {
    process.exit(code);
  },
  schedule(callback: () => void, delayMs: number): void {
    setTimeout(callback, delayMs);
  },
};

let restartInFlight = false;

/** Reset the route-local guard after a test that stubs restartRuntime.exit. */
export function resetRestartStateForTests(): void {
  restartInFlight = false;
}

// ── GET /admin/me ─────────────────────────────────────────────────────────────
// Self-check: tells the current (approved) Clerk user whether they are an admin.
// Only requires app-level auth (applied globally in app.ts), NOT admin auth, so
// non-admin users can call it to discover they are not admins.
router.get("/me", (req, res, next) => {
  try {
    const appUser = res.locals.appUser as { role?: string } | undefined;
    if (appUser) {
      return res.json({ isAdmin: appUser.role === "admin" });
    }
    const userId = getAuth(req)?.userId;
    const adminClerkUserId = process.env.ADMIN_CLERK_USER_ID;
    return res.json({ isAdmin: Boolean(adminClerkUserId && userId === adminClerkUserId) });
  } catch (err) {
    return void next(err);
  }
});

// ── GET /admin/profile ────────────────────────────────────────────────────────
// Returns the persisted admin preferences (all portable AppSettings fields).
router.get("/profile", requireAdminAuth, async (_req, res) => {
  try {
    const rows = await db
      .select()
      .from(adminPreferencesTable)
      .where(eq(adminPreferencesTable.id, 1))
      .limit(1);

    if (rows.length === 0) {
      return res.json({
        dimensionUnit: "mm",
        textSize: "normal",
        themeMode: "system",
        defaultConfidenceThreshold: 50,
        scanSound: true,
      });
    }

    const row = rows[0]!;
    return res.json({
      dimensionUnit: row.dimensionUnit,
      textSize: row.textSize,
      themeMode: row.themeMode,
      defaultConfidenceThreshold: row.defaultConfidenceThreshold,
      scanSound: row.scanSound,
    });
  } catch (_err) {
    return res.status(500).json({ error: "Failed to fetch admin profile" });
  }
});

// ── PUT /admin/profile ────────────────────────────────────────────────────────
// Upserts admin preferences for all portable AppSettings fields.
router.put("/profile", requireAdminAuth, async (req, res) => {
  const parsed = AdminProfilePayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" });
  }

  const { dimensionUnit, textSize, themeMode, defaultConfidenceThreshold, scanSound } = parsed.data;

  try {
    await db
      .insert(adminPreferencesTable)
      .values({
        id: 1,
        dimensionUnit,
        textSize,
        themeMode,
        defaultConfidenceThreshold,
        scanSound,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: adminPreferencesTable.id,
        set: {
          dimensionUnit,
          textSize,
          themeMode,
          defaultConfidenceThreshold,
          scanSound,
          updatedAt: new Date(),
        },
      });

    return res.json({ dimensionUnit, textSize, themeMode, defaultConfidenceThreshold, scanSound });
  } catch (_err) {
    return res.status(500).json({ error: "Failed to update admin profile" });
  }
});

// ── GET /admin/shelf-preferences ─────────────────────────────────────────────
// Returns persisted shelf prefix and step for the admin account.
router.get("/shelf-preferences", requireAdminAuth, async (_req, res) => {
  try {
    const rows = await db
      .select()
      .from(adminPreferencesTable)
      .where(eq(adminPreferencesTable.id, 1))
      .limit(1);

    if (rows.length === 0) {
      return res.json({ shelfPrefix: null, shelfStep: null });
    }

    const row = rows[0]!;
    return res.json({ shelfPrefix: row.shelfPrefix ?? null, shelfStep: row.shelfStep ?? null });
  } catch {
    return res.status(500).json({ error: "Failed to fetch shelf preferences" });
  }
});

// ── PATCH /admin/shelf-preferences ───────────────────────────────────────────
// Upserts shelf prefix and/or step for the admin account.
router.patch("/shelf-preferences", requireAdminAuth, async (req, res) => {
  const parsed = ShelfPreferencesPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" });
  }

  const { shelfPrefix, shelfStep } = parsed.data;

  const setFields: Record<string, unknown> = { updatedAt: new Date() };
  if (shelfPrefix !== undefined) setFields.shelfPrefix = shelfPrefix;
  if (shelfStep !== undefined) setFields.shelfStep = shelfStep;

  try {
    await db
      .insert(adminPreferencesTable)
      .values({
        id: 1,
        shelfPrefix: shelfPrefix ?? null,
        shelfStep: shelfStep ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: adminPreferencesTable.id,
        set: setFields,
      });

    const rows = await db
      .select()
      .from(adminPreferencesTable)
      .where(eq(adminPreferencesTable.id, 1))
      .limit(1);

    const row = rows[0];
    return res.json({ shelfPrefix: row?.shelfPrefix ?? null, shelfStep: row?.shelfStep ?? null });
  } catch {
    return res.status(500).json({ error: "Failed to update shelf preferences" });
  }
});

// ── GET /admin/ai-provider ────────────────────────────────────────────────────
// Returns the currently active AI provider.
router.get("/ai-provider", requireAdminAuth, (_req, res) => {
  return res.json({ provider: getProvider() });
});

// ── POST /admin/ai-provider ───────────────────────────────────────────────────
// Switches the active AI provider at runtime without restarting the server,
// and persists the choice to the database so it survives restarts.
// Body: { provider: "poe" | "openai" }
router.post("/ai-provider", requireAdminAuth, async (req, res) => {
  const { provider } = req.body as { provider?: unknown };

  if (provider !== "poe" && provider !== "openai") {
    return res
      .status(400)
      .json({ error: 'provider must be "poe" or "openai"' });
  }

  try {
    setProvider(provider as AIProvider);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(503).json({ error: message });
  }

  let persisted = true;
  try {
    await db
      .insert(adminPreferencesTable)
      .values({ id: 1, aiProvider: provider, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: adminPreferencesTable.id,
        set: { aiProvider: provider, updatedAt: new Date() },
      });
  } catch (_dbErr) {
    persisted = false;
  }

  return res.json({ provider: getProvider(), persisted });
});

// ── POST /admin/restart ───────────────────────────────────────────────────────
// Sends a 202 Accepted response, then exits the process after a short delay so
// the development workflow runner can restart it automatically. The route is
// intentionally not a production self-restart mechanism.
router.post("/restart", requireAdminAuth, (_req, res) => {
  if (process.env.NODE_ENV !== "development") {
    return res.status(503).json({
      restarting: false,
      code: "RESTART_UNAVAILABLE",
      error: "API restart is unavailable",
    });
  }

  if (restartInFlight) {
    return res.status(409).json({
      restarting: false,
      code: "RESTART_IN_PROGRESS",
      error: "API restart is already in progress",
    });
  }

  restartInFlight = true;
  res.status(202).json({ restarting: true });
  restartRuntime.schedule(() => {
    // Clear before calling the replaceable exit seam so a test stub, or an
    // unexpected no-op implementation, cannot leave the route permanently
    // blocked.
    restartInFlight = false;
    restartRuntime.exit(0);
  }, RESTART_DELAY_MS);
  return;
});

// ── User Management ───────────────────────────────────────────────────────────

// GET /admin/users — list all users with their status, role and email
router.get("/users", requireAdminAuth, async (_req, res) => {
  try {
    const users = await db
      .select({
        clerkUserId: usersTable.clerkUserId,
        email: usersTable.email,
        status: usersTable.status,
        role: usersTable.role,
        createdAt: usersTable.createdAt,
        updatedAt: usersTable.updatedAt,
      })
      .from(usersTable)
      .orderBy(usersTable.createdAt);

    return res.json({ users });
  } catch {
    return res.status(500).json({ error: "Failed to fetch users" });
  }
});

// POST /admin/users/:clerkUserId/approve — set status to approved
router.post("/users/:clerkUserId/approve", requireAdminAuth, async (req, res) => {
  const rawParam = req.params.clerkUserId;
  const clerkUserId = Array.isArray(rawParam) ? rawParam[0] : rawParam;
  if (typeof clerkUserId !== "string" || !clerkUserId) {
    return res.status(400).json({ error: "Missing clerkUserId" });
  }

  // An admin cannot approve themselves — self-approval bypasses any audit trail.
  const requestingUser = res.locals.appUser as { clerkUserId?: string } | undefined;
  if (requestingUser?.clerkUserId === clerkUserId) {
    return res.status(400).json({ error: "You cannot perform this action on your own account" });
  }

  try {
    const updated = await db
      .update(usersTable)
      .set({ status: "approved", updatedAt: new Date() })
      .where(eq(usersTable.clerkUserId, clerkUserId))
      .returning();

    if (updated.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const adminClerkUserId = requestingUser?.clerkUserId ?? (getAuth(req)?.userId ?? "unknown");
    db.insert(adminAuditLogTable)
      .values({ adminClerkUserId, targetClerkUserId: clerkUserId, action: "approve" })
      .catch((err: unknown) => logger.error({ err }, "Failed to write audit log for approve"));

    return res.json({ user: updated[0] });
  } catch {
    return res.status(500).json({ error: "Failed to approve user" });
  }
});

// POST /admin/users/:clerkUserId/ban — set status to banned
router.post("/users/:clerkUserId/ban", requireAdminAuth, async (req, res) => {
  const rawParam = req.params.clerkUserId;
  const clerkUserId = Array.isArray(rawParam) ? rawParam[0] : rawParam;
  if (typeof clerkUserId !== "string" || !clerkUserId) {
    return res.status(400).json({ error: "Missing clerkUserId" });
  }

  // The bootstrap admin cannot be banned — requireAppAuth would immediately
  // re-grant access on the next request anyway, so reject it explicitly.
  if (clerkUserId === process.env.ADMIN_CLERK_USER_ID) {
    return res.status(400).json({ error: "The bootstrap admin cannot be banned" });
  }

  // An admin cannot ban themselves — that would instantly lock them out.
  const requestingUser = res.locals.appUser as { clerkUserId?: string } | undefined;
  if (requestingUser?.clerkUserId === clerkUserId) {
    return res.status(400).json({ error: "You cannot perform this action on your own account" });
  }

  try {
    const updated = await db
      .update(usersTable)
      .set({ status: "banned", updatedAt: new Date() })
      .where(eq(usersTable.clerkUserId, clerkUserId))
      .returning();

    if (updated.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const adminClerkUserId = requestingUser?.clerkUserId ?? (getAuth(req)?.userId ?? "unknown");
    db.insert(adminAuditLogTable)
      .values({ adminClerkUserId, targetClerkUserId: clerkUserId, action: "ban" })
      .catch((err: unknown) => logger.error({ err }, "Failed to write audit log for ban"));

    return res.json({ user: updated[0] });
  } catch {
    return res.status(500).json({ error: "Failed to ban user" });
  }
});

// POST /admin/users/:clerkUserId/promote — grant admin role to an approved user
router.post("/users/:clerkUserId/promote", requireAdminAuth, async (req, res) => {
  const rawParam = req.params.clerkUserId;
  const clerkUserId = Array.isArray(rawParam) ? rawParam[0] : rawParam;
  if (typeof clerkUserId !== "string" || !clerkUserId) {
    return res.status(400).json({ error: "Missing clerkUserId" });
  }
  try {
    const existing = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.clerkUserId, clerkUserId))
      .limit(1);

    const user = existing[0];
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    if (user.status !== "approved") {
      return res.status(400).json({ error: "Only approved users can be promoted to admin" });
    }

    const updated = await db
      .update(usersTable)
      .set({ role: "admin", updatedAt: new Date() })
      .where(eq(usersTable.clerkUserId, clerkUserId))
      .returning();

    if (updated.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const requestingUser = res.locals.appUser as { clerkUserId?: string } | undefined;
    const adminClerkUserId = requestingUser?.clerkUserId ?? (getAuth(req)?.userId ?? "unknown");
    db.insert(adminAuditLogTable)
      .values({ adminClerkUserId, targetClerkUserId: clerkUserId, action: "promote" })
      .catch((err: unknown) => logger.error({ err }, "Failed to write audit log for promote"));

    return res.json({ user: updated[0] });
  } catch {
    return res.status(500).json({ error: "Failed to promote user" });
  }
});

// POST /admin/users/:clerkUserId/demote — revoke admin role
router.post("/users/:clerkUserId/demote", requireAdminAuth, async (req, res) => {
  const rawParam = req.params.clerkUserId;
  const clerkUserId = Array.isArray(rawParam) ? rawParam[0] : rawParam;
  if (typeof clerkUserId !== "string" || !clerkUserId) {
    return res.status(400).json({ error: "Missing clerkUserId" });
  }

  // The bootstrap admin is always an admin — demoting it would be a no-op that
  // requireAppAuth immediately reverses, so reject it explicitly.
  if (clerkUserId === process.env.ADMIN_CLERK_USER_ID) {
    return res.status(400).json({ error: "The bootstrap admin cannot be demoted" });
  }

  // An admin cannot demote themselves — that would instantly remove their own
  // access to the admin section.
  const requestingUser = res.locals.appUser as { clerkUserId?: string } | undefined;
  if (requestingUser?.clerkUserId === clerkUserId) {
    return res.status(400).json({ error: "You cannot perform this action on your own account" });
  }

  try {
    const updated = await db
      .update(usersTable)
      .set({ role: "user", updatedAt: new Date() })
      .where(eq(usersTable.clerkUserId, clerkUserId))
      .returning();

    if (updated.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const adminClerkUserId = requestingUser?.clerkUserId ?? (getAuth(req)?.userId ?? "unknown");
    db.insert(adminAuditLogTable)
      .values({ adminClerkUserId, targetClerkUserId: clerkUserId, action: "demote" })
      .catch((err: unknown) => logger.error({ err }, "Failed to write audit log for demote"));

    return res.json({ user: updated[0] });
  } catch {
    return res.status(500).json({ error: "Failed to demote user" });
  }
});

// DELETE /admin/users/:clerkUserId — hard-delete a user row from the DB
router.delete("/users/:clerkUserId", requireAdminAuth, async (req, res) => {
  const rawParam = req.params.clerkUserId;
  const clerkUserId = Array.isArray(rawParam) ? rawParam[0] : rawParam;
  if (typeof clerkUserId !== "string" || !clerkUserId) {
    return res.status(400).json({ error: "Missing clerkUserId" });
  }

  // The bootstrap admin cannot be deleted — it would immediately re-appear on
  // next sign-in via requireAppAuth.
  if (clerkUserId === process.env.ADMIN_CLERK_USER_ID) {
    return res.status(400).json({ error: "The bootstrap admin cannot be deleted" });
  }

  // An admin cannot delete their own account while authenticated.
  const requestingUser = res.locals.appUser as { clerkUserId?: string } | undefined;
  if (requestingUser?.clerkUserId === clerkUserId) {
    return res.status(400).json({ error: "You cannot delete your own account" });
  }

  try {
    const deleted = await db
      .delete(usersTable)
      .where(eq(usersTable.clerkUserId, clerkUserId))
      .returning();

    if (deleted.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    // Best-effort: remove the user from Clerk so they cannot sign in again and
    // recreate a pending DB row. If CLERK_SECRET_KEY is absent or the call
    // fails, the DB row is already gone so we still return deleted:true — but
    // we set clerkDeleted:false so the UI can surface a clear warning.
    if (!process.env.CLERK_SECRET_KEY) {
      return res.json({
        deleted: true,
        clerkDeleted: false,
        clerkError: "No CLERK_SECRET_KEY configured — Clerk account may still be active",
      });
    }

    try {
      await clerkClient.users.deleteUser(clerkUserId);
      return res.json({ deleted: true, clerkDeleted: true });
    } catch (clerkErr) {
      const msg = clerkErr instanceof Error ? clerkErr.message : String(clerkErr);
      logger.warn({ clerkUserId, msg }, "[admin] DB row deleted but Clerk deletion failed");
      return res.json({ deleted: true, clerkDeleted: false, clerkError: msg });
    }
  } catch {
    return res.status(500).json({ error: "Failed to delete user" });
  }
});

// ── GET /admin/audit-log ──────────────────────────────────────────────────────
// Returns admin action audit log entries in reverse-chronological order.
// Supports cursor-based pagination via before_id.
// Query params:
//   limit    — max rows to return (default 50, max 200)
//   before_id — return only rows with id < before_id (cursor for next page)
router.get("/audit-log", requireAdminAuth, async (req, res) => {
  const rawLimit = Number(req.query.limit ?? 50);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, 200)
    : 50;

  const rawBeforeId = req.query.before_id;
  const beforeId = rawBeforeId !== undefined ? Number(rawBeforeId) : null;
  if (beforeId !== null && (!Number.isFinite(beforeId) || beforeId <= 0)) {
    return res.status(400).json({ error: "before_id must be a positive integer" });
  }

  try {
    const whereClause = beforeId !== null
      ? lt(adminAuditLogTable.id, beforeId)
      : undefined;

    const rows = await db
      .select()
      .from(adminAuditLogTable)
      .where(whereClause)
      .orderBy(desc(adminAuditLogTable.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? pageRows[pageRows.length - 1]!.id : null;

    return res.json({ rows: pageRows, nextCursor }); // spec:ignore-unguarded
  } catch {
    return res.status(500).json({ error: "Failed to fetch audit log" });
  }
});

export default router;
