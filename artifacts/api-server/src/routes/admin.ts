import { getAuth } from "@clerk/express";
import { AdminProfilePayloadSchema, ShelfPreferencesPayloadSchema } from "@workspace/api-zod";
import { adminPreferencesTable, db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { Router } from "express";

import { type AIProvider,getProvider, setProvider } from "../lib/aiProvider";
import { requireAdminAuth } from "../middlewares/requireAdminAuth";

const router = Router();

// ── GET /admin/me ─────────────────────────────────────────────────────────────
// Self-check: tells the current (approved) Clerk user whether they are an admin.
// Only requires app-level auth (applied globally in app.ts), NOT admin auth, so
// non-admin users can call it to discover they are not admins.
router.get("/me", (req, res) => {
  const appUser = res.locals.appUser as { role?: string } | undefined;
  if (appUser) {
    return res.json({ isAdmin: appUser.role === "admin" });
  }
  const userId = getAuth(req)?.userId;
  const adminClerkUserId = process.env.ADMIN_CLERK_USER_ID;
  return res.json({ isAdmin: Boolean(adminClerkUserId && userId === adminClerkUserId) });
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

    const row = rows[0];
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

    const row = rows[0];
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
// Sends a 202 Accepted response, then exits the process after a short delay
// so Replit's workflow runner can restart it automatically.
router.post("/restart", requireAdminAuth, (_req, res) => {
  res.status(202).json({ restarting: true });
  setTimeout(() => process.exit(0), 200);
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
  try {
    const updated = await db
      .update(usersTable)
      .set({ status: "approved", updatedAt: new Date() })
      .where(eq(usersTable.clerkUserId, clerkUserId))
      .returning();

    if (updated.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
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
  try {
    const updated = await db
      .update(usersTable)
      .set({ status: "banned", updatedAt: new Date() })
      .where(eq(usersTable.clerkUserId, clerkUserId))
      .returning();

    if (updated.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
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

  try {
    const updated = await db
      .update(usersTable)
      .set({ role: "user", updatedAt: new Date() })
      .where(eq(usersTable.clerkUserId, clerkUserId))
      .returning();

    if (updated.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    return res.json({ user: updated[0] });
  } catch {
    return res.status(500).json({ error: "Failed to demote user" });
  }
});

export default router;
