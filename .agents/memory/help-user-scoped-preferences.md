---
name: Help user-scoped preferences
description: Help orientation dismissal must be isolated per authenticated account and guarded against stale async reads.
---

Help orientation preferences are account-scoped, while privileged Help content remains uncached and server-authorized.

**Why:** A device-wide dismissal key lets one account's first-run choice carry into another account, and an earlier asynchronous read can otherwise overwrite the current user's state after an account switch.

**How to apply:** Include the authenticated user ID in Help preference storage keys, reset local orientation state on account changes, and ignore preference reads from older load generations.