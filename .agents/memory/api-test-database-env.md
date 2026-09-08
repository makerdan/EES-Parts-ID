---
name: API test database mode
description: Direct API-server test runs require an explicit test database mode before the suite can start.
---

The API-server test command refuses to run when `DATABASE_ENV` is unset; invoke it with `DATABASE_ENV=test` for isolated validation.

**Why:** The database command wrapper intentionally rejects ambiguous environment selection to prevent tests from accidentally targeting development or production data.

**How to apply:** When isolating API-server failures from a validation tier, set `DATABASE_ENV=test` explicitly and classify the resulting suite failures separately from the app package under change.