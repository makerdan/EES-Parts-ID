#!/usr/bin/env tsx
/**
 * Reports the production deployment inputs that affect visitor-privacy
 * reporting. Secret values are never printed.
 *
 * In local validation this is a contract smoke check and exits successfully.
 * In a production deployment, missing CORS configuration is fatal because
 * browser clients cannot safely reach the API. Missing privacy key material is
 * a warning: unique-visitor reporting remains disabled rather than falling
 * back to an unkeyed identifier.
 */

const hasValue = (value: string | undefined): boolean => Boolean(value?.trim());
const isProductionDeployment =
  process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT === "1";
const privacyKeyMaterialConfigured =
  hasValue(process.env.SESSION_SECRET) || hasValue(process.env.CLERK_SECRET_KEY);
const productionCorsConfigured = hasValue(process.env.CORS_ALLOWED_ORIGINS);

console.log(
  `[privacy-check] privacy key material: ${
    privacyKeyMaterialConfigured ? "present" : "missing (unique visitors disabled)"
  }`,
);
console.log(
  `[privacy-check] production CORS configuration: ${
    productionCorsConfigured ? "present" : "missing (browser cross-origin requests denied)"
  }`,
);
console.log(
  "[privacy-check] reporting contract: bounded 30-day UTC aggregate counts; " +
    "cells below 5 events are suppressed; raw telemetry is not exported.",
);

if (!isProductionDeployment) {
  console.log("[privacy-check] local validation mode — production-only failures are not enforced.");
  process.exit(0);
}

if (!productionCorsConfigured) {
  console.error(
    "[privacy-check] ERROR: set CORS_ALLOWED_ORIGINS in the production deployment and redeploy.",
  );
  process.exit(1);
}

if (!privacyKeyMaterialConfigured) {
  console.warn(
    "[privacy-check] WARNING: configure SESSION_SECRET or CLERK_SECRET_KEY to enable unique-visitor reporting; no unsafe fallback is used.",
  );
}

process.exit(0);