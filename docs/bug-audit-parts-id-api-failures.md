# Bug & Error Audit Report

**Scope:** Reported Parts ID and API failures covering catalogue upload/review/resume/cancel, authentication and fixture isolation, AI provider/mocks, inventory and vendor ordering, analytics privacy/reporting, floor-plan/tile handling, and warehouse-zone/map behavior.
**Mode:** report-only
**Date:** 2026-09-04
**Stack:** TypeScript, React Native/Expo, React, Express, PostgreSQL/Drizzle, Jest, Supertest, pnpm. All ten audit categories were applicable. No category was skipped.

## Summary

The reported counts of 18 Parts ID failures and 36 API failures were not reproduced as current product failures. The writable baseline found five verified test-only, intermittent, or stale-contract findings. The API warehouse-zone mismatch is deterministic, but the implementation and the public-layout contract tests agree that the route is intentionally public. The Parts ID failures are caused by test lifecycle, mock, or diagnostic-log isolation assumptions; the focused product flows otherwise passed.

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 5 |

| # | Severity | Category | File:Line | One-line description |
|---|---|---|---|---|
| 1 | Low | Security | `artifacts/api-server/__tests__/auth.integration.test.ts:319` | Anonymous warehouse-zone read assertion is stale relative to the explicit public-layout contract. |
| 2 | Low | Async & timing | `artifacts/parts-id/__tests__/catalogPdfUploadE2E.test.tsx:448-462` | Full Parts ID run intermittently observes a native upload mock call without its expected options argument. |
| 3 | Low | Async & timing | `artifacts/parts-id/__tests__/catalogPdfUploadE2E.test.tsx:1646-1647` | Poll-abort tests do not establish the in-flight poll they expect before inspecting the signal. |
| 4 | Low | Concurrency & shared state | `artifacts/parts-id/__tests__/catalogPdfUploadReset.test.tsx:325-501` | Module/session diagnostic-log state leaks between reset tests and accumulates misleading AI-log counts. |
| 5 | Low | Concurrency & shared state | `artifacts/api-server/__tests__/floorPlanTiles.integration.test.ts:84-118` | Parallel floor-plan fixtures race on the shared latest-metadata row and can make a valid tile request return 500. |

## Findings

### Finding 1 — Warehouse-zone auth test contradicts the public-layout contract

- **File and line:** `artifacts/api-server/__tests__/auth.integration.test.ts:319`
- **Related implementation/contract:** `artifacts/api-server/src/routes/warehouseZones.ts:26-47`; `artifacts/api-server/src/routes/routeAccessMatrix.ts`; `artifacts/api-server/__tests__/publicWarehouseLayout.integration.test.ts`
- **Category:** Security
- **Severity:** Low
- **Classification:** Stale test expectation; not a production access-control defect.
- **Evidence:** The test expects anonymous `GET /api/warehouse-zones` to return 401. In the writable environment it returned 200 on three isolated retries, each with 22 passing tests and this same single failure. The route has no auth middleware for the read operation, the access matrix declares the read public, and the public-layout suite verifies anonymous access to zones and related floor-plan resources.
- **Risk:** The stale assertion blocks the API auth suite and can mislead reviewers into adding authentication to a read that the current product contract intentionally exposes. The observed response does not expose a protected write operation.
- **Recommended fix:** Update or remove the stale 401 assertion so it tests the public read contract, while retaining authentication coverage for protected warehouse-zone mutations. This recommendation is deferred; this audit made no test changes.

### Finding 2 — Full-suite upload mock interaction intermittently loses the options argument

- **File and line:** `artifacts/parts-id/__tests__/catalogPdfUploadE2E.test.tsx:448-462`
- **Related implementation:** `artifacts/parts-id/components/CatalogPdfUpload.tsx:673-815` and `:1290-1380`
- **Category:** Async & timing
- **Severity:** Low
- **Classification:** Intermittent test-only failure/full-suite interaction; no product defect reproduced.
- **Evidence:** The full Parts ID baseline reported this assertion failure because `mockCreateUploadTask.mock.calls[0][2]` was undefined. The same test passed in three isolated retries. Neighboring upload tests in the same group passed, and the focused upload/catalogue cluster did not reproduce a user-visible authorization failure.
- **Risk:** A full-suite run can report a false upload-auth regression or fail to validate the Authorization header even though the component path is functioning. The evidence is insufficient to claim that production calls omit upload options.
- **Recommended fix:** Make the test reset and upload-task selection deterministic, then assert the call shape only after the current upload path has completed. Capture the exact mock call list in the failing setup so any competing lifecycle call is identified. Do not change the component based on this finding.

