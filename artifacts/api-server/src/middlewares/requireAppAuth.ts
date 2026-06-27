import { type Request, type Response, type NextFunction } from "express";
import { verifyAdminToken, getRevokedBefore } from "../routes/admin";
import { verifyAppToken } from "../routes/auth";

// Paths relative to /api that do not require any authentication token.
const PUBLIC_PATHS = new Set(["/healthz", "/auth/app-login"]);

/**
 * Middleware that validates either an app-session token or an admin token on
 * all /api/* routes except the public whitelist above. Returns 401 when no
 * valid token is present so unauthenticated callers cannot access any data.
 */
export function requireAppAuth(req: Request, res: Response, next: NextFunction): void {
  if (PUBLIC_PATHS.has(req.path)) {
    next();
    return;
  }

  const auth = req.headers["authorization"] ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const adminSecret = process.env.ADMIN_PASSWORD;
  const appSecret = process.env.APP_PASSWORD;

  const isValidAdmin = adminSecret
    ? verifyAdminToken(token, adminSecret, getRevokedBefore())
    : false;
  const isValidApp = appSecret ? verifyAppToken(token, appSecret) : false;

  if (!isValidAdmin && !isValidApp) {
    res.status(401).json({ error: "Invalid or expired session. Please log in again." });
    return;
  }

  next();
}
