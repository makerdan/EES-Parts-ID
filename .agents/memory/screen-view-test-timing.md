---
name: Screen-view test timing
description: Screen-view telemetry integration coverage can fail only under concurrent standard-tier database load.
---

Screen-view telemetry tests that wait for fire-and-forget inserts may pass repeatedly in isolation yet intermittently observe no row during the concurrent standard validation run.

**Why:** The endpoint schedules its database insert after returning, and shared-database workloads can delay that work beyond the test's polling window even when the route returns 204.

**How to apply:** When standard validation reports this suite, retry the named test in isolation three times before assigning regression ownership; treat isolated passes with an untouched test file as pre-existing flakiness for unrelated tasks.