### Finding 3 — Poll-abort tests do not establish an in-flight polling request

- **File and line:** `artifacts/parts-id/__tests__/catalogPdfUploadE2E.test.tsx:1602-1647` (failures at `:1646`)
- **Related implementation:** `artifacts/parts-id/components/CatalogPdfUpload.tsx:434-496` and `:343-348`
- **Category:** Async & timing
- **Severity:** Low
- **Classification:** Deterministic test-harness/lifecycle failure; no production defect reproduced.
- **Evidence:** Three isolated retries consistently failed both poll-abort cases because `capturedSignal` remained undefined before the helper returned. The helper assumes that the web XHR load immediately leads to `startPolling` and an in-flight `fetch`, but the rendered setup does not establish that state under the current upload/session flow. The component’s polling cleanup and generation guard are present in the implementation.
- **Risk:** The tests fail before exercising unmount cancellation or slow-response suppression, leaving those behaviors unverified and making the Parts ID suite appear to have an upload lifecycle regression.
- **Recommended fix:** Align the helper with the current upload flow: await the upload/session response that produces a job ID, then wait for and assert the polling fetch before returning its signal. Keep the production abort/generation logic unchanged unless a corrected test reproduces a live failure.

### Finding 4 — Reset tests inherit diagnostic pick-log state across cases

- **File and line:** `artifacts/parts-id/__tests__/catalogPdfUploadReset.test.tsx:220-235`, with failed assertions at `:325`, `:357`, `:391`, `:425`, `:461`, and `:494`
- **Related implementation:** `artifacts/parts-id/components/CatalogPdfUpload.tsx:350-370`, `:1733-1800`, and `:1936-1951`; `artifacts/parts-id/utils/pdfPickLogger.ts`
- **Category:** Concurrency & shared state
- **Severity:** Low
- **Classification:** Test-only fixture/isolation defect; not a user-facing reset failure.
- **Evidence:** Six reset assertions expected the AI Raw badge to show `2` entries or disappear, but isolated runs observed accumulated counts of 12, 25, 38, 51, 64, and 77. The component’s AI raw state is reset with `setAiRawLog([])` and its page-key set is cleared. Separately, the diagnostic pick logger intentionally persists module/session state and the test cleanup calls `jest.clearAllMocks()` without clearing that logger state. The observed accumulation is therefore from the diagnostic logger across mounts/tests, not from `aiRawLog`.
- **Risk:** The reset suite produces false failures and obscures whether the visible AI Raw state was cleared. In a long-lived app session, the diagnostic pick log is intentionally persistent; the failing test is assuming test isolation that it does not establish.
- **Recommended fix:** Reset or mock the diagnostic logger in each test setup, and assert the AI Raw panel independently from the persistent Pick Log panel. Do not remove the product’s intentional diagnostic persistence as part of this finding.

### Finding 5 — Parallel floor-plan fixtures race on the shared latest metadata row

- **File and line:** `artifacts/api-server/__tests__/floorPlanTiles.integration.test.ts:84-118`, with the failing assertion at `:160`
- **Related implementation/fixtures:** `artifacts/api-server/src/routes/floorPlan.ts:370-403`; `artifacts/api-server/__tests__/floorPlanMapWorkflow.integration.test.ts:99-140`
- **Category:** Concurrency & shared state
- **Severity:** Low
- **Classification:** Intermittent test-only fixture isolation failure; no production tile defect reproduced.
- **Evidence:** The standard-plus run failed the valid-tile cache-control test with 500 because the route rejected the mocked SVG/hash pair as mismatched. The suite seeds one floor-plan row with `onConflictDoNothing()` and the route reads the globally latest metadata row, while other floor-plan suites use the same shared database and can insert or update a newer row. Three isolated retries of `floorPlanTiles.integration.test.ts` passed all 39 tests.
- **Risk:** A parallel API validation run can report a false floor-plan/tile regression and skip the cache-header assertion. In a real request, the hash guard correctly prevents serving a stale or misaligned tile; the reproduced mismatch is created by competing test fixtures.
- **Recommended fix:** Give each floor-plan suite an isolated database namespace/worker-qualified fixture or serialize the suites that mutate the globally latest metadata row. Avoid changing the production hash guard based on this test-only race.

