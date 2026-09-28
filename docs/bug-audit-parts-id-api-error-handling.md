# Parts ID and API Server Error-Handling Audit

**Scope:** Parts ID mobile/web and the API Server: screen and route failures, auth expiry, persistence, uploads/storage, background work, response handling, middleware, boundaries, and user feedback.
**Mode:** Report-only. No product code, tests, configuration, or production data were changed.
**Date:** 2026-09-27
**Stack:** TypeScript, React Native/Expo, Express, PostgreSQL/Drizzle, private object storage, Jest, pnpm.

## Summary

The audit verified **25 in-scope issues: 1 High, 16 Medium, and 8 Low**. No Critical findings were verified. Findings are ordered by severity, then by product area. Every finding below has a possible repair task or is mapped to an existing task/plan.

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 1 |
| Medium | 16 |
| Low | 8 |

The canonical Bug Audit skill was not present under `.agents/skills`, and the user preference prohibits using alternate or copied skill definitions. This report therefore follows the existing tracked audit-report structure and category vocabulary; it does not claim to have run the unavailable skill. Coverage is stated path-by-path below; inventory-only routes and unverified candidates are not presented as deeply audited.

## Coverage ledger

| Product / entry point | Coverage | Paths and checks |
|---|---|---|
| Parts ID authentication and shared network handling | Deep-traced | `contexts/AppContext.tsx`, `utils/appAuth.ts`, `utils/verifyAdminRequest.ts`, `contexts/ApiHealthContext.tsx`; current-token behavior, centralized 401 handling, deadlines, aborts, and network feedback. |
| Catalog review and job recovery | Deep-traced | `app/catalog-review.tsx`; list and secondary status requests, resume polling, cancel, retry, dismiss, revert, request ownership/abort, and visible errors. Cross-checked `fix-parts-id-network-recovery.md` and `catalogReviewResumeStatusErrors.test.tsx`. |
| Catalog PDF upload | Deep-traced | `components/CatalogPdfUpload.tsx`, `app/(tabs)/upload.tsx`, `utils/readPdfAsBase64.ts`; durable-manifest read/resume, multipart status polling, cancellation, web/native transport paths, validation, local persistence, and user-visible progress/errors. Cross-checked upload E2E/reset/before-unload tests. |
| Admin support screens | Deep-traced | `app/admin-inbox.tsx` (list/read), `app/admin-audit-log.tsx` (initial load, refresh, pagination, abort/version guards), and their workflow tests. |
| Search | Deep-traced | `app/(tabs)/index.tsx`, `utils/searchHelpers.ts`, `utils/retryAsync.ts`, and search cache/fallback/race tests. No new search error-path defect was verified. |
| Inventory edit and add | Deep-traced | `components/PartDetailsEditor.tsx`, `app/edit-item.tsx`, `utils/inventoryWrite.ts`, `utils/editItemCache.ts`, `utils/sharedPartSaveCoordinator.ts`, `components/AddPartForm.tsx`, `components/PartPhotoPicker.tsx`, and `utils/addToInventory.ts`; save rollback, photo handling, and visible state. |
| Map, zones, and floor-plan client | Deep-traced | `hooks/useMapAnchors.ts`, `hooks/useWarehouseZones.ts`, `app/admin-map-calibration.tsx`, and floor-plan upload in `app/(tabs)/upload.tsx`; auth retry, write feedback, and request lifecycle. |
| UI boundaries and persistence reporting | Deep-traced | `components/ErrorBoundary.tsx`, `components/ErrorFallback.tsx`, `utils/storageErrorReporter.ts`, and relevant AppContext settings persistence. |
| Other Parts ID API callers and storage/cache helpers | Inventoried, not exhaustively deep-traced | Direct callers were enumerated by search, including `app/admin.tsx`, `app/ai-log.tsx`, `app/edit-item.tsx`, help/reference, category/product components, and remaining cache/storage helpers. The full generated-client call graph and every screen’s failure state were not traced end-to-end. No claim is made that these remaining paths were individually verified. |
| API global handling and auth middleware | Deep-traced | `src/app.ts`, `middlewares/requireAppAuth.ts`, and `middlewares/requireAdminAuth.ts`; CORS, body parsers, request IDs, generic error responses, and auth failure propagation. |
| Inventory routes and jobs | Deep-traced | `src/routes/inventory.ts` and `inventoryCategories.ts`; create/edit/photo writes, search/category filters, imports, enrichment and expansion jobs, cancellation, status, dimensions, and route-level rollback/error handling. Cross-checked relevant inventory integration/unit tests. |
| Catalog PDF processing and durable upload | Deep-traced | `src/routes/catalogPdf.ts`, `catalogPdfUpload.ts`, `src/index.ts`, and object-storage helpers; worker catch paths, shutdown/startup recovery, cancellation/expiry cleanup, and staged-part reads. |
| Admin, snapshot, and upload routes | Deep-traced | `admin.ts`, `adminSnapshots.ts`, `adminDashboard.ts`, `adminAiStatus.ts`, `adminQuery.ts`, and `adminUpload.ts`; mutation/audit ordering, safe responses, logging, transaction boundaries, and backup/restore outcomes. |
| Floor plan, warehouse zones, map anchors, and reference Q&A | Deep-traced | `floorPlan.ts`, `warehouseZones.ts`, `mapAnchors.ts`, `reference.ts`, and `lib/webSearch.ts`; upload persistence, identifier parsing, provider request paths, and route responses. |
| Remaining API routes | Inventoried, selected paths inspected | All route modules were enumerated: `auth.ts`, `inventoryCategories.ts`, `mapAnchors.ts`, `track.ts`, `user.ts`, `adminDashboard.ts`, `contact.ts`, `index.ts`, `help.ts`, `reference.ts`, `warehouseZones.ts`, `floorPlan.ts`, `adminUpload.ts`, `catalogPdfUpload.ts`, `dictionaries.ts`, `admin.ts`, `health.ts`, `adminAiStatus.ts`, `ai.ts`, `inventory.ts`, `routeAccessMatrix.ts`, `adminSnapshots.ts`, `catalogPdf.ts`, and `adminQuery.ts`. `contact.ts`, `track.ts`, `dictionaries.ts`, `auth.ts`, and parts of `user.ts`/`health.ts` were inventoried or selectively read, not failure-injected or deeply traced end-to-end. Candidate concerns are listed separately. |

