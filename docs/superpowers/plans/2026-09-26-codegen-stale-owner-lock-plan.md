# Implementation Plan: Codegen stale-owner lock test

## Source Spec
- Spec file: `docs/superpowers/specs/2026-09-26-codegen-stale-owner-lock-design.md`
- Approved by user: 2026-09-26

## Dependencies
- Existing Node.js, Jest, and `flock` tooling only; no services, packages, secrets, or migrations.

## Steps
1. Reproduce the stale-owner failure in isolation before editing.
2. Replace the test's elapsed-time ordering with owner/successor readiness and release markers.
3. Assert the reclaimed owner stops, while the successor's distinct lock survives until its own successful release.
4. Verify the focused API-spec test and assigned `test-fast` validation without widening the production tier budget.

## Pre-existing failures to ignore
The broader platform completion run timed out during the standard-tier browser-bundle step under validation load. It is unrelated to this test and does not authorize changing the standard-tier budget.

The stale-owner test's repeated isolated failure is the defect this plan owns, not one to ignore.

**Flaky-test rule:** If another test fails, retry it 3× in isolation before concluding it is a regression caused here. Only treat a consistent 3/3 failure as this work's responsibility.

## Validation
**Command:** `test-fast`
**Why:** The assigned task's fast tier covers its canonical setup fixture; direct focused API-spec Jest runs verify the additional lock-test repair without changing the task's tier.
**Do not escalate:** Run exactly this command. Pre-existing failures are never a reason to run a heavier tier.

## Regression Guard
**Covers:** A reclaimed codegen lock owner must not remove the successor's tokenized lock when the old wrapper exits.
**Test location:** `lib/api-spec/src/__tests__/ensure-codegen.test.ts`
**What it checks:** The old owner loses ownership, the successor holds a different token and an intact lock until signaled to finish, and only the successor's successful exit removes that lock.

## Tasks

### T001: Confirm the failure
- **Blocked by**: []
- **Files**: `lib/api-spec/src/__tests__/ensure-codegen.test.ts`
- **Details**: Run only the stale-owner test three times, inspect the first owner's exit status, and distinguish the expected loss-of-ownership exit from a production locking defect.
- **Done when**: The failing assertion and production ownership behavior are evidenced without changing production code.

### T002: Synchronize the lock fixture
- **Blocked by**: [T001]
- **Files**: `lib/api-spec/src/__tests__/ensure-codegen.test.ts`
- **Details**: Make workers wait for test-controlled markers rather than relying on 300/250 ms completion timers. Use bounded readiness waits and ensure cleanup releases both workers after failures.
- **Done when**: The test can observe the successor holding the replacement lock after the old owner has exited.

### T003: Regression hardening — reject stale-owner deletion of successor lock
- **Blocked by**: [T002]
- **Files**: `lib/api-spec/src/__tests__/ensure-codegen.test.ts`
- **Details**: Assert a distinct successor token remains present after the first wrapper exits unsuccessfully, then assert successful successor release removes the lock.
- **Done when**: The focused test passes repeatedly and fails if the successor lock disappears too early.

### T004: Verify the assigned task
- **Blocked by**: [T003]
- **Files**: `scripts/test/validation-runtime-contract.test.mjs`
- **Details**: Run the API-spec test file, check the canonical setup fixture assertion remains present, and use only the assigned `test-fast` completion tier.
- **Done when**: Focused tests and the single task-plan validation tier pass.