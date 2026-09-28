---
name: Startup probe cancellation
description: Promise deadlines do not cancel node-postgres work; bounded startup probes must own client cleanup and session timeout restoration.
---

An outer `Promise.race` only stops awaiting a PostgreSQL probe; it does not stop the query or free a pooled client. Startup probes must set a server-side statement timeout, destroy a client still running when the outer deadline fires, release late-acquired clients, and restore the session timeout before a healthy client returns to the pool. Retry budgets should be checked as `attempts × probe window + (attempts - 1) × retry delay` against the startup deadline.

**Why:** A timed-out database promise can otherwise leave a busy client in the pool and allow a late result to interfere with readiness or later operations.

**How to apply:** Use a dedicated pool client for required startup probes; test both timeout cleanup/recovery and controlled-clock attempt limits.