---
name: Failure Gate package synchronization
description: Validation-tier membership changes require refreshing the tracked Failure Gate distribution before validation.
---

When a validation tier or its executable step list changes, regenerate the tracked
Failure Gate archive with its canonical publisher before running the tier.

**Why:** The failure-gate contract compares every packaged support file byte-for-byte
with the workspace. A correct source change otherwise fails validation as stale
packaged content.

**How to apply:** After changing `scripts/validation-steps.mjs` or another listed
distribution file, run the publisher, verify the archive, then run the task's
declared validation tier.