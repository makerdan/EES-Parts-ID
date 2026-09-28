---
name: Serial-lock resource environment inheritance
description: Nested wrappers for different resources must not reuse a parent lock-file path.
---

When a serial-lock wrapper is nested for a different resource, derive that
resource's lock path instead of inheriting the parent's `SERIAL_LOCK_FILE`.

**Why:** The inherited path makes the child contend with the ancestor's lock
while reporting a different resource, so release verification can wait
indefinitely inside an otherwise passing validation tier.

**How to apply:** Keep reentrancy resource-aware and test nested wrappers
under the outer validation lock, including the release-specific lock.