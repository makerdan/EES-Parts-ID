# Implementation Plan: Restore backup API route bindings

## Source Spec
- Spec file: `docs/superpowers/specs/2026-09-24-backup-api-route-bindings-design.md`
- Approved by user: 2026-09-24

## Dependencies
- Existing Express admin snapshot router, Jest/Supertest API test harness, and manual inventory backup service.
- No new packages, services, environment variables, or migrations.

## Tasks

### T001: Restore request and service bindings
- **Blocked by**: []
- **Files**: `artifacts/api-server/src/routes/adminSnapshots.ts`
- **Details**: Restore request-body snapshot selection, bounded dry-run expiry creation, and read-only status service use. Do not change backup persistence, lease, restore, or response contracts.
- **Done when**: API-server source typechecking reports no undefined names and the status endpoint does not start a backup.

### T002: Regression hardening — route semantics
- **Blocked by**: [T001]
- **Files**: `artifacts/api-server/src/__tests__/adminSnapshots.route.integration.test.ts`
- **Details**: Assert dry-run selects the request snapshot and returns a future confirmation expiry; assert GET status calls the status reader and never starts a backup.
- **Done when**: The focused route test passes and fails when any of the three damaged expressions is restored to its broken form.

### T003: Validate the repair
- **Blocked by**: [T002]
- **Files**: []
- **Details**: Run API-server typecheck, the focused route test, and the registered fast tier.
- **Done when**: All three checks exit successfully, or any unrelated failure is classified under Failure Gate with evidence.

## Pre-existing failures to ignore
None known at plan time. Treat every failure as a potential regression.

**Flaky-test rule:** A passing retry establishes intermittency, not pre-existing provenance. Use the execution evidence rules before assigning ownership.

## Validation
**Command:** `test-fast`
**Why:** The reported regression blocks the fast tier's workspace typecheck, and the focused backend test covers route semantics.
**Do not escalate:** Run exactly this command. Pre-existing failures are not a reason to run a heavier tier.

## Regression Guard
**Covers:** Admin snapshot dry-run request binding and expiry creation, plus read-only backup status retrieval.
**Test location:** artifacts/api-server/src/__tests__/adminSnapshots.route.integration.test.ts
**What it checks:** The requested snapshot is selected, confirmation expiry is future-bounded, and GET status reads current state without starting a backup.