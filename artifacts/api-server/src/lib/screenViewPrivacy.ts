import crypto from "node:crypto";

const ROTATION_WINDOW_MS = 24 * 60 * 60 * 1000;
const DOMAIN_SEPARATOR = "parts-id:support-analytics:screen-view:v1";

/**
 * Express is configured with one trusted reverse-proxy hop. req.ip is
 * therefore the proxy-normalized client address, and is used only transiently
 * as HMAC input. It is never logged or persisted.
 */
export function getScreenViewKeyMaterial(): string | null {
  const candidate = process.env["SESSION_SECRET"] ?? process.env["CLERK_SECRET_KEY"];
  return candidate?.trim() ? candidate : null;
}

function getRotationBucket(now = Date.now()): number {
  return Math.floor(now / ROTATION_WINDOW_MS);
}

export function deriveRotatingVisitorHash(
  ip: string | undefined,
  now = Date.now(),
): string | null {
  const keyMaterial = getScreenViewKeyMaterial();
  const normalizedIp = ip?.trim();
  if (!keyMaterial || !normalizedIp || normalizedIp === "unknown") return null;

  return crypto
    .createHmac("sha256", keyMaterial)
    .update(`${DOMAIN_SEPARATOR}:${getRotationBucket(now)}:${normalizedIp}`, "utf8")
    .digest("hex");
}

/**
 * Rate limiting must not put a raw address in the database either. When
 * unique grouping is unavailable, use one deliberately conservative bucket
 * rather than weakening privacy with an unkeyed fallback.
 */
export function getScreenViewRateLimitKey(ip: string | undefined, now = Date.now()): string {
  return deriveRotatingVisitorHash(ip, now) ?? "privacy-disabled";
}