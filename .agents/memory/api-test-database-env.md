---
name: API test database mode
description: Direct API-server test runs require an explicit test database mode before the suite can start.
---

The API-server package test scripts default an unset `DATABASE_ENV` to `test` before invoking the database command wrapper; direct uses of the wrapper still require an explicit non-production mode.

**Why:** The database command wrapper intentionally rejects ambiguous or production environment selection to prevent tests from accidentally targeting development or production data. The package-owned default makes the supported test entrypoint usable from the canonical validation runner without weakening that wrapper.

**How to apply:** Prefer `pnpm --filter @workspace/api-server run test` for API validation; it uses the isolated test mode by default, preserves an explicit `DATABASE_ENV=production` refusal, and lets Jest global setup preflight and synchronize the test schema before suites load.