---
name: Dictionary deadline cleanup
description: The interaction between PostgreSQL statement cancellation, transaction rollback, and an outer dictionary-loader deadline.
---

When a database-backed dictionary load has both a PostgreSQL statement timeout and
an outer promise deadline, the outer deadline must not win before the transaction
has rolled back and released its client.

**Why:** A lock-blocked dictionary read can remain in flight after the outer
deadline rejects, so concurrent retries may observe pool pressure even though the
request has already returned a failure.

**How to apply:** Timeout and cancellation tests should verify cleanup completion
and a later operation's recovery, not only the returned HTTP 500.