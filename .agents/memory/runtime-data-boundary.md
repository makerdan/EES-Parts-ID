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