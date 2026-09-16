#!/usr/bin/env tsx
/**
 * Production build/deployment database-target assertion.
 *
 * This check intentionally runs through the shared runtime data-boundary
 * contract before the API bundle is produced. It confirms only the explicit
 * DATABASE_ENV target; it does not check DATABASE_URL or database
 * connectivity. It reports only the setting that must be repaired, never the
 * configured target or any credentials.
 */

import { assertProductionDatabaseTarget } from "@workspace/db/runtime-data-boundary";

try {
  assertProductionDatabaseTarget();
  console.log(
    "[production-db-target] DATABASE_ENV=production target confirmed; " +
      "DATABASE_URL and database connectivity were not checked.",
  );
} catch {
  console.error(
    "[production-db-target] ERROR: production build requires " +
      "DATABASE_ENV=production for target safety. " +
      "Set the deployment database target and retry. " +
      "This check does not test DATABASE_URL or database connectivity.",
  );
  process.exit(1);
}