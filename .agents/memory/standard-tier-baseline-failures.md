---
name: Standard-tier baseline failures
description: How to classify full standard validation failures that fall outside an assigned task's files.
---

When a scoped task passes its focused checks but `test-standard` fails in unrelated application suites or repository-wide lint bookkeeping, preserve the task boundary and use focused reruns to establish provenance before changing code outside scope. The root lint phase can currently stop on an unrelated `tsc` unlisted-binary finding.

**Why:** The standard tier runs multiple packages and can expose deterministic baseline failures or shared-environment integration failures that are unrelated to validation changes. Treating those as task-owned causes unnecessary scope expansion and can hide the actual follow-up work.

**How to apply:** Identify the failing suite and first error from the standard log, rerun the relevant suite in isolation with its required environment wrapper, and document any remaining out-of-scope failure in completion evidence. Do not fold the separate root lint repair into a scoped feature task.