## Findings

### High

#### F-01 — Failed catalog image upload can erase previously saved part images

- **Severity:** High
- **Category:** Data integrity
- **Affected paths:** `artifacts/api-server/src/routes/catalogPdf.ts:520-585`
- **Scenario and evidence:** When PDF extraction matches an inventory item, `imageUrl` and `imageUrl2` start as `null`. An object-store upload failure is caught and recorded, but the subsequent inventory update still writes both values at `:555-567`. If it returns a row, cleanup then deletes the item’s prior image objects at `:579-585`. A transient upload failure can therefore remove the existing image references and underlying private objects instead of preserving them.
- **Coverage:** Existing catalog AI/error tests cover provider failures, not image-upload failure while an item already has image URLs.
- **Minimal fix:** Preserve each existing image independently unless a replacement for that slot uploaded and was committed; only delete the corresponding old object after its replacement reference is durable.
- **Possible fix task:** **T-01 — Prevent failed catalog image uploads from erasing saved photos.** Product/area: API Server catalog PDF matching. Priority: P1. Acceptance: fail either image upload with an item already holding one or two private images; old URLs and objects remain, successful replacement slots still commit correctly, and cleanup only removes replaced objects. No sequencing dependency.

### Medium

#### F-02 — Inventory photo failures can leave uploaded objects unreferenced

- **Severity:** Medium
- **Category:** Persistence / storage compensation
- **Affected paths:** `artifacts/api-server/src/routes/inventory.ts:3893-3899,3916-3948`
- **Scenario and evidence:** Full-size and thumbnail objects are uploaded with `Promise.all`; paths are recorded only after both promises resolve. If one upload succeeds and the other rejects, the successful object path is lost. If the database update rejects after both uploads succeed, the outer catch returns 500 without cleaning `uploadedPaths`. A retry can create more orphaned private objects.
- **Coverage:** `inventoryEditRoutes.test.ts:292-301` tests total upload failure, not partial success or DB failure; photo integration coverage found in this audit is remove-only.
- **Minimal fix:** Track each fulfilled upload as it completes and clean every uncommitted object on all failed write/response paths.
- **Possible fix task:** **T-02 — Keep add/edit photo saves truthful after partial failures** (grouped with F-03–F-05). Product/area: Parts ID add/edit and API inventory photo routes. Priority: P1. Acceptance: inject one-success/one-failure uploads, DB write failure, empty update results, and rollback DELETE non-2xx; assert no unreferenced objects, no false success, and accurate retry guidance. Can be implemented independently.

#### F-03 — Add-part can orphan one photo when its paired upload fails

- **Severity:** Medium
- **Category:** Persistence / storage compensation
- **Affected paths:** `artifacts/api-server/src/routes/inventory.ts:1680-1705`
- **Scenario and evidence:** The full image and thumbnail upload run in `Promise.all`; `uploadedPaths` is populated only after the entire promise resolves (`:1684-1689`). If one object is stored and the paired upload rejects, the catch attempts cleanup with an empty path list, deletes the newly inserted inventory row, and returns 500.
- **Coverage:** `addPartZodGuard.test.ts:162-455` covers ordinary success and request/output guards; no partial-upload compensation test was found.
- **Minimal fix:** Record each successful object before awaiting the other upload, then compensate both storage and the inserted row on failure.
- **Possible fix task:** T-02.

#### F-04 — Add-part may return 201 without persisting the uploaded photo

- **Severity:** Medium
- **Category:** Data integrity
- **Affected paths:** `artifacts/api-server/src/routes/inventory.ts:1690-1710`
- **Scenario and evidence:** If the post-upload UPDATE returns no row, `finalItem` remains the original inserted row (`:1690-1695`). The code does not treat this as an error or clean the two uploaded objects, then returns 201 with the original item at `:1709-1710`. A concurrent delete or empty adapter result can produce a success response for an item whose photo was not attached (and may no longer exist).
- **Coverage:** No test covers an empty UPDATE result after add-part photo upload.
- **Minimal fix:** Require a returned updated row; otherwise clean the uploaded objects and return an explicit failure.
- **Possible fix task:** T-02.

#### F-05 — Failed add-part dimensions can be reported as “not created” when rollback failed

- **Severity:** Medium
- **Category:** Persistence / user-visible feedback
- **Affected paths:** `artifacts/parts-id/components/AddPartForm.tsx:171-203`
- **Scenario and evidence:** After the create request succeeds, a dimensions PATCH failure triggers a best-effort DELETE. The code catches thrown network errors but never checks the DELETE response status (`:192-199`). If DELETE returns 401/500, the created item remains, yet the form says “The part was not created” (`:200-202`). Retrying can create a duplicate.
- **Coverage:** `addPartForm.test.tsx` covers dimensions failure feedback; no assertion covers rollback DELETE returning non-2xx.
- **Minimal fix:** Check the rollback response and distinguish “creation rolled back” from “part was created but cleanup failed”; preferably make creation plus dimensions atomic on the server.
- **Possible fix task:** T-02.

#### F-06 — Bulk enrichment can repeatedly retry a permanently failing item

