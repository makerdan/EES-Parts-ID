---
name: Shared-DB fixture prefix wipe
description: Parallel Jest suites against a shared Postgres must never blanket-delete by fixture prefix in setup/teardown.
---

Rule: test cleanup helpers must delete only the rows the current worker seeded (tracked set or suite-specific pattern), never `LIKE 'JEST-ITG-%'`-style prefix deletes.

**Why:** api-server suites run in parallel Jest workers against one shared dev DB (and the `test` workflow can run concurrently with `api-server-coverage`). A blanket prefix delete in one suite's beforeAll/afterAll wiped fixtures another suite was mid-way through using, causing flaky "fixture … not found" failures only in full parallel runs.

**How to apply:** seedFixtures tracks catalogs per module instance and cleanupFixtures deletes only those; suites that insert rows directly must clean up with their own suite-specific pattern. Stale leftovers are harmless because seeding uses onConflictDoNothing. Same principle for user rows: seedTestUser derives email from clerkUserId so users_email_unique can't collide across suites.
