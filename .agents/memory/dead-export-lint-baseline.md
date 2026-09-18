---
name: Dead-export lint baseline
description: The repository-wide lint baseline currently fails on an unlisted tsc binary.
---

The root `lint:libs` check currently reports `Unlisted binaries (1) tsc package.json`
and exits nonzero even on a clean `main` checkout.

**Why:** This is a repository baseline failure, not a package or source regression;
task validation can reach the dead-export check after all preceding checks pass.

**How to apply:** When a task's validation stops at this message, confirm the
working tree is clean and classify it as pre-existing rather than changing
unrelated package metadata.