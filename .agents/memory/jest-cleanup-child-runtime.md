---
name: Jest cleanup child runtime
description: Standalone cleanup children must declare runtime and database mode before loading the guarded DB package.
---

When a Jest wrapper spawns a database cleanup child outside a Jest worker, set
`NODE_ENV` and (for the test database) a worker marker consistently with
`DATABASE_ENV` before importing the DB package. The DB application guard infers
the expected target from those process markers.

**Why:** A child without Jest markers is treated as a development application;
that can reject test-database cleanup before the utility's own environment
protection runs.

**How to apply:** Any standalone `tsx` or Node child that imports `@workspace/db`
must explicitly establish the intended non-production runtime first.