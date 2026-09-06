---
name: Runtime data boundary
description: Explicit database execution modes and delayed server imports protect Replit runtime data from tests and client bundles.
---

The API and database tooling require an explicit `DATABASE_ENV`: application
startup must match its runtime (`development`, `test`, or `production`), Jest
must use `test`, and seed/schema commands must reject `production`.

**Why:** Replit supplies the PostgreSQL URL and secrets at runtime, while
development tooling and Expo builds run in the same workspace. An implicit
database target can mutate production data, and static database imports can
hide the actionable missing-secret error behind pool initialization.

**How to apply:** Keep the boundary contract side-effect free and import it
before the database package. Put database-affecting package commands behind an
explicit non-production guard, and keep client build inputs to an allowlist of
`EXPO_PUBLIC_*` values.

Validation runners do not necessarily supply the database mode to nested
package test commands; the task's validation environment must preserve the
explicit `test` mode or the API suite will be refused before Jest starts.

**Why:** The database-command guard correctly rejects an omitted mode, but that
failure can look like a broken global setup when it is only missing inherited
test configuration.

**How to apply:** When a task validation reaches database-backed tests, verify
the runner inherits the explicit test mode before diagnosing suite failures.