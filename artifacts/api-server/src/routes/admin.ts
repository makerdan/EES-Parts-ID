import { Router, type Request, type Response, type NextFunction } from "express";
import crypto from "node:crypto";
import { db, adminPreferencesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const VALID_DIMENSION_UNITS = new Set(["mm", "cm", "in"]);
const VALID_TEXT_SIZES = new Set(["small", "normal", "large"]);
const VALID_THEME_MODES = new Set(["light", "dark", "system"]);

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
 * Returns true if valid and not expired.
 */
export function verifyAdminToken(token: string, secret: string): boolean {
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

    return Date.now() - ts < TOKEN_TTL_MS;
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
  if (!token || !verifyAdminToken(token, secret)) {
    res.status(403).json({ error: "Forbidden" });
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
  const body = req.body as {
    dimensionUnit?: string;
    textSize?: string;
    themeMode?: string;
    defaultConfidenceThreshold?: number;
    scanSound?: boolean;
  };

  const { dimensionUnit, textSize, themeMode, defaultConfidenceThreshold, scanSound } = body;

  if (!dimensionUnit || !VALID_DIMENSION_UNITS.has(dimensionUnit)) {
    return res.status(400).json({ error: `dimensionUnit must be one of: mm, cm, in` });
  }
  if (!textSize || !VALID_TEXT_SIZES.has(textSize)) {
    return res.status(400).json({ error: `textSize must be one of: small, normal, large` });
  }
  if (!themeMode || !VALID_THEME_MODES.has(themeMode)) {
    return res.status(400).json({ error: `themeMode must be one of: light, dark, system` });
  }
  if (
    defaultConfidenceThreshold === undefined ||
    defaultConfidenceThreshold === null ||
    typeof defaultConfidenceThreshold !== "number" ||
    !Number.isInteger(defaultConfidenceThreshold) ||
    defaultConfidenceThreshold < 0 ||
    defaultConfidenceThreshold > 100
  ) {
    return res.status(400).json({ error: `defaultConfidenceThreshold must be an integer between 0 and 100` });
  }
  if (typeof scanSound !== "boolean") {
    return res.status(400).json({ error: `scanSound must be a boolean` });
  }

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

export default router;
