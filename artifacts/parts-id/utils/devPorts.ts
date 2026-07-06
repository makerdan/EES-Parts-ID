/**
 * Dev-only fallback port constants for the mobile app (Metro-compatible).
 *
 * Canonical source of truth: scripts/dev-ports.json at the workspace root.
 * Keep these values in sync when updating port assignments.
 *
 * These fallbacks only activate in native development when neither
 * EXPO_PUBLIC_API_BASE nor EXPO_PUBLIC_DOMAIN is set. In Replit (and in
 * production), the platform always provides the real PORT/domain via env vars,
 * so these values are never used in deployed builds.
 */

export const NATIVE_API_DEV_PORT = 8080;
