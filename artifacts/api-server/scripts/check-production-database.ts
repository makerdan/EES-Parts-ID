#!/usr/bin/env tsx
/**
 * Production build/deployment preflight.
 *
 * This check intentionally runs through the shared runtime data-boundary
 * contract before the API bundle is produced. It reports only the setting
 * that must be repaired, never the configured target or any credentials.
 */

import { assertProductionDatabaseTarget } from "@workspace/db/runtime-data-boundary";

try {
  assertProductionDatabaseTarget();
  console.log("[production-db-preflight] DATABASE_ENV=production confirmed.");
} catch {
  console.error(
    "[production-db-preflight] ERROR: production build requires DATABASE_ENV=production. " +
      "Set the deployment database target and retry.",
  );
  process.exit(1);
}