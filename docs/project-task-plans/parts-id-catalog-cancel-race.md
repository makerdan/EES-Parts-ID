# Keep Catalog Cancellation Stable

## What & Why
Catalog PDF cancellation can race with worker completion and parent aggregation. Concurrent transitions may replace an already-terminal parent state, and an all-cancelled child set can be reported as done. Preserve accepted cancellation outcomes while allowing a completed worker to win if it commits first.

## Done looks like
- Cancel and worker finalization only transition a parent that is still pending or processing.
- Once a parent reaches a terminal state, cancellation, child aggregation, and status polling do not replace it.
- A parent with all children cancelled is reported as cancelled rather than done.
- Deterministic integration tests cover cancellation-before-finalization and finish-before-cancellation, including child termination.

## Out of scope
- Client presentation and cache invalidation for `done_with_errors` (covered by a separate task).
- Changes to unrelated catalog upload-session lifecycle or schema.

## Steps
1. Make parent cancellation and finalization use conditional state transitions that preserve the first accepted terminal outcome.
2. Ensure parent aggregation and status responses respect an existing terminal state and classify all-cancelled children as cancelled.
3. Add deterministic integration tests that control worker and cancellation ordering and await background-loop termination before assertions.

## Pre-existing failures to ignore
- `public-repository-boundary` has failed because this checkout lacks provider-retained pull-request refs; the failure repeated in three isolated runs and is documented in `docs/bug-audit-parts-id-state-management.md`. Do not change unrelated remote or validation configuration.

**Flaky-test rule:** If another test fails, retry it three times in isolation before assigning ownership. A passing retry establishes intermittency, not pre-existing provenance.

## Validation
**Command:** `test-standard`
**Why:** The race fix requires the API server's database-backed Catalog PDF integration tests in addition to focused deterministic interleaving checks.
**Do not escalate:** Run exactly this completion command. The known history-boundary failure is unrelated and should be handled using the Failure Gate evidence rules.

## Regression Guard
Add integration coverage proving terminal parent status remains stable after both possible cancellation/worker interleavings and after all child loops settle.

## Relevant files
- `artifacts/api-server/src/routes/catalogPdf.ts`
- `artifacts/api-server/__tests__/catalogPdfCancel.integration.test.ts`
- `artifacts/api-server/__tests__/catalogPdfChunk.integration.test.ts`
- `artifacts/api-server/__tests__/catalogPdfResumeChunkedEdgeCases.integration.test.ts`