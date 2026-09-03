---
name: Completion validation pitfalls
description: Why markTaskComplete validation currently cannot go fully green, and how it scrambles the shared dev DB.
---

**Fact 1 — validation runs EVERY configured workflow, concurrently.** Not just the Project gate (test-fast). The bare `test` workflow (`pnpm test`) has NO serial-lock wrapper, so it overlaps the serial-locked api-server coverage/tier runs against the same shared dev DB. This both flakes vendor suites *and* leaves `vendor_map` physically scrambled afterward (winner rows HOT-updated to earlier offsets), turning the flake into a persistent 3/3 failure until repaired.

**Fact 2 — two checkers are mutually exclusive (as of July 2026).** `scripts/check-gate-integrity.sh` (gate-guard) fails unless the Project gate contains ONLY `test-fast`; `scripts/test-post-merge.sh` Tests 34/35 fail unless the same gate ALSO lists `security-audit` and `canvas-typecheck`. No .replit state satisfies both → completion validation is deterministically red on every task until a dedicated task reconciles the policy (either relax gate-guard's whitelist or drop post-merge Tests 34/35).

**Fact 3 — standard-tier plan-gate checks can fail before project tests.** Historical plans may declare a lighter validation ceiling or contain an invalid command-like value; `plan-gate-check --declared-tier test-standard` then stops the standard tier before typecheck, lint, or tests run.

**How to apply:**
1. When validation fails, check parts you own first; then expect: post-merge 2/9x gate-wiring FAILs (pre-existing, unfixable without policy decision) and vendor-suite failures (repair `vendor_map` per `vendor-map-heap-order-tests.md`: delete+re-insert ABB→BUS→EAT→ETN→TAB→EDN→CHD, verify ctid).
2. After repair + own-package green, use `markTaskComplete` with a narrowly-scoped `skip_validation_reason` citing the checker contradiction (deterministic, config byte-identical to parent commit) and the repaired flake — with `[SELF-CLASSIFIED PRE-EXISTING]` lines per the Failure Gate skill.
3. Do NOT try to "fix" the gate wiring inside an unrelated task — adding the entries breaks gate-guard, removing gate-guard's rule is a policy change.
