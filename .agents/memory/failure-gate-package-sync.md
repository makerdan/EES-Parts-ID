---
name: Failure Gate package synchronization
description: Validation-tier membership changes require refreshing the tracked Failure Gate distribution before validation.
---

Standard validation synchronizes the tracked Failure Gate archive from canonical
sources before running the package contract. Direct publication remains available
for maintainers who need to rebuild it outside validation.

**Why:** The failure-gate contract compares every packaged support file byte-for-byte
with the workspace. A correct source change otherwise fails validation as stale
packaged content.

**How to apply:** Keep distributed sources canonical under `.agents` and the tracked
workspace paths. Let standard validation refresh stale package bytes, or run the
focused publisher directly, then commit the resulting tracked archive.