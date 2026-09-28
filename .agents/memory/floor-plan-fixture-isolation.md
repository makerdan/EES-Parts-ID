---
name: Floor-plan fixture isolation
description: Shared-database floor-plan integration suites must serialize metadata and cache ownership.
---

Floor-plan integration fixtures that exercise the global latest-metadata route must hold one shared PostgreSQL advisory lock for the entire suite, including setup, requests, and cleanup.

**Why:** Jest project-level worker limits did not prevent these suites from overlapping in the standard run, allowing one suite's metadata hash to pair with another suite's process-local SVG mock.

**How to apply:** Reuse the shared fixture lock for new floor-plan metadata, SVG, or tile-cache integration suites; keep fixture hashes and cache cleanup scoped to each suite.