## Tooling signals (Phase 0)

- **Typecheck:** Clean. Parts ID typecheck and API server production/test typecheck passed. Parts ID router codegen successfully wrote `.expo/types/router.d.ts` in the writable audit environment.
- **Lint:** Clean exit codes. Parts ID emitted two warnings: `artifacts/parts-id/app/(tabs)/upload.tsx:1247` reports the `parsedRows` dependency is represented by `parsedRows.length`, and `artifacts/parts-id/components/BarcodeScanModal.tsx:248` reports an unnecessary `resetScan` dependency. API lint and Knip exited cleanly with two configuration hints (`fuser` ignored binary and an unmatched script entry pattern). These warnings were not reproduced as failures and are deferred.
- **API full-suite tests:** The standalone baseline had 103 suites and 1,486 tests, with 102 suites passed and one test failed, the stale warehouse-zone assertion at `auth.integration.test.ts:319`. The mandated `test-standard-plus` run had 101 suites passed and two tests failed: that same auth assertion plus the intermittent floor-plan tile fixture failure at `floorPlanTiles.integration.test.ts:160`.
- **Parts ID full-suite tests:** 174 suites, 2,153 tests; 172 suites passed and two suites failed, with nine failed tests limited to the upload E2E/reset findings above.
- **Focused reproduction:** API catalogue suites passed 14/14 suites and 131/131 tests. API AI/inventory/vendor/analytics suites passed 12/12 suites and 432/432 tests. The standalone API map/auth run passed 103 tests with only the warehouse-zone contract failure, and three isolated floor-plan tile retries passed 39/39 tests each. Parts ID focused auth, AI status, floor-plan, warehouse-map, and upload-hardening coverage passed 10 suites and 170 tests.
- **Mandated validation:** `pnpm run test-standard-plus` was run exactly. Gate, typecheck, lint, codegen, contract, and security-precondition steps passed; the shared `test` step failed on the documented Parts ID harness cluster and the two API tests above. No heavier tier was run.
- **Dependency audit:** `pnpm audit --audit-level=low` reported two high advisories for `image-size@2.0.2` (ICNS and JXL/HEIF parser denial-of-service advisories). The package is a patched Parts ID development/test dependency; the source audit found no production import. The existing malformed-image safety test and local patch cover the affected parser paths. No dependency was upgraded in report-only mode, and this signal is not counted as a reproduced application failure.

## Deferred / not audited

- The historical totals of 18 Parts ID and 36 API failures are not current findings without a matching current signature. The current writable baseline and focused groups did not reproduce the remaining catalogue, auth/fixture-isolation, AI/mock, inventory/vendor-ordering, analytics, or warehouse-map failures as product defects.
- Catalogue upload session/status lifecycle, auth/fixture helpers, AI provider error paths, inventory/vendor ordering, analytics privacy/reporting, floor-plan cache/hash/tile handling, and warehouse-zone/map behavior were inspected and exercised through the focused suites listed above. They passed unless explicitly listed in Findings; the floor-plan tile finding is limited to combined-run fixture interference.
- The read-only Planner observation that Parts ID router generation could not write `.expo/types/router.d.ts` did not remain reproducible in the writable audit environment. It is recorded as cleared environment limitation, not as a finding.
- The two Parts ID lint warnings and two API Knip configuration hints remain deferred hygiene work. They did not produce a matching runtime or test failure during this audit.
- The `image-size` advisories remain deferred dependency work because the dependency is patched and test-only in this checkout, and dependency upgrades are outside this task’s scope. Re-run the safety test and evaluate the patch/upgrade strategy in a separate dependency task before treating it as release risk.
- The audit did not perform a release-readiness sign-off, dependency upgrade, code change, test change, fixture/mock change, validation-baseline change, generated-artifact change, or connected-service change.

**Report-only boundary:** This audit produced this findings report only. No production code, tests, mocks, fixtures, validation baselines, generated artifacts, or task archives were changed.