- **Severity:** Medium
- **Category:** Async & timing
- **Affected paths:** `artifacts/api-server/src/routes/inventory.ts:2252-2288,2290-2312`
- **Scenario and evidence:** Non-force runs select the first batch with `enrichedAt IS NULL` without advancing a cursor (`:2275-2285`). A per-item enrichment failure increments the error count but deliberately leaves `enrichedAt` null (`:2304-2312`), so the same permanently failing item is selected again after the batch. The job does not naturally finish until the provider recovers or an admin stops it; a poisoned row or sustained provider outage can generate repeated calls.
- **Coverage:** `pinnedKeywordsEnrichment.test.ts` covers successful runs and cancellation, not repeated permanent item failure/termination.
- **Minimal fix:** Track attempted IDs for the current run or persist per-item terminal outcomes and retry on a later run instead of immediately selecting the same failed item.
- **Possible fix task:** **Task #1988 (Bound bulk enrichment failures)** (grouped with F-07). Product/area: API Server `/inventory/bulk-enrich`. Priority: P1. Acceptance: a permanently failing seeded item is attempted only within a bounded retry budget, the job reaches a visible terminal state, cancellation remains responsive, and a later run can retry it. Merged Task #1939 addressed the separate description-expansion job.

#### F-07 — A bulk-enrichment DB outage can leave its durable job marked running

- **Severity:** Medium
- **Category:** Persistence / background jobs
- **Affected paths:** `artifacts/api-server/src/routes/inventory.ts:2220-2245,3147-3155,3165-3202`
- **Scenario and evidence:** The job row is created as `running` (`:2224-2232`). A later fatal query/update error rejects `runBulkEnrich`; the detached route handler marks only process-local state failed and separately attempts a DB terminal update (`:3147-3155`). If the DB remains unavailable for that terminal update, the persisted row stays `running`; the API startup recovery inspected here handles catalog PDF jobs, not this bulk-enrichment table. A later status lookup can report stale durable state.
- **Coverage:** Tests cover ordinary terminal persistence/cancellation, not an outage spanning both fatal work and terminal persistence or restart recovery.
- **Minimal fix:** Make terminal writes retryable/durable and reconcile stale `running` bulk-enrichment rows on restart using bounded ownership/state rules.
- **Possible fix task:** Task #1988. Keep the keyword-enrichment queue distinct from the merged #1939 description-expansion ownership work.

#### F-08 — Catalog PDF worker recovery can fail before persisting or logging the original failure

- **Severity:** Medium
- **Category:** Async & timing / persistence
- **Affected paths:** `artifacts/api-server/src/routes/catalogPdf.ts:211-219,671-690,976-1019,1478-1498`
- **Scenario and evidence:** Worker catch paths await the failed-status UPDATE and `revertSessionItems` before logging the original error. If either recovery operation rejects, control jumps to `finally`; `trackJobLoop` consumes the rejected loop (`:211-219`) without another log. The job may remain `processing` in the same process until shutdown/restart recovery runs. This is not an unconditional permanent hang: shutdown and startup have separate recovery.
- **Coverage:** Shutdown and normal/provider-failure tests cover successful terminalization; no test injects failure in catch-path status persistence or rollback.
- **Minimal fix:** Isolate recovery failures, preserve/log the original processing error plus recovery errors, and ensure the job is durably retryable or terminal even when rollback fails.
- **Possible fix task:** **T-04 — Keep catalog PDF jobs recoverable when failure cleanup also fails.** Product/area: API Server catalog PDF worker/resume. Priority: P2. Acceptance: inject failed terminal UPDATE and failed rollback separately; the original cause is logged safely, the job is not falsely left active, and Resume remains available. Existing Task #1914 covers cancellation/chunk races, not this failure-catch path.

#### F-09 — Failed cancellation cleanup has no automatic retry for staged PDF parts

- **Severity:** Medium
- **Category:** Persistence / storage compensation
- **Affected paths:** `artifacts/api-server/src/routes/catalogPdfUpload.ts:102-117,408-423,426-465`
- **Scenario and evidence:** The cancel route commits `status: cancelled` and `cleanupAt` before calling object cleanup (`:411-423`). A delete failure rejects before part metadata removal (`:106-117`); the request can return 500 after cancellation is already durable. Recovery scans expired `open`/`completing` sessions and completed pending jobs, but not cancelled sessions (`:431-465`). Retrying the same cancel request does retry cleanup, so the leak occurs when the client does not retry.
- **Coverage:** `catalogPdfUploadSession.integration.test.ts:218-231` covers normal/idempotent cancellation, not a failed storage delete followed by no client retry.
- **Minimal fix:** Schedule/reconcile cleanup for cancelled sessions until all staged objects and metadata are removed; retain the current idempotent retry behavior.
- **Possible fix task:** **Task #1990 (Reconcile cancelled upload parts)** extends the earlier durable-upload cleanup design with autonomous retries. Related proposed Task #1914 concerns chunk-start cancellation races, not object cleanup.

#### F-10 — One unreadable staged PDF part can permanently fail process readiness

- **Severity:** Medium
- **Category:** Reliability / startup recovery
- **Affected paths:** `artifacts/api-server/src/routes/catalogPdfUpload.ts:444-465`; `artifacts/api-server/src/index.ts:347-380,406-410`; `artifacts/api-server/src/routes/health.ts:83-92`
- **Scenario and evidence:** Startup recovery reads each completed session’s parts with `Promise.all` (`:461-465`). One missing/unreadable object rejects the whole function and stops later sessions in the loop. The required-startup `Promise.all` catches that rejection and marks readiness failed (`index.ts:350-359,366-380`). The listener still starts, but `/healthz` remains 503; the 15-minute retry may process sessions later but does not reset the terminal readiness state for that process.
- **Coverage:** Startup tests do not inject an unreadable staged part or assert later records are still recovered/readiness changes. Upload integration tests cover healthy recovery.
- **Minimal fix:** Isolate failures per session, persist/quarantine an unrecoverable session outcome, continue processing later sessions, and ensure bounded startup readiness can recover or fail with an actionable health signal.
- **Possible fix task:** **Task #1991 (Isolate staged upload recovery failures)** covers unreadable-part and later-session readiness checks. Merged Task #1940 addressed temporary schema outage recovery, not this staged-object failure.

#### F-11 — Floor-plan object upload can be orphaned by a metadata-write failure

