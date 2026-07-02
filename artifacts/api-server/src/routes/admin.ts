import { Router, type Request, type Response, type NextFunction } from "express";
import crypto from "node:crypto";
import { db, adminPreferencesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { AdminProfilePayloadSchema, ShelfPreferencesPayloadSchema } from "@workspace/api-zod";
import { getProvider, setProvider, type AIProvider } from "../lib/aiProvider";

const router = Router();

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (matches app session TTL; explicit logout uses _revokedBefore fence)

// ── Token revocation state ────────────────────────────────────────────────────
// In-memory timestamp: tokens issued AT OR BEFORE this time are rejected.
// Calling POST /admin/logout sets this to Date.now(), invalidating all
// outstanding tokens without requiring a server restart.
let _revokedBefore = 0;

/** Exposed for testing only — lets tests reset revocation state between runs. */
export function setRevokedBefore(ts: number): void {
  _revokedBefore = ts;
}

/** Exposed for testing — returns the current revocation threshold. */
export function getRevokedBefore(): number {
  return _revokedBefore;
}

/**
 * Sign a timestamp with ADMIN_PASSWORD using HMAC-SHA256.
 * Returns a token string: "<timestamp>.<hex-sig>"
 */
export function signAdminToken(ts: number, secret: string): string {
  const payload = String(ts);
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return Buffer.from(`${payload}.${sig}`).toString("base64url");
}

/**
 * Verify a signed admin token.
 * Returns true if valid, not expired, and issued after `notBefore`.
 *
 * @param notBefore  Unix ms timestamp — tokens issued AT OR BEFORE this time
 *                   are rejected (revocation fence).  Defaults to 0 (no fence).
 */
export function verifyAdminToken(token: string, secret: string, notBefore = 0): boolean {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const dotIdx = decoded.indexOf(".");
    if (dotIdx === -1) return false;

    const payload = decoded.slice(0, dotIdx);
    const sig = decoded.slice(dotIdx + 1);

    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");

    if (!crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expectedSig, "hex"))) {
      return false;
    }

    const ts = parseInt(payload, 10);
    if (isNaN(ts)) return false;

    // Token must not be expired AND must have been issued AFTER the revocation fence
    return Date.now() - ts < TOKEN_TTL_MS && ts > notBefore;
  } catch {
    return false;
  }
}

export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.ADMIN_PASSWORD;
  if (!secret) {
    res.status(503).json({ error: "Admin access is not configured on this server. Set ADMIN_PASSWORD." });
    return;
  }
  const auth = req.headers["authorization"] ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !verifyAdminToken(token, secret, _revokedBefore)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// ── POST /admin/login ─────────────────────────────────────────────────────────
router.post("/login", (req, res) => {
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    return res
      .status(503)
      .json({ error: "Admin access is not configured on this server. Set ADMIN_PASSWORD." });
  }

  const { password } = req.body as { password?: string };

  if (!password || password !== adminPassword) {
    return res.status(401).json({ error: "Incorrect admin password" });
  }

  const token = signAdminToken(Date.now(), adminPassword);
  return res.json({ token, expiresIn: TOKEN_TTL_MS / 1000 });
});

// ── POST /admin/logout ────────────────────────────────────────────────────────
// Revokes all outstanding tokens immediately by advancing the revocation fence
// to the current time.  Any token whose issue timestamp is <= revokedBefore
// will be rejected on the next request, without requiring a server restart.
router.post("/logout", requireAdminAuth, (_req, res) => {
  _revokedBefore = Date.now();
  return res.json({ success: true, revokedAt: _revokedBefore });
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
  } catch (err) {
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
  } catch (err) {
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
  } catch (dbErr) {
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

export default router;
