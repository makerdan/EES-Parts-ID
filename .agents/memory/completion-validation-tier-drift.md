---
name: Completion validation tier drift
description: Completion callbacks may execute broader validation tiers than the assigned task plan declares.
---

The completion callback can launch all registered validation tiers even when the task plan explicitly requires one lighter tier. A standard run can also stop before project checks when a tracked validation-evidence report contains a stale repository revision. If the declared checks are otherwise covered, preserve task scope and report the unrelated failure with an audited validation-skip reason rather than changing unrelated infrastructure.

A concurrently changed registered workflow can also fail a static port/workflow contract before any task tests run. Confirm the selected tier's failure boundary from its log; do not interpret a callback's other tier failures as evidence about the changed feature.

**Why:** A provider-contract task passed its declared fast validation, while automatic completion also ran standard and heavy suites that failed in an unrelated parts-id test process. A later frontend task reached the same boundary because the parity report revision lagged behind the tracked `HEAD`.

**How to apply:** Compare the callback logs with the task plan, confirm the declared command passed, identify the unrelated failing suite and unchanged files, and include the exact scope mismatch and failure evidence when completing.

Broad completion fan-out can reproduce the same unrelated lock-owner test failure in every heavier tier while the declared fast tier passes. Do not treat the repeated heavier-tier failures as evidence that the scoped change broke its gate.

**Why:** Running all registered tiers after a passing fast check added concurrent validation load and repeatedly failed an untouched code-generation lock test.

**How to apply:** Preserve the single-tier plan evidence and cite the heavier-tier failure precisely when requesting an audited completion exception; do not modify unrelated code-generation ownership to make a history-check task pass.

A separate one-command validation run does not constrain a later completion callback: the callback may still launch every registered tier.

**Why:** A task whose plan selected standard-plus received an automatic four-tier fan-out. Its separately selected one-tier run reached only a plan-listed baseline failure, while the other tiers were explicitly disallowed by the user.

**How to apply:** If a user restricts validation tiers, do not retry plain completion after observing broad fan-out. Supply the scoped run's evidence in an audited completion exception when the task plan permits the known failure; otherwise report the blocker rather than silently running extra tiers.

If the declared tier itself times out during broad completion fan-out, let the queued runs finish and retry only that declared tier once before requesting an audited skip. Record the exact untouched step and timeout; do not launch further tiers.

**Why:** A standard-only report task was automatically fanned out to every tier. Its first standard run timed out in an unrelated route check; a standalone retry timed out at a different unrelated environment check, while higher-tier API codegen tests failed.

**How to apply:** Use one isolated rerun to distinguish queue pressure from a persistent environment timeout. If it still cannot complete, preserve the scoped checks and request an audited completion exception rather than retrying the entire fan-out.

A plan-scoped standard run can also pass typecheck and lint, then fail in an untouched API-spec stale-lock ownership test. If the failure repeats in three isolated runs and matches the documented codegen lock behavior, keep it as a narrowly evidenced external blocker rather than broadening the task.

**Why:** A Parts ID network-recovery change passed its focused tests and standard typecheck/lint, but the suite stopped at an independent stale-owner lock assertion.

**How to apply:** Record the exact failing test, isolated retry count, untouched test path, and passing scoped checks in any audited completion exception; do not repair unrelated lock logic as part of the feature task.

A registered validation run can be forcibly stopped when the validation service exhausts its polling budget, even while its tier is still progressing normally. The service's roughly ten-minute observation window can be shorter than a normal standard-tier run; increasing the command's post-lock budget does not extend that window. A stopped run is not completion evidence.

**Why:** A queued standard-plus run spent much of the service's polling window waiting for the validation lock, then was stopped during a long repository check before it reached the task's tests.

**How to apply:** Inspect the terminal status and log before attributing a failure. If the service cannot accommodate the tier's normal runtime, run the same plan-selected tier through the repository's task-locked runner under its validation lock, retain the terminal output, and explain the transport limitation in any audited completion exception. Do not retry an automatic broad tier fan-out or claim that direct execution made the stopped service run pass.