- **Severity:** Medium
- **Category:** Persistence / storage compensation
- **Affected paths:** `artifacts/api-server/src/routes/floorPlan.ts:510-524`
- **Scenario and evidence:** The route uploads the SVG to object storage before inserting `floorPlanMetaTable`. If the DB insert fails, the catch returns 500 but does not delete the just-uploaded `objectPath`. A retry can leave multiple private objects with no metadata row.
- **Coverage:** `floorPlanMapWorkflow.integration.test.ts:160-179` covers successful upload/replacement; no upload-success/DB-failure compensation case was found.
- **Minimal fix:** Delete the uploaded object when the metadata write fails, using idempotent cleanup and preserving the original DB error in bounded diagnostics.
- **Possible fix task:** **T-05 — Remove failed floor-plan uploads when metadata cannot be saved.** Product/area: API Server floor-plan upload. Priority: P2. Acceptance: mock successful object upload plus failed metadata insert; assert 500 is actionable, the new object is removed, and a retry does not accumulate orphans. No sequencing dependency.

#### F-12 — Snapshot restore can commit, then report that nothing was committed

- **Severity:** Medium
- **Category:** Data integrity / user-visible feedback
- **Affected paths:** `artifacts/api-server/src/routes/adminSnapshots.ts:150-190`
- **Scenario and evidence:** The locked restore transaction commits at `:150-163`. The success audit insert and cache invalidation then run outside that transaction (`:164-171`). If either fails, the catch returns 500 with “no partial restore was committed” (`:173-190`), although the inventory restore is already complete. The client may retry based on a false rollback claim, and audit/cache state may disagree with inventory state.
- **Coverage:** Snapshot route tests cover successful dry-run/status paths; recovery tests cover transaction rollback, not post-commit audit/cache failure.
- **Minimal fix:** Separate commit outcome from post-commit audit/cache failure; return an explicit committed-but-follow-up-failed result or make follow-up operations durable/retryable. Never claim rollback after commit.
- **Possible fix task:** **Task #1993 (Make snapshot outcomes truthful)** (grouped with F-18 and F-19). Product/area: API Server snapshot dry-run/restore. Priority: P1. Acceptance: inject audit and cache invalidation failures after commit; response and audit status accurately say the inventory committed, retries do not repeat a restore under a false rollback assumption, dry-run failures map safely, and stale confirmation returns 409.

#### F-13 — Raw admin requests treat expired authorization as an ordinary request error

- **Severity:** Medium
- **Category:** Security / authentication and user feedback
- **Affected paths:** `artifacts/parts-id/app/admin-inbox.tsx:69-80,191-213`; `app/admin-audit-log.tsx:221-230,262-271,304-326`; `hooks/useMapAnchors.ts:43-114`; `app/(tabs)/upload.tsx:3351-3388`; `components/CatalogPdfUpload.tsx:529-568`
- **Scenario and evidence:** These protected raw-fetch paths do not consistently call the shared 401/logout handler. Inbox and audit-log responses become generic errors while admin state and previously loaded data remain; map-anchor writes return a generic failure; floor-plan upload displays generic/network failure; durable upload resume silently returns on any non-2xx and keeps the manifest. This differs from `utils/appAuth.ts:182-187` and `contexts/AppContext.tsx:554-565`, which centralize 401 expiry for wrapped calls. Some of these raw requests also have no explicit deadline, so a hung operation can leave local loading/saving active indefinitely.
- **Coverage:** Existing admin inbox/audit tests cover normal failures/retries; map-anchor tests cover success/403, not 401; floor-plan/upload resume tests do not cover 401. The existing network recovery plan covers catalog-review polling and zone loading, not all paths listed here.
- **Minimal fix:** Route protected calls through the shared auth-aware request helper or explicitly invoke the shared expiry flow on 401; add bounded request deadlines where the operation can otherwise remain pending.
- **Possible fix task:** **Task #1994 (Unify admin session expiry).** Product/area: Parts ID admin inbox, audit log, map calibration, floor-plan upload, and durable PDF resume. Priority: P2. Acceptance: each listed request returning 401 clears admin access and stops local mutation/polling; 403 and transient 5xx retain actionable non-expiry errors; stalled calls terminate with retry feedback. Coordinate inbox/audit work with the existing screen plans; network-recovery work already covers the catalog-review poll and zone loader.

#### F-14 — Catalog PDF upload polling can wait forever on persistent non-401 failures

- **Severity:** Medium
- **Category:** Async & timing / user-visible feedback
- **Affected paths:** `artifacts/parts-id/components/CatalogPdfUpload.tsx:446-497`
- **Scenario and evidence:** The poll handles 401 explicitly at `:454`, but other non-2xx responses fall through to the abort-aware delay and repeat forever. A successful but schema-invalid status only emits a warning (`:456-486`) and also keeps polling without a visible error or bounded retry count. A persistent 5xx/429 or incompatible response can leave the admin believing processing is still underway.
- **Coverage:** Upload E2E/reset tests cover terminal outcomes and lifecycle reset, not persistent non-401 polling failures or malformed 2xx status.
- **Minimal fix:** Add bounded retries and a visible retryable poll-error state for non-2xx and schema-invalid responses while preserving abort/generation guards.
- **Possible fix task:** **T-08 — Show an actionable error when catalog upload status cannot be read.** Product/area: Parts ID catalog PDF upload/review. Priority: P2. Acceptance: persistent 5xx/429 and invalid 2xx status stop unbounded polling, preserve resumable job state, and display retry; transient failures can recover; abort stays silent. Keep this distinct from the existing catalog-review 401 work.

#### F-15 — Failed-job list errors disappear on the all-reviews screen

