# Implementation Plan: Manual Database Backup

## Source Spec

- Spec file: `docs/superpowers/specs/2026-09-19-manual-database-backup-design.md`
- Approved by user: 2026-09-19

## Pre-plan Checklist

- [x] The approved source spec exists and contains no TODO, TBD, or placeholder sections.
- [x] The feature is one coherent administrator backup flow spanning server, API contract, and mobile UI.
- [x] Dependencies and task ordering are explicit and contain no cycles.
- [x] Regression hardening covers authorization, asynchronous lifecycle, duplicate suppression, status reporting, and the confirmation-first UI.

## Dependencies

- Existing Clerk approved-administrator middleware.
- Existing production database runtime boundary.
- Existing private App Storage configuration: `DEFAULT_OBJECT_STORAGE_BUCKET_ID` and `PRIVATE_OBJECT_DIR`.
- Existing inventory snapshot, verification, advisory-lock, health, and retention services.
- Existing OpenAPI-to-Zod and React Query client generation.
- Existing Expo Admin tab and React Native confirmation/accessibility patterns.
- No new package, migration, integration, secret, or environment variable is required.

## Tasks

### T001: Extract the reusable manual backup operation

- **Blocked by**: []
- **Files**: `artifacts/api-server/src/scripts/inventory-backup.ts`, `artifacts/api-server/src/lib/inventorySnapshot.ts`, `artifacts/api-server/src/lib/inventorySnapshotRetention.ts`, `artifacts/api-server/src/lib/inventorySnapshotTypes.ts`
- **Details**: Create one shared server operation that performs a full verified inventory snapshot followed by retention pruning. Preserve production-target assertions, private storage checks, anomaly detection, advisory locking, and the scheduler script’s existing behavior. Add a manual-administrator snapshot reason without changing the snapshot storage format.
- **Done when**: The CLI script and the future admin route can invoke the same snapshot-plus-retention operation; a manual invocation produces a self-contained verified snapshot identified as manual, while the existing scheduled invocation remains behaviorally unchanged until its workflow is retired.

### T002: Add the asynchronous protected backup API

- **Blocked by**: [T001]
- **Files**: `artifacts/api-server/src/routes/adminSnapshots.ts`, `artifacts/api-server/src/index.ts`, `lib/api-spec/openapi.yaml`, `lib/api-zod/src/generated`, `lib/api-client-react/src/generated`
- **Details**: Change the protected manual snapshot route into an asynchronous start operation that returns `202 Accepted` before snapshot work settles. Add a protected status query, keep one active manual operation per API process, return the active operation for duplicate starts, record the initiating administrator, and expose only safe status metadata. Regenerate the shared API clients from the OpenAPI contract.
- **Done when**: An approved administrator can start a backup and receive an accepted/running response immediately; the operation continues independently of the request; duplicate starts share the active operation; the status query reports running, completed, or failed with initiation/completion timestamps, row count, and snapshot identifier but no private paths or configuration.

### T003: Regression hardening — protect backup authorization and lifecycle

- **Blocked by**: [T002]
- **Files**: `artifacts/api-server/__tests__/adminSnapshots.integration.test.ts`, `artifacts/api-server/src/__tests__/inventorySnapshot.test.ts`
- **Details**: Add deterministic server coverage proving non-admins cannot start or inspect backups, `202` is sent before the deferred snapshot settles, work completes after the request lifecycle ends, concurrent starts do not duplicate work, success and failure status are safe and retryable, and the shared operation uses the manual reason plus retention.
- **Done when**: The focused server tests fail if authorization is removed, the request awaits full backup completion, duplicate work can start, private paths leak, status lies about failure, or retention/manual-reason behavior is lost.

### T004: Add the confirmation-first Admin backup control

- **Blocked by**: [T002]
- **Files**: `artifacts/parts-id/app/(tabs)/upload.tsx`, `artifacts/parts-id/__tests__/adminDatabaseBackup.test.tsx`
- **Details**: Add a Database Backup card under Admin → People & System using the generated API client. Require confirmation, disable repeated submission while the start request is pending or the server reports active work, poll while the screen is visible, and reload status when the administrator returns. Announce accepted, completed, and failed states accessibly. Format completed timestamps with the full local date and time and show the backed-up row count.
- **Done when**: An approved administrator can confirm and start a backup, safely switch apps or navigate away, return to current/latest status, see a readable completion date/time and row count, and retry a failed operation; cancelling starts nothing.

### T005: Retire the obsolete scheduler proposal

- **Blocked by**: [T003, T004]
- **Files**: `.github/workflows/ci.yml`, `docs/validation/github-actions-coverage.md`
- **Details**: Re-read PR #10 and its branch before any remote write. Confirm it still contains only the scheduler proposal, close it without merging, and leave the production workflow untriggered. Verify no scheduler workflow was added to the default branch and the manual backup implementation is the only accepted replacement.
- **Done when**: GitHub reports PR #10 closed and unmerged, the default branch does not contain the daily inventory-backup workflow, and no production backup workflow was manually dispatched.

## Pre-existing failures to ignore

- **Parts ID `catalogPdfUploadBeforeUnload.test.tsx` full-suite interaction** — GitHub portable validation repeatedly failed the “removes the beforeunload handler when loading becomes false after upload completes” assertion while the exact test passed three consecutive isolated retries against the same revision. Treat a recurrence as intermittent unless the new backup UI directly changes that component or its lifecycle dependencies.

**Flaky-test rule:** If another test fails, retry it 3× in isolation before concluding it is a regression caused by this work. A passing retry establishes intermittency, not ownership.

## Validation

**Command:** `test-standard`
**Why:** This cross-layer change modifies an approved-admin API contract, asynchronous server lifecycle, generated clients, and an existing Expo Admin flow; the standard tier covers the relevant server and mobile suites without escalating to the heavier release tiers.
**Do not escalate:** Run exactly this command. Pre-existing failures are handled above and are never a reason to run a heavier tier.

## Regression Guard

**Covers:** Approved-admin authorization, immediate asynchronous acceptance, app-independent server execution, duplicate suppression, safe status metadata, full-date completion display, and confirmation-first submission.
**Test location:** `artifacts/api-server/__tests__/adminSnapshots.integration.test.ts` and `artifacts/parts-id/__tests__/adminDatabaseBackup.test.tsx`
**What it checks:** Server assertions fail if unauthorized users gain access, the start response waits for backup completion, duplicate work launches, status exposes private data or misreports outcomes, or retention/manual-reason behavior disappears; UI assertions fail if confirmation, busy-state suppression, return-time status refresh, accessible announcements, row count, or full local date-and-time rendering regresses.