import { Router, type Request, type Response, type NextFunction } from "express";
import crypto from "node:crypto";
import { db, adminPreferencesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const VALID_DIMENSION_UNITS = new Set(["mm", "cm", "in"]);

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
// Returns the persisted admin preferences (dimensionUnit).
router.get("/profile", requireAdminAuth, async (_req, res) => {
  try {
    const rows = await db
      .select()
      .from(adminPreferencesTable)
      .where(eq(adminPreferencesTable.id, 1))
      .limit(1);

    if (rows.length === 0) {
      return res.json({ dimensionUnit: "mm" });
    }

    return res.json({ dimensionUnit: rows[0].dimensionUnit });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch admin profile" });
  }
});

// ── PUT /admin/profile ────────────────────────────────────────────────────────
// Upserts admin preferences. Currently supports: dimensionUnit.
router.put("/profile", requireAdminAuth, async (req, res) => {
  const { dimensionUnit } = req.body as { dimensionUnit?: string };

  if (!dimensionUnit || !VALID_DIMENSION_UNITS.has(dimensionUnit)) {
    return res.status(400).json({ error: `dimensionUnit must be one of: mm, cm, in` });
  }

  try {
    await db
      .insert(adminPreferencesTable)
      .values({ id: 1, dimensionUnit, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: adminPreferencesTable.id,
        set: { dimensionUnit, updatedAt: new Date() },
      });

    return res.json({ dimensionUnit });
  } catch (err) {
    return res.status(500).json({ error: "Failed to update admin profile" });
  }
});

export default router;
