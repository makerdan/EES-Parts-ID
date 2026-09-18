---
name: Jest globalSetup drizzle push under validation load
description: drizzle-kit push in api-server jest.globalSetup can exceed short timeouts under concurrent post-merge validation load even with a reachable DB.
---

Rule: give the drizzle-kit push step in Jest globalSetup a generous timeout (120s), not 30s.

**Why:** After a task merge, ~20 validation commands run concurrently; drizzle-kit push was observed to exceed 30s while `SELECT 1` succeeded, failing the coverage gate spuriously.

**How to apply:** If a coverage/test gate fails with "drizzle-kit push exceeded Ns" but the DB preflight passed, it is load contention, not connectivity — raise the timeout rather than debugging DATABASE_URL.

Related: the `post-merge-health-test` self-test case "db push run — exits 0 when schema changed" has also been seen failing only under concurrent validation load and passing on an isolated re-run. If it is the sole failure in a validation batch, re-run the workflow in isolation before treating it as real.
