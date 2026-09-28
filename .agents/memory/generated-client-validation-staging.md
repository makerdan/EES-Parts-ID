---
name: Generated-client validation staging
description: Why intentional OpenAPI-generated changes must be staged before the codegen verification gate
---

When changing the OpenAPI spec, stage the intentional generated client/Zod outputs before running the registered validation tier.

**Why:** The codegen check regenerates outputs and then uses `git diff --exit-code` on those directories. It interprets even correct but unstaged changes as drift from the generated baseline. Staging the generated outputs leaves the check free to detect fresh unstaged differences after regeneration.

**How to apply:** Regenerate, inspect the generated diff, stage only intentional generated files, and then run the task's locked validation tier. Do not stage a regenerated file that has unexpected differences just to silence the gate.