---
name: PostgreSQL leases
description: Safe coordination rules for work claimed by multiple API instances.
---

Use PostgreSQL time (`now()`) to create, renew, and compare lease expirations; do not rely on API-host clocks for lease ownership decisions. Serialize claims with a short advisory transaction lock, then let the persisted lease protect the long-running work after the transaction commits. Fence terminal writes and renewals by the operation/owner identifier so a worker whose lease was reclaimed cannot overwrite the new owner's state.

**Why:** API instances can have clock skew, and an expired worker may resume after another instance has reclaimed its operation. Client-clock comparisons can reclaim a live job; unfenced writes can let an old worker publish stale completion.

**How to apply:** For background jobs coordinated through a database, keep the claim transaction short, use database time for lease validity, renew long-running work, and make every state transition conditional on the claim identity.