- **Severity:** Medium
- **Category:** User-visible feedback / API response handling
- **Affected paths:** `artifacts/parts-id/app/catalog-review.tsx:312-399`
- **Scenario and evidence:** When the all-reviews route has no `jobId`, a non-OK secondary `/failed-jobs` response does not enter the error branch (`:396-399`, which is conditional on `jobId`). The review rows render, but failed-job retry/dismiss controls are absent and there is no indication the second request failed.
- **Coverage:** `catalogReviewResumeStatusErrors.test.tsx` covers job status errors; no test covers a failed secondary failed-jobs request without a `jobId`.
- **Minimal fix:** Track and show a separate failed-jobs load error, preserving any successfully loaded review rows.
- **Possible fix task:** T-08.

#### F-16 — Numeric route parsing accepts malformed IDs and can mutate a different record

- **Severity:** Medium
- **Category:** Security / input validation
- **Affected paths:** `artifacts/api-server/src/routes/warehouseZones.ts:277-323`; `src/routes/mapAnchors.ts:21-24,60-64,91-95`
- **Scenario and evidence:** `parseInt` accepts a valid numeric prefix and ignores trailing characters. For example, `/warehouse-zones/12garbage` is treated as ID 12 for PATCH/DELETE, and `/admin/map-anchors/1junk` is treated as slot 1 for PUT/DELETE. A malformed request can therefore update or delete a valid resource instead of returning 400.
- **Coverage:** Warehouse-zone tests cover nonnumeric IDs, not numeric prefixes with suffixes; map-anchor tests cover normal authorization/writes, not malformed suffixes.
- **Minimal fix:** Require the entire path segment to match a positive safe integer or exactly one of the allowed slot strings before querying.
- **Possible fix task:** **T-09 — Reject malformed zone and map-anchor IDs before writes.** Product/area: API Server warehouse-zone/map-anchor routes. Priority: P1. Acceptance: suffix/prefix/decimal/unsafe IDs return 400 and never mutate a valid row; valid IDs retain current behavior. No sequencing dependency.

#### F-17 — Several API failure paths log or return unbounded raw errors

- **Severity:** Medium
- **Category:** Security / logging
- **Affected paths:** `artifacts/api-server/src/app.ts:223-225`; `routes/adminDashboard.ts:141-143`; `routes/adminAiStatus.ts:133-135,151-153,196-198,224-226`; `routes/admin.ts:255-257,311-313,353-355,397-399,440-442`; `routes/inventoryCategories.ts:177-180`; `routes/floorPlan.ts:521-523`; `routes/inventory.ts:2335-2349,3076-3085`
- **Scenario and evidence:** Several routes log `{err}` or pass raw errors to `console.error`, outside the bounded diagnostic helper. Pino redaction covers authorization/cookie headers, not arbitrary error messages/stacks (`src/lib/logger.ts:6-20`); `inventory.ts:3076-3085` also places `String(err)` in a client response, while the enrich-summary catch at `:2347` discards the error entirely. Provider/driver errors can therefore expose internals to admins or privileged logs, while the summary path provides no diagnostic. This is not evidence that a secret was actually emitted.
- **Coverage:** Inventory category/list/write tests cover normal contracts, but no log-content or raw-error-response tests were found for these paths. The existing completed Task #248 and security report concern `adminQuery`, not these routes.
- **Minimal fix:** Use bounded, request-correlated diagnostics and stable client-safe messages; do not serialize raw provider/database Error objects or discard the only failure diagnostic.
- **Possible fix task:** **T-10 — Keep admin error logs bounded and safe.** Product/area: API Server global/admin logging. Priority: P2. Acceptance: inject SQL/provider/restart errors containing sentinel sensitive text; assert the sentinel and raw stack are absent while request ID, safe error class, and actionable internal diagnostics remain. Reconcile with `.local/tasks/ux-fix-admin-dashboard-tools.md` and `ux-fix-people-management.md` if those plans cover the same log paths.

### Low

#### F-18 — Snapshot dry-run reports operational failures as client input errors

- **Severity:** Low
- **Category:** API contract / error mapping
- **Affected paths:** `artifacts/api-server/src/routes/adminSnapshots.ts:100-132`
- **Scenario and evidence:** Storage reads, DB reads, response-schema validation, confirmation-secret use, and audit persistence all run in one `try`. Any failure is returned as 400 “Snapshot dry run failed” (`:130-132`), including infrastructure/configuration failures and audit insert failures that are not bad client input.
- **Coverage:** Route tests cover the successful dry-run path; no failure-injection test distinguishes invalid input from server/storage/audit failure.
- **Minimal fix:** Validate request input separately; map missing snapshot to 404 and operational failures to a safe 5xx with a request ID.
- **Possible fix task:** T-06.

#### F-19 — Stale restore confirmation integrity failure is returned as HTTP 500

- **Severity:** Low
- **Category:** API contract / error mapping
- **Affected paths:** `artifacts/api-server/src/routes/adminSnapshots.ts:145-158,173-190`
- **Scenario and evidence:** Malformed/expired tokens return 409, but a valid-format token whose signature no longer matches the current inventory digest throws at `:156-157` and falls into the generic 500 handler. This is a normal stale-confirmation/conflict case and should prompt a fresh dry-run.
- **Coverage:** No test covers changed-inventory confirmation or verifies the response status and non-mutation.
- **Minimal fix:** Map digest/signature mismatch to the same 409 fresh-confirmation contract and prove no restore occurs.
- **Possible fix task:** **Task #1993 (Make snapshot outcomes truthful)** (grouped with F-12 and F-18). Product/area: API Server snapshot restore. Priority: P1 for the grouped task. Acceptance: change inventory after dry-run, submit the old token, assert 409 and unchanged inventory.

#### F-20 — Body-parser errors are flattened to HTTP 500

