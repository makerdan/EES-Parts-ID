---
name: Replit config validation drift
description: How unrelated .replit port changes can block standard validation before project checks.
---

An uncommitted `.replit` port-table change can make `test-standard` fail in the configuration contract before typecheck, lint, or project tests run. Preserve the working-tree configuration and report the boundary failure separately from task-owned checks.

**Why:** The contract asserts the checked-in structural port count, while environment setup can add service ports without changing the application code under test.

**How to apply:** Check `git diff -- .replit` before changing config. Do not revert or normalize another task’s port mapping; run focused package checks and record the exact standard-tier blocker.