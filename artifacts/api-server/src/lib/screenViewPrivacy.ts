import crypto from "node:crypto";

import type { EnvironmentSource } from "@workspace/db/runtime-data-boundary";

const ROTATION_WINDOW_MS = 24 * 60 * 60 * 1000;
const DOMAIN_SEPARATOR = "parts-id:support-analytics:screen-view:v1";

export interface ScreenViewPrivacyReadiness {
  privacyKeyMaterialConfigured: boolean;
  productionCorsConfigured: boolean;
  uniqueVisitorReportingAvailable: boolean;
}

/**
 * Express is configured with one trusted reverse-proxy hop. req.ip is
 * therefore the proxy-normalized client address, and is used only transiently
 * as HMAC input. It is never logged or persisted.
 */
export function getScreenViewKeyMaterial(
  env: EnvironmentSource = process.env,
): string | null {
  const candidate = [env["SESSION_SECRET"], env["CLERK_SECRET_KEY"]].find(
    (value) => value?.trim(),
  );
  return candidate?.trim() ? candidate : null;
}

/**
 * Returns deployment-safe readiness information without returning any secret
 * material. Unique-visitor reporting is intentionally unavailable when no
 * server-held key is configured; callers must not invent an unkeyed fallback.
 */
export function getScreenViewPrivacyReadiness(
  env: EnvironmentSource = process.env,
): ScreenViewPrivacyReadiness {
  const privacyKeyMaterialConfigured = getScreenViewKeyMaterial(env) !== null;
  const productionCorsConfigured = Boolean(env["CORS_ALLOWED_ORIGINS"]?.trim());

  return {
    privacyKeyMaterialConfigured,
    productionCorsConfigured,
    uniqueVisitorReportingAvailable: privacyKeyMaterialConfigured,
  };
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