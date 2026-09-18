---
name: Serial-lock disappearance tests
description: Deterministic black-box testing for a host utility that vanishes between capability detection and acquisition.
---

When a test simulates `flock` disappearing after the capability probe, keep the temporary shim directory as the entire `PATH` and have the shim invoke Node by its absolute executable path to unlink itself. Do not append the host `PATH` after removing the shim.

**Why:** `spawnSync("flock", ...)` resolves the command again for acquisition. If the real host `flock` remains reachable through `PATH`, the test silently exercises the real utility instead of the missing-binary error branch.

**How to apply:** Make the `--help` probe succeed, remove the shim, and leave no fallback `flock` in `PATH`; assert the wrapper's `ENOENT` diagnostic, refusal to use an unsafe fallback, command non-execution, and cleanup.