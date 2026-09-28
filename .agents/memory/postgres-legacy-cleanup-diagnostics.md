---
name: PostgreSQL legacy cleanup diagnostics
description: Safe removal of obsolete test-only tables while preserving dependent PostgreSQL objects.
---

Legacy-table cleanup must inspect user triggers and non-internal `pg_depend` entries, then use `DROP TABLE` without `CASCADE`. A dependency race reported by PostgreSQL (`2BP01`) is a retained-table outcome, not a reason to force removal. Report only bounded status and counts (`absent`, `removed`, or `retained`) so cleanup logs do not expose database object names.

**Why:** Reused test databases can contain retired support tables, but views, triggers, and other real PostgreSQL objects may still depend on them. A filtered pre-check alone is vulnerable to dependencies appearing between inspection and removal.

**How to apply:** Keep this cleanup behind an explicit test-database guard, preserve dependent objects, and add an isolated real-PostgreSQL fixture whenever the dependency boundary changes.