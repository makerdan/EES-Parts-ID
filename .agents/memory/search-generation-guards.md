---
name: Search generation guards
description: Overlapping Search-screen requests must guard every visible and durable publication by request generation.
---

Use a monotonically increasing request generation for every submitted search, including identical queries and offline fallback paths. A callback may publish visible results, dimension counts, AI state, or durable query/Fuse cache data only when its generation is still current; a timeout must invalidate only its own generation so a later request cannot be blocked.

**Why:** Search callbacks and cache writes complete independently, so matching query text or relying on mutation state cannot prevent an older response from overwriting a newer search.

**How to apply:** Carry the request token through standard, similar-size, category, and pending-navigation searches, and check it again after every awaited cache or network operation.