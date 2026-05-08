/**
 * Admin/ops endpoints — taxonomy reseed, per-item category override,
 * bulk re-classification. Not exposed in the mobile UI; intended to be
 * hit from a script or the admin upload tool.
 */
import { Router } from 'express';
import crypto from 'node:crypto';

const router = Router();

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Sign a timestamp with ADMIN_PASSWORD using HMAC-SHA256.
 * Returns a token string: "<timestamp>.<hex-sig>"
 */
export function signAdminToken(ts: number, secret: string): string {
  const payload = String(ts);
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

/**
 * Verify a signed admin token.
 * Returns true if valid and not expired.
 */
export function verifyAdminToken(token: string, secret: string): boolean {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const dotIdx = decoded.indexOf('.');
    if (dotIdx === -1) return false;

    const payload = decoded.slice(0, dotIdx);
    const sig = decoded.slice(dotIdx + 1);

    const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expectedSig, 'hex'))) {
      return false;
    }

    const ts = parseInt(payload, 10);
    if (isNaN(ts)) return false;

    return Date.now() - ts < TOKEN_TTL_MS;
  } catch {
    return false;
  }
}

// ── POST /admin/login ─────────────────────────────────────────────────────────
router.post('/login', (req, res) => {
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    return res
      .status(503)
      .json({ error: 'Admin access is not configured on this server. Set ADMIN_PASSWORD.' });
  }

  const { password } = req.body as { password?: string };

  if (!password || password !== adminPassword) {
    return res.status(401).json({ error: 'Incorrect admin password' });
  }

  const token = signAdminToken(Date.now(), adminPassword);
  return res.json({ token, expiresIn: TOKEN_TTL_MS / 1000 });
});

export default router;
