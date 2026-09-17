---
name: Parts ID focused test runner
description: How to run one Parts ID Jest suite without the repository suite-count floor
---

The Parts ID package test wrapper enforces a full-repository suite-count floor, so a single-file invocation through `scripts/run-tests.mjs` exits nonzero even when the selected suite passes. Run the package's Jest binary directly with `--runInBand` for focused confirmation; use `pnpm run test-standard` for the required full-tier validation.

**Why:** Focused debugging otherwise reports a false failure from the wrapper after Jest has already passed the selected tests.

**How to apply:** Distinguish Jest assertion failures from the wrapper's expected suite-count guard failure when selecting one test file.