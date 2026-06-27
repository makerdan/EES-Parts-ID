import { Router } from "express";
import crypto from "node:crypto";

const router = Router();

export const APP_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Sign a timestamp with APP_PASSWORD using HMAC-SHA256.
 * Token payload is "app.<timestamp>" to distinguish from admin tokens.
 * Returns a base64url-encoded string: base64url("app.<ts>.<hex-sig>")
 */
export function signAppToken(ts: number, secret: string): string {
  const payload = `app.${ts}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return Buffer.from(`${payload}.${sig}`).toString("base64url");
}

/**
 * Verify a signed app token.
 * Returns true if the signature is valid and the token has not expired.
 */
export function verifyAppToken(token: string, secret: string): boolean {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    if (!decoded.startsWith("app.")) return false;

    const rest = decoded.slice(4); // "<ts>.<hex-sig>"
    const dotIdx = rest.indexOf(".");
    if (dotIdx === -1) return false;

    const tsPart = rest.slice(0, dotIdx);
    const sig = rest.slice(dotIdx + 1);
    const payload = `app.${tsPart}`;

    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");

    const sigBuf = Buffer.from(sig, "hex");
    const expectedBuf = Buffer.from(expectedSig, "hex");
    if (sigBuf.length !== expectedBuf.length) return false;
    if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return false;

    const ts = parseInt(tsPart, 10);
    if (isNaN(ts)) return false;
    return Date.now() - ts < APP_TOKEN_TTL_MS;
  } catch {
    return false;
  }
}

// ── POST /auth/app-login ──────────────────────────────────────────────────────
// Public route — validates the warehouse access password server-side and
// returns a short-lived signed token. The client stores this token and sends
// it with every subsequent request so the password never leaves the server.
router.post("/app-login", (req, res) => {
  const appPassword = process.env.APP_PASSWORD;
  if (!appPassword) {
    return res.status(503).json({
      error: "App password not configured on this server. Set APP_PASSWORD.",
    });
  }

  const { password } = req.body as { password?: string };

  if (!password || password !== appPassword) {
    return res.status(401).json({ error: "Incorrect password" });
  }

  const token = signAppToken(Date.now(), appPassword);
  return res.json({ token, expiresIn: APP_TOKEN_TTL_MS / 1000 });
});

export default router;