- **Severity:** Low
- **Category:** API contract / error mapping
- **Affected paths:** `artifacts/api-server/src/app.ts:182-210,214-234`
- **Scenario and evidence:** Express JSON/urlencoded parsers run before the router. Malformed JSON and oversized bodies carry client-error statuses, but the global handler ignores the error’s known safe status/type and always sends 500 (`:223-234`). Clients retry a request they should correct or resize.
- **Coverage:** No parser-error status test was found in the reviewed API suite.
- **Minimal fix:** Map known parser errors to safe 400/413 responses while retaining a generic 500 for unknown errors.
- **Possible fix task:** **T-11 — Return useful, safe API statuses for middleware failures** (grouped with F-21). Product/area: API Server global middleware. Priority: P3. Acceptance: malformed JSON returns 400, oversized supported-route payload returns 413, unknown exceptions remain generic 500 with request ID, and no internal message reaches clients. No sequencing dependency.

#### F-21 — Disallowed CORS origins are reported as server failures

- **Severity:** Low
- **Category:** API contract / error mapping
- **Affected paths:** `artifacts/api-server/src/app.ts:108-132,223-234`
- **Scenario and evidence:** A rejected origin calls the CORS callback with an error at `:129`; the global handler returns HTTP 500. The browser then commonly exposes a generic network/CORS failure, obscuring that the request was rejected by policy.
- **Coverage:** No test was found for a disallowed origin’s server-side status/log classification.
- **Minimal fix:** Distinguish an expected origin rejection from an unexpected internal failure and return a consistent deny response without exposing the origin or internal details.
- **Possible fix task:** T-11.

#### F-22 — Clerk deletion failure returns the provider’s raw message to the admin UI

- **Severity:** Low
- **Category:** Security / user-visible feedback
- **Affected paths:** `artifacts/api-server/src/routes/admin.ts:480-499`
- **Scenario and evidence:** After the database row is deleted, a Clerk exception is converted to a string, logged, and returned as `clerkError` (`:495-498`). The route is admin-only and intentionally reports `clerkDeleted: false`, but provider text can include internal request details. The missing-key branch also includes configuration detail.
- **Coverage:** No Clerk deletion-failure test was found; existing admin-audit tests cover successful audit entries.
- **Minimal fix:** Keep the deliberate partial-success warning (`deleted: true`, `clerkDeleted: false`) but return a stable client-safe code/message and log bounded diagnostics.
- **Possible fix task:** Task #1996 (Bound admin failure diagnostics); coordinate with the existing People & System plan.

#### F-23 — Malformed barcode percent-encoding becomes HTTP 500

- **Severity:** Low
- **Category:** API contract / input validation
- **Affected paths:** `artifacts/api-server/src/routes/inventory.ts:3443-3472`
- **Scenario and evidence:** The route decodes the captured path with `decodeURIComponent` inside the general lookup `try`. A malformed percent sequence throws `URIError`, is logged as a lookup failure, and is returned as 500 “Barcode lookup failed” rather than a 400 invalid barcode response.
- **Coverage:** Barcode tests cover database-row validation and ordinary lookup cases; no malformed-encoding request test was found.
- **Minimal fix:** Validate/guard decoding separately and return a stable 400 for malformed path encoding.
- **Possible fix task:** **T-12 — Return client errors for malformed inventory requests.** Product/area: API Server barcode and batch-import routes. Priority: P3. Acceptance: malformed percent encoding and malformed preview/batch rows return 400 without database writes; valid requests retain their current behavior. No sequencing dependency.

#### F-24 — Malformed batch-preview input can surface as HTTP 500

- **Severity:** Low
- **Category:** API contract / input validation
- **Affected paths:** `artifacts/api-server/src/routes/inventory.ts:1722-1835`
- **Scenario and evidence:** The preview route validates collection limits and some required fields, but malformed row values can reach string/array operations such as `.toUpperCase()` or `.map()` (`:1748-1751`). Those request-shape exceptions enter the generic error path and become 500 rather than a client-correctable 400.
- **Coverage:** Existing batch Zod-guard tests cover write/output guards and transaction rollback; no malformed-preview-row status test was found.
- **Minimal fix:** Validate every preview row before performing transformations and return field-specific 400 details for invalid input.
- **Possible fix task:** T-12.

#### F-25 — A request rejected by the IP quota still consumes device quota

- **Severity:** Low
- **Category:** Rate limiting / error-state integrity
- **Affected paths:** `artifacts/api-server/src/routes/inventory.ts:4104-4119,4131-4135`
- **Scenario and evidence:** Estimate-dimension search checks and consumes the per-device bucket before checking the IP bucket. Once the IP bucket is exhausted, rejected requests continue decrementing a valid device’s quota; another user behind the same busy NAT can then receive a misleading per-device 429.
- **Coverage:** `estimateDimensionsRateLimit.test.ts:146+` covers rejection but not bucket accounting when the IP check rejects after a device hit.
- **Minimal fix:** Check both buckets atomically or ensure a rejected IP check does not commit a device-bucket debit.
- **Possible fix task:** **T-13 — Keep rejected estimate requests from consuming another quota.** Product/area: API Server estimate-dimensions rate limiter. Priority: P3. Acceptance: exhaust only the IP bucket and verify rejected requests do not consume per-device quota; preserve accurate `Retry-After` and 429 messages. No sequencing dependency.

## Fix-task mapping

At the user's request after the report-only audit, all 25 findings now map to 15 project tasks. Existing tasks #1941–#1943 were expanded; #1988–#1999 were created. No product fixes have been made. Priorities are proposed order, not a release certification.

