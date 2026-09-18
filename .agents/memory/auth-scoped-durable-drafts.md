---
name: Auth-scoped durable drafts
description: Lifecycle rules for user-owned encrypted drafts that survive app restarts.
---

Durable draft writes must stay blocked until loading has settled for the exact current user. Clear in-memory draft state immediately when identity changes, and serialize every save, load, and deletion per user so logout or successful completion is the final operation.

**Why:** A boolean readiness flag can remain true across Clerk hydration or account switching, causing empty state to delete a restored draft or prior-user state to be saved under a new user's key. An uncoordinated pending save can also recreate a draft after logout.

**How to apply:** Use user-ID-scoped readiness and separate load generations in UI state. Route all storage operations for one user through one queue. On web, keep non-extractable encryption keys outside the ciphertext storage boundary.