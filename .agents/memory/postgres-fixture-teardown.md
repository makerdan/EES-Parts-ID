---
name: PostgreSQL fixture teardown
description: Ownership and teardown rules for API integration fixtures that may stop during setup.
---

Register a database fixture only after its insert succeeds, and keep each
resource independently retryable when cleanup fails. Teardown should attempt
every owned resource, report failures as warnings, and never replace the
original setup or assertion error.

**Why:** Integration hooks can stop after creating only part of a fixture. A
blanket delete can remove another worker's row, while a single teardown error
can hide the failure that caused the hook to stop.

**How to apply:** Snapshot rows that an upsert will replace, track returned
database IDs for asynchronous inserts, guard every client with `finally`, and
clear timeout handles when a raced database operation settles.

Static ownership checks should treat the shared fixture helper, Jest global
setup, and individual integration suites as separate ownership domains. A
legacy broad sweep may be exempted only by a named path and written rationale;
canonical helper exemptions should require an import from the shared helper.

**Why:** Broad source patterns can mistake comments, exact cleanup, or helper
implementation details for unsafe fixture deletion. Conversely, accepting a
same-named local helper would let a new unowned fixture bypass the guard.

**How to apply:** Keep synthetic negative controls for missing lifecycle,
unqualified predicates, shared-pool shutdown, and local helper lookalikes when
changing the static contract.