| Task | Findings | Proposed title / existing task | Outcome, product/area, priority | Regression check | Sequencing |
|---|---|---|---|---|---|
| T-01 / #1941 | F-01 | **#1941 — Keep saved part photos when catalog extraction fails to upload replacements** | Preserve old per-slot image references and private objects until a replacement is stored and committed. API Server catalog PDF matching. **P1** | Fail each image upload independently for an item with existing image URLs; assert old URLs/objects remain and successful replacements still commit. | Proposed follow-up; independent. |
| T-02 / #1942 | F-02–F-05 | **#1942 — Prevent orphaned photos and misleading create results when saves fail** | Compensate for partial image uploads, empty DB updates, and failed client rollback; never claim the part was not created when cleanup failed. Parts ID add/edit + API inventory/photo routes. **P1** | Inject partial object success, DB write failure, empty update result, and rollback DELETE 500; assert object cleanup, accurate response/UI state, and no duplicate retry path. | Proposed follow-up; independent; can share storage compensation primitives across the inventory photo routes. |
| T-03 / #1988 | F-06–F-07 | **Bound bulk enrichment failures** | Bound retry attempts and persist/reconcile a terminal job result for `/inventory/bulk-enrich`. API Server. **P1** | Permanently fail an item and assert bounded calls, responsive cancel, terminal status; simulate DB outage through failure persistence and verify restart recovery. | Merged #1939 covered a different description-expansion job. |
| T-04 / #1989 | F-08 | **Recover PDF worker cleanup failures** | Preserve the original cause and ensure job status remains retryable/terminal when catch-path DB persistence or session rollback fails. API Server catalog PDF worker/resume. **P2** | Fail the initial operation plus terminal UPDATE or rollback independently; verify bounded logs, no falsely active status after recovery, and Resume behavior. | Separate from Task #1914’s cancellation/chunk-start race. |
| #1990 | F-09 | **Reconcile cancelled upload parts** | Retry cancelled-session object cleanup without requiring another client request. API Server durable PDF upload. **P2** | Force delete failure after cancellation, then run reconciliation and verify objects/part metadata are removed; repeat cancel remains idempotent. | Reuses cleanup design from the earlier durable-upload plan. |
| #1991 | F-10 | **Isolate staged upload recovery failures** | Isolate unreadable staged parts and recover later sessions without leaving readiness permanently failed. API startup/health. **P2** | Seed a broken completed session before a healthy one; verify healthy recovery proceeds and `/healthz` reaches a deterministic outcome. | Merged #1940 covered schema-outage readiness, not staged-object failure. |
| T-05 / #1992 | F-11 | **Clean failed floor-plan uploads** | Delete newly uploaded private SVGs when metadata persistence fails. API Server floor-plan upload. **P2** | Simulate storage success plus DB failure; assert orphan cleanup and safe retry. | Independent. |
| T-06 + T-14 / #1993 | F-12, F-18–F-19 | **Make snapshot outcomes truthful** | Distinguish pre-commit and post-commit outcomes, classify dry-run operational errors, and return 409 for stale confirmation. API Server snapshots. **P1** | Inject audit/cache errors after commit, dry-run storage/DB failure, and stale confirmation; assert truthful response and no unauthorized mutation. | Coordinate with merged #1904 backup-route repairs. |
| T-07 / #1994 | F-13 | **Unify admin session expiry** | Route raw admin calls through the shared 401 expiry flow and bound potentially hanging requests. Parts ID inbox/audit/map calibration/floor-plan upload/PDF resume. **P2** | Return 401 from each path; assert admin access clears, pending writes stop, manifest behavior is explicit, and 403/5xx remain distinct. | Coordinate with inbox/audit plans and #1943; network-recovery work already covers catalog-review polling and zone loading. |
| T-08 / #1943 | F-14–F-15 | **#1943 — Tell admins when catalog job status checks keep failing** | Bound upload polling on non-401 HTTP/schema failures and show failed-job-list errors without hiding successful review rows. Parts ID catalog screens. **P2** | Persistent 5xx/429 and invalid 2xx status stop endless polling with retry; `/failed-jobs` 500 shows partial-load feedback; transient errors can recover. | Proposed follow-up; do not duplicate the catalog-review 401 portion of `fix-parts-id-network-recovery.md`; this finding is the separate upload poll and no-job failed-list path. |
| T-09 / #1995 | F-16 | **Reject malformed route identifiers** | Require exact identifier parsing before PATCH/DELETE/PUT. API Server zone/map routes. **P1** | Suffix/prefix/decimal/unsafe IDs return 400 and leave target rows unchanged; valid identifiers still work. | Independent. |
| T-10 / #1996 | F-17, F-22 | **Bound admin failure diagnostics** | Redact/bound admin, provider, database, and Clerk errors in logs and client messages. API Server admin/dashboard/AI-status/People & System. **P2** | Inject sentinel sensitive text and assert it is absent from responses/logs while a safe status, request ID, and `clerkDeleted:false` warning remain. | Completed Task #248 addressed `adminQuery` only; coordinate with dashboard/People plans. |
| T-11 / #1997 | F-20–F-21 | **Classify middleware request failures** | Preserve correct client-error semantics for malformed/oversized bodies and expected CORS rejection while keeping unknown errors generic. API Server global middleware. **P3** | Assert malformed JSON 400, oversized body 413, denied origin is not logged/reported as internal 500, and unknown exception remains safe 500. | Independent. |
| T-12 / #1998 | F-23–F-24 | **Validate malformed inventory requests** | Validate barcode path encoding and batch-preview row shape before route work. API Server inventory routes. **P3** | Malformed barcode encoding and preview rows return 400 with no DB writes; valid requests preserve current behavior. | Independent. |
| T-13 / #1999 | F-25 | **Preserve device quota on rejection** | Ensure IP-level rejection does not debit a valid device’s rate-limit bucket. API Server estimate-dimensions search. **P3** | Exhaust the IP quota while using a fresh device identity; assert the request is 429 and the device bucket remains available. | Independent. |

## Existing work, intentional handling, and excluded candidates

