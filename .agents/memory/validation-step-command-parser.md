---
name: Validation step command parser
description: Validation host-tool discovery treats tokens after a literal -- as executable starts.
---

Validation commands that need a focused Jest selector should invoke the package's Jest binary directly and use an equals-form flag, such as `exec jest --runTestsByPath=...`; forwarding a selector through `pnpm run ... --` makes the host-tool parser misclassify the flag, while package wrappers may strip it and run the full suite.

**Why:** The validation host-tool contract scans shell command boundaries and does not understand every nested package-script argument. A malformed registration can either fail before validation or silently lose the intended focus.

**How to apply:** When adding a focused test to `scripts/validation-steps.mjs`, verify both `assertValidationHostToolContract()` and the actual registered command's test count.