- **Existing auth work:** `fix-parts-id-network-recovery.md` explicitly covers catalog-review poll 401/malformed status, inventory sync deadlines, and warehouse-zone 401 retry. Those paths are not proposed again. The verified 401 gaps in F-13 are the remaining raw request paths.
- **Existing admin-screen plans:** `.local/tasks/ux-fix-admin-inbox.md` covers read/retry/row consistency; `.local/tasks/ux-fix-admin-audit-log.md` covers refresh/pagination/exit behavior. Task #1994 covers the remaining 401/deadline paths and should coordinate overlapping screen edits.
- **Existing backup/snapshot work:** Task #1904 has merged and repaired backup API operations/bindings. The current snapshot dry-run, mismatch-status, and post-commit failure paths above remain in the inspected code; Task #1993 groups their repairs.
- **Related job work:** Tasks #1938 and #1939 have merged for whole-database description expansion. F-06/F-07 concern the distinct `/inventory/bulk-enrich` keyword job, now covered by Task #1988.
- **Additional inventory paths inspected:** Width/height filters being omitted from some search/category result logic are functional search-correctness defects, not error-handling findings, and are outside this task. Measurement-enrichment multi-instance coordination and lost-update risks are broader concurrency/state-management concerns and were not promoted. `inventory.ts` additionally contains a malformed barcode status mapping (F-23), malformed preview input handling (F-24), and estimate-rate-limit bucket ordering (F-25).
- **Intentional/best-effort behavior not counted as a new finding:** image cleanup after DB references have already been cleared/deleted; reference-cache invalidation and ANALYZE work; per-item description/measurement enrichment failures that are counted and retryable on a later run; account-deletion cleanup’s documented continue-on-best-effort behavior; and Clerk deletion’s deliberate partial success with `clerkDeleted:false`.
- **Unverified candidates, not counted:** (1) `admin-inbox.tsx` casts a successful response directly to `MessageRow[]`; the current API contract returns an array, and no malformed 2xx response was observed. (2) Some raw fetches lack explicit deadlines; code inspection confirms the absence, but this audit did not establish a reproducible transport hang for every platform call. (3) Gemini reference requests have no route-level AbortSignal/deadline in `reference.ts`/`webSearch.ts`; the shared SDK client config has no explicit timeout, but SDK/provider default behavior was not verified, so no timeout defect is claimed. (4) `ErrorBoundary` does not contain a throwing `onError` callback, but no production call site passes that callback. (5) Admin approve/ban/promote/demote audit inserts are intentionally detached and best-effort (`admin.ts:299-315,341-357,380-401,428-444`); no explicit atomic-audit contract was verified, so audit-row loss is not counted as a product defect. (6) `contact.ts`/`track.ts` limiter exceptions outside route catches and partial user-cleanup failures were not failure-injected; they remain candidates, not findings. (7) Measurement enrichment has process-local concurrency/no explicit cancellation; the potential multi-instance duplicate/lost-update behavior is outside this error-handling audit’s state-management scope and was not promoted.
- **Historical audit findings not repeated:** the prior security report’s admin-query SQL read-only, sensitive-column alias, and raw SQL response findings are separate from the current `adminQuery.ts` path, which returns a stable safe response and logs SQLSTATE. Completed Task #248 addressed the admin-query log/partial-save issue, not the other admin logging locations in F-17.
- **Unavailable paths:** None of the listed source paths was inaccessible. However, the remaining Parts ID callers and selected low-risk API routes in the coverage ledger were inventoried rather than fully traced or failure-injected; the report does not imply complete verification of those paths.

## Validation and tooling signals

- **Failure baseline:** No active tracked failure records were known at audit start.
- **Focused Parts ID tests:** 3 suites, 31 tests passed (`adminInboxWorkflow`, `authGateTimeout`, `catalogReviewResumeStatusErrors`).
- **Focused API tests:** 2 suites, 12 tests passed (`routeHandlerErrorPath`, `catalogPdfAiErrors.integration`). They used the test database and cleaned up the test admin fixture; no production data was accessed.
- **Dependency audit:** `pnpm audit --audit-level=low` exited 1 with two High advisories for `image-size@2.0.2` (ICNS and JXL/HEIF parser denial-of-service). The workspace contains a local parser-safety patch and the application TypeScript/TSX search found no runtime import. This is recorded as a dependency signal, not a verified unmitigated application finding.
- **Typecheck and lint:** `tsc` completed successfully in both standard-tier attempts. ESLint reported zero errors and one warning (`artifacts/parts-id/app/(tabs)/index.tsx:1190`); one run completed lint, while the isolated run timed out during its `dead-exports` substep, so the full lint result was not consistently available.
- **Assigned validation:** `pnpm run test-standard` is the only assigned completion tier. It was attempted twice. The first automatic attempt waited about 926 seconds for the validation lock, then hit its 420-second execution budget during `port-authority-contract` (exit 124). The single-command retry acquired the lock after 156 seconds, then hit the same 420-second execution budget during lint's `dead-exports` substep (exit 124; about 577 seconds total). The standard-tier project/Jest tests were not reached. No standard-tier product test failure was observed; the gate timed out before that step.
- **Other automatic completion checks:** `test-fast` passed. The completion runner also launched `test-standard-plus` and `test-heavy`, although neither was assigned. Both failed at `spec-check-tests`: generated-output inventory reported missing/untracked/stale generated files, and `ensure-codegen.test.ts` failed “does not let a stale owner release a successor's lock” (expected exit 0, received 1). These checks were outside the validation ceiling and no generated files or tests were changed for this report.
- **Not run:** Standard-tier project/Jest tests (blocked by the tier timeout), full API/mobile suites outside focused tests, production probes, destructive/live failure probes, and dependency upgrades. The plan explicitly skipped the expensive backend-suite spot-run because no API code was being changed.

## Report-only boundary

In the original audit phase, only this tracked report was added; no product behavior, tests, runtime data, or configuration was changed. The later user-requested task-planning phase created or expanded project tasks and updated this mapping, but did not implement a fix.

## Follow-up task-planning baseline

Before any repair implementation, `pnpm --filter @workspace/api-server test` ran on 2026-09-27: 122/129 suites and 1,868/1,879 tests passed. Seven suites/11 tests failed in description expansion (3), inventory edit (1), catalog background processing (2), inventory search (1), export cursor (2), total OP/OQ (1), and health schema probe (1). Some failures included PostgreSQL “too many clients already” during concurrent validation; other assertion failures had different signatures. The repair-task plans record these exact pre-existing results so executors can compare failures in isolation rather than assuming a new regression or ignoring unrelated failures. No product code changed during task planning.