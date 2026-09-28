# Bug & Error Audit Report — Parts ID State Management

**Scope:** State-management correctness in the Parts ID mobile/web app, API operations that persist or return the same state, and directly related client/cache utilities. Focused on stale visible state, asynchronous publication, authentication/session transitions, offline caches, upload drafts, and concurrent saves.
**Mode:** report-only
**Date:** 2026-09-24
**Stack:** TypeScript, React Native/Expo, React, TanStack Query, AsyncStorage, Express, PostgreSQL/Drizzle, Jest, pnpm.
**Audit method:** Read-only source, test, task, and prior-report review. No runtime probes or behavior changes.

The canonical Bug Audit skill could not be located in the available skill sources or skill search. This report follows the structure of the tracked Parts ID/API bug-audit report and records that limitation rather than treating another audit skill as a substitute.

## Summary

Five current state-management defects were verified: two High and three Medium. Two additional timing concerns remain candidates, not verified findings, and are not included in the severity count. The inspected edit/save, draft, map-focus, API-status, and upload-session recovery paths had no other verified in-scope defect.

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 2 |
| Medium | 3 |
| Low | 0 |

| # | Severity | Category | File:Line | One-line description |
|---|---|---|---|---|
| 1 | High | Async & stale state | `artifacts/parts-id/app/(tabs)/index.tsx:1092-1113` | Search reset leaves the active result query intact and does not invalidate a request that can publish after reset. |
| 2 | High | API/client state contract | `artifacts/parts-id/components/CatalogPdfUpload.tsx:84-109,456-479`; `artifacts/parts-id/app/catalog-review.tsx:326-347,400-459` | Both catalog screens treat the server’s `done_with_errors` terminal status as still processing. |
| 3 | Medium | Concurrency & persisted state | `artifacts/api-server/src/routes/catalogPdf.ts:1030-1049,597-628,167-185` | Concurrent cancellation and worker finalization can overwrite each other’s terminal job status. |
| 4 | Medium | Offline cache correctness | `artifacts/parts-id/utils/searchHelpers.ts:17-70`; `artifacts/parts-id/app/(tabs)/index.tsx:791-813,914-920` | Durable exact-search cache keys omit the selected category slug, allowing offline results from another category to be reused. |
| 5 | Medium | Async & auth-scoped settings | `artifacts/parts-id/contexts/AppContext.tsx:600-646` | One failed admin-profile fetch permanently suppresses profile sync retries for the rest of that admin session. |

## Findings

### Finding 1 — Search reset can retain or resurrect the previous results

- **File and line:** `artifacts/parts-id/app/(tabs)/index.tsx:1092-1113`
- **Related implementation:** `:363-365`, `:874-883`, `:1283-1293`
- **Category:** Async & stale state
- **Severity:** High
- **Affected platforms:** Parts ID mobile and web Search screen.
- **Classification:** Confirmed application defect.
- **Failure scenario:** A user submits a search and then taps “New Search” or taps the already-focused Search tab to reset. Filters and local result state are cleared, but the active TanStack Query result is not. The screen reads results directly from that query at `:1283-1293`, so old cards can remain visible under the reset filters. If a request is still pending, `handleClear` also leaves the request generation/current-request reference unchanged; its later success can pass `isCurrentSearch` and republish the old results.
- **Evidence:** `handleClear` calls the mutation reset and clears local state, but does not clear `SEARCH_RESULTS_QUERY_KEY`, advance `searchGenerationRef`, or null `searchRequestRef`. By contrast, logout explicitly clears the active query and invalidates generations at `:423-429`, and a new search clears active results at `:1067-1069`. `publishSearchSuccess` publishes to that same active query at `:874-883`.
- **Safeguards and tests:** The generation guard itself is present. `artifacts/parts-id/__tests__/searchTabCacheRaces.test.ts` exercises generation behavior in a self-contained harness, but it does not drive the real Search screen’s clear/reset path. Existing proposed task #1766 covers mounted overlapping searches, not resetting while results or an in-flight request exist.
- **Recommended fix:** Make reset invalidate the active visible query and the current request generation before resetting local search state. Ensure any request that began before reset cannot publish visible or durable data.
- **Possible repair task:** **ST-1 — Clear Search Without Old Results** (Priority: P1). See [Possible repair tasks](#possible-repair-tasks).

### Finding 2 — `done_with_errors` leaves catalog screens polling as if work were still running

- **Files and lines:** `artifacts/parts-id/components/CatalogPdfUpload.tsx:84-109,456-479`; `artifacts/parts-id/app/catalog-review.tsx:326-347,400-459`
- **Related server implementation:** `artifacts/api-server/src/routes/catalogPdf.ts:607-619,1124-1133,1158-1205`
- **Category:** API/client state contract; async lifecycle
- **Severity:** High
- **Affected platforms:** Parts ID mobile and web catalog upload/review screens.
- **Classification:** Confirmed application defect.
- **Failure scenario:** A catalog extraction completes its page work but an image upload fails. The server records the terminal status `done_with_errors` while retaining successful description/inventory writes. `CatalogPdfUpload` rejects that response in `JobStatusSchema.safeParse`, warns about an unexpected status, leaves its previous visible status unchanged, and polls again. The review screen likewise treats any status other than `done`, `failed`, or `cancelled` as active and continues polling. The user can be left with a perpetually processing job, and the newly written inventory/search data is not invalidated on this partial-success path.
- **Evidence:** The client status type and Zod enum accept only `pending`, `processing`, `done`, `failed`, and `cancelled`. The upload poller exits only for `done`, `failed`, and `cancelled`, and invalidates inventory/list and search caches only for `done`. The review bootstrap and poller use the same incomplete terminal set and only invalidate caches on `done`. The server sets `done_with_errors` after processing when image upload fails (`:607-619`), aggregates that status for parent jobs (`:1124-1133`), and returns it directly or as the parent status (`:1158-1205`).
- **Safeguards and tests:** Normal `done`, `failed`, and `cancelled` upload states have screen tests in `catalogPdfUploadReset.test.tsx` and `catalogPdfUploadE2E.test.tsx`; no `done_with_errors` fixture or cache-reconciliation assertion was found in those suites. API task #116 (merged) fixed parent aggregation of partial errors, but its stated scope did not change client status handling or terminal-write races. The earlier UX audit’s F-017 cache invalidation path is present for ordinary `done`, but does not cover partial completion.
- **Recommended fix:** Treat `done_with_errors` as a terminal status in both clients, expose the partial outcome instead of leaving the prior processing state, and reconcile inventory/list/search caches when successful writes may have occurred.
- **Possible repair task:** **ST-4 — Explain Partial Catalog Completion** (Priority: P1). See [Possible repair tasks](#possible-repair-tasks).

### Finding 3 — Catalog PDF cancellation races with unconditional worker finalization

- **File and line:** `artifacts/api-server/src/routes/catalogPdf.ts:1030-1049`
- **Related implementation:** `:597-628`, `:167-185`
- **Category:** Concurrency & persisted state
- **Severity:** Medium
- **Affected platforms:** Parts ID clients using server-backed Catalog PDF jobs.
- **Classification:** Confirmed race in terminal-state transition logic; the specific interleaving was source-verified but not runtime-reproduced.
- **Failure scenario:** The cancel endpoint reads a `pending`/`processing` job, then updates the parent to `cancelled` without a status predicate. A worker that already passed its page-level cancellation check can subsequently write `done`/`done_with_errors` to its child and call parent finalization. The finalizer updates a parent whose status is `cancelled` because its terminal guard excludes `done`, `done_with_errors`, and `failed`, but not `cancelled`. The inverse interleaving is also possible: a worker may finish after the cancel route’s initial read, while the route’s unconditional parent update still changes the completed job to `cancelled`.
- **Evidence:** The cancel route performs a status read/check at `:1030-1035`, then writes parent status unconditionally at `:1037-1040`. Worker completion writes terminal child status at `:607-619` and calls parent finalization at `:626-628`. The finalizer’s `WHERE` permits replacing a `cancelled` parent (`:181-184`). The cancellation branch at `:597-604` records `finishedAt`, relying on the route’s status update.
- **Safeguards and tests:** Each processing page checks cancellation, and cancellation cascades to pending/processing children. `catalogPdfResumeChunkedEdgeCases.integration.test.ts:339-401` verifies immediate cascade and terminal-child preservation, but does not hold a worker at the completion boundary while cancellation/finalization race. Merged task #116 changed status aggregation and cancellation polling; it explicitly left other status transitions/finalization out of scope.
- **Recommended fix:** Make cancellation and worker finalization conditional state transitions that cannot replace a terminal status owned by the competing operation; preserve the intended cancellation invariant through parent aggregation.
- **Possible repair task:** **ST-5 — Keep Catalog Cancellation Outcomes Stable** (Priority: P2). Its regression plan should include deterministic API interleavings for both cancellation-before-finish and finish-before-cancellation.

### Finding 4 — Category slug is omitted from exact offline-search cache identity

- **File and line:** `artifacts/parts-id/utils/searchHelpers.ts:17-70`
- **Related callers:** `artifacts/parts-id/app/(tabs)/index.tsx:791-813,914-920,1192-1232`
- **Category:** Offline cache correctness
- **Severity:** Medium
- **Affected platforms:** Parts ID mobile and web when using the exact durable query cache.
- **Classification:** Confirmed application defect.
- **Failure scenario:** A user browses category A while online, then selects category B with the same filter values while offline or after a network timeout. The exact-cache fallback can return category A’s saved results as category B’s result set. A category search and a non-category search with the same filter values can also collide.
- **Evidence:** `buildSearchBody` supports `categorySlug`, but `buildQueryKey` accepts only the filters and serializes `buildSearchBody(f)` without the slug. Category selection passes the slug to the server request, while success persistence and offline fallback both compute keys from filters alone. `resolveOfflineFallback` treats an exact key match as authoritative.
- **Safeguards and tests:** Cache TTL pruning, bounded LRU storage, serialized cache writes, and request-generation checks are present. `searchIndexHelpers.test.ts` covers filter-key differentiation, but the key builder does not accept a category slug and no category-key differentiation test exists. Proposed task #1766 is about overlapping request publication and does not cover this durable-key identity defect.
- **Recommended fix:** Include the effective category slug in both durable cache writes and lookups, with an explicit compatibility or invalidation strategy for old entries.
- **Possible repair task:** **ST-2 — Keep Offline Search Category-Specific** (Priority: P2).

### Finding 5 — Failed admin-profile hydration disables retries for the rest of the session

- **File and line:** `artifacts/parts-id/contexts/AppContext.tsx:600-646`
- **Related server endpoint:** `artifacts/api-server/src/routes/admin.ts:54-85`
- **Category:** Async & auth-scoped settings
- **Severity:** Medium
- **Affected platforms:** Parts ID mobile and web for admin users.
- **Classification:** Confirmed application defect.
- **Failure scenario:** An admin starts the app with local settings while the `/admin/profile` request fails transiently, or token retrieval returns no token for that attempt. `adminProfileSyncedRef` has already been set to `true`, and the effect depends only on `isAdmin`; foreground refreshes and restored connectivity do not retry the profile fetch while the user remains an admin. The session can therefore keep settings that differ from the server profile until admin status transitions away and back or the app remounts.
- **Evidence:** The guard is set before token retrieval/fetch at `:609-620`. Fetch errors are logged at `:631-634`, but the guard is not reset; it is reset only when `isAdmin` becomes false at `:603-607`. The effect dependency list is `[isAdmin]` at `:646`.
- **Safeguards and tests:** The request has auth-epoch, abort, and mount checks. The separate settings-PUT path retries failed writes on foreground, but that does not retry this initial GET. No AppContext regression test was found for failed profile GET followed by recovery.
- **Recommended fix:** Mark profile hydration complete only after a successful response, or reset the guard on recoverable failure and add a bounded retry/foreground retry path while the same authenticated admin session remains current.
- **Possible repair task:** **ST-3 — Retry Admin Settings After Failure** (Priority: P2). See [Possible repair tasks](#possible-repair-tasks).

## Unverified candidates

These concerns were not counted as findings because the relevant timing path was not reproduced or established by a focused test.

1. **Rapid admin profile PUT ordering:** `AppContext.tsx:691-715` aborts the preceding request and suppresses stale client completion, while `api-server/src/routes/admin.ts:87-125` performs an unconditional full-profile upsert without a revision field. A stale last server write is plausible if an already-dispatched aborted request is applied after a newer PUT, but source inspection alone did not establish request arrival/commit order. No profile-write concurrency test was found. ST-2 should reproduce this before adding server-side ordering/version semantics.
2. **Search preference hydration can overwrite an early toggle:** `app/(tabs)/index.tsx:225-248` asynchronously loads `includeNullDimensions` and applies the stored value after the screen becomes interactive. If a user changes the toggle before a slow storage read resolves, that late hydration can replace the user’s choice. No delayed-storage screen test or runtime reproduction was performed; verify this in the same Search regression work before treating it as a separate confirmed defect.

## Scope and coverage inventory

| Area inspected | State boundaries and evidence reviewed | Result |
|---|---|---|
| Search submit, reset, category selection, visible query state | `app/(tabs)/index.tsx`; `searchResetEvent`; `searchTabCacheRaces.test.ts` | Findings 1 and 4. Existing generation guards cover newer requests, not reset invalidation or category cache identity. |
| Exact-query, Fuse/offline cache and search history | `utils/searchHelpers.ts`, `offlineBarcode.ts`, `queryCacheBound.ts`, `searchHistory.ts`, and Search cache read/write locks | Finding 4. No separate verified lost-write or unbounded-cache defect; cache writes are serialized and bounded. |
| Search filter preference hydration | `app/(tabs)/index.tsx:225-248` | Unverified candidate 2; no other preference persistence defect confirmed. |
| Auth, admin role, settings hydration, profile writes, logout | `contexts/AppContext.tsx`; `api-server/src/routes/admin.ts`; `logoutStorageClear` and settings tests | Finding 5. Rapid PUT ordering remains unverified candidate 1. Auth-epoch checks, abort cleanup, and logout storage clearing were present. |
| PartDetailsEditor save, multi-field reconciliation, cache rollback | `components/PartDetailsEditor.tsx`, `utils/sharedPartSaveCoordinator.ts`, `utils/editItemCache.ts`; `sharedPartSaveCoordinator.test.ts`, editor save tests | No verified defect. The coordinator pairs settled writes to fields and restores failed optimistic fields; tests cover out-of-order completion and partial retry. |
| Inventory write persistence | `api-server/src/routes/inventory.ts`; `api-server/__tests__/inventoryEdit.integration.test.ts` | No verified defect. DB-backed tests read back description, bins, keywords, order, dimensions, and photo-slot state; the multi-field persistence test is sequential, not a concurrent-ordering proof. |
| Durable import drafts and session/logout clearing | `utils/importDraftStorage.ts`, logout storage helpers and their tests | No verified defect. Per-user serialization, validation/expiry, encrypted web storage, and logout deletion guards were present. |
| Map and cross-screen pending focus | map tab focus consumption, map cache/lifecycle tests, and associated state utilities | No verified stale-focus or cross-screen publication defect found in inspected paths. |
| API health/status hook | `hooks/useApiStatus.ts` and `useApiStatus.test.ts` | No verified defect. Request generations, abort cleanup, and restart/recovery state guards are present. |
| Catalog PDF upload, review, polling, cancellation, restart recovery | `components/CatalogPdfUpload.tsx`, `app/catalog-review.tsx`, `api-server/src/routes/catalogPdf.ts`, upload-session route/recovery, related API and Parts ID tests | Findings 2 and 3. Upload-session ownership, row locking/idempotent completion, and startup recovery were present; partial terminal client state and cancellation/finalization ordering remain defective. |

## Prior findings and existing task comparison

- The earlier React render/memory audit’s catalog-review bootstrap and status-poll findings (R-001/R-002) are resolved in current source: `catalog-review.tsx:224-241` aborts work on lifecycle/token changes, `:243-368` guards post-await publication, and `:388-407` guards/aborts each poll. Its upload AI-status finding (R-003) is also resolved: `app/(tabs)/upload.tsx:922-1001,1094-1159` uses generation and abort guards, with cleanup at `:1283-1311,1653-1660`. They are not counted again.
- The prior UX audit’s response-check fix for Catalog PDF resume requests is present at `catalog-review.tsx:610-620,733-743,778-779`. Its ordinary `done` cache invalidation is also present at `:448-458`; the remaining gap is specifically the server’s `done_with_errors` state.
- The earlier Parts ID/API failure audit’s upload mock/poll/reset findings were test-harness findings and are not presented here as product-state bugs. This audit did not assume its earlier “catalog lifecycle passed” observation ruled out the cancellation/status races found here.
- Existing task #1741 (merged) covers edit-save/cache consistency and latest-request-wins safeguards; it does not implement Search reset clearing or category-aware durable cache identity. Existing task #1766 (proposed) covers a mounted overlapping-search regression proof; it does not cover the reset path or category cache-key collision. Existing task #116 (merged) covers server parent aggregation of `done_with_errors` and cancellation polling frequency; its recorded scope does not cover client terminal-status handling or terminal-write fencing. No pre-existing proposed or active task found in the task searches duplicates the verified repair work below. Following the user's request, the five findings are now represented by separate proposed tasks #1908–#1912; none is approved or started.

## Possible repair tasks

These are recommendations only. Tasks #1908–#1912 are separate proposals, one for each verified finding. They are drafts for review, not approved implementation work. No repair has started.

### ST-1 — Clear Search Without Old Results (proposed task #1908)

- **Finding:** 1.
- **Intended outcome:** Clearing Search immediately removes old visible results and prevents pre-reset requests from restoring stale visible or durable results.
- **Priority:** P1.
- **Affected area:** Parts ID Search screen and active result query.
- **Regression checks:** Mounted-screen reset after completed and pending searches; prove a late completion cannot republish results after reset.
- **Dependencies:** None. Keep distinct from task #1766, which covers overlapping searches rather than reset.

### ST-2 — Keep Offline Search Category-Specific (proposed task #1911)

- **Finding:** 4.
- **Intended outcome:** Exact offline Search cache entries are isolated by category, so results for one category or a general search cannot appear under another category.
- **Priority:** P2.
- **Affected area:** Parts ID Search cache-key construction, online cache writes, and offline exact-cache reads.
- **Regression checks:** Cache category A online, then request category B offline with identical filters; assert distinct keys and no cross-category fallback. Cover category-to-general lookup and old key compatibility.
- **Dependencies:** None.

### ST-3 — Retry Admin Settings After Failure (proposed task #1909)

- **Finding:** 5.
- **Intended outcome:** A recoverable admin-profile GET failure does not permanently disable server-profile hydration for the current authenticated admin session.
- **Priority:** P2.
- **Affected area:** Parts ID admin-profile hydration in `AppContext`.
- **Regression checks:** Fail the first profile GET, restore connectivity, and prove a bounded retry applies the server profile without demotion or remount; retain auth-change and stale-response guards.
- **Dependencies:** None for the verified GET defect. Do not change rapid PUT ordering unless the unverified candidate is reproduced and separately reviewed.

### ST-4 — Explain Partial Catalog Completion (proposed task #1910)

- **Finding:** 2.
- **Intended outcome:** Both catalog screens treat `done_with_errors` as terminal, stop polling, explain partial completion, and reconcile inventory/Search caches after successful writes.
- **Priority:** P1.
- **Affected area:** Parts ID CatalogPdfUpload and CatalogReview screens and their cache reconciliation.
- **Regression checks:** Client tests for partial terminal status, poll stop, user-visible result, and cache invalidation on both screens.
- **Dependencies:** Preserve the existing API status and merged task #116 parent aggregation behavior.

### ST-5 — Keep Catalog Cancellation Outcomes Stable (proposed task #1912)

- **Finding:** 3.
- **Intended outcome:** Cancellation and worker finalization cannot replace one another's accepted terminal status; all-cancelled children remain cancelled at the parent.
- **Priority:** P2.
- **Affected area:** API Catalog PDF cancellation, worker finalization, and parent aggregation.
- **Regression checks:** Deterministic API interleavings for cancellation-before-finish and finish-before-cancellation; verify terminal status remains stable after child loops settle.
- **Dependencies:** None.

## Validation signals, exclusions, and limitations

- **Failure baseline:** `docs/validation/failure-baseline.json` had no active baseline records at audit start. Any failure from the assigned validation remains a candidate and must not be dismissed using historical reports alone.
- **Assigned audit validation:** The original audit plan specified exactly `test-fast`. Its completion callback unexpectedly invoked `test-fast`, `test-standard`, `test-standard-plus`, and `test-heavy`; all four stopped at the same `public-repository-boundary` step, so no later tier steps ran.
- **Follow-up task-split validation:** After the five-task split, exactly `test-fast` was run. It again failed at `scripts/test/public-repository-boundary.test.mjs`, which reports that provider-retained pull-request refs are absent. Three isolated retries of that check failed identically. The failing checker and its direct inputs were untouched; current working-tree changes are limited to the tracked audit report and two tracked task-plan documents. This matches the documented normal-clone limitation in `.agents/memory/github-pull-refs-history.md`, so the failure is self-classified as pre-existing/environmental, not caused by the task split. The required `test-fast` validation did not pass.
- **Typecheck, lint, and focused product tests:** These checks did not run because the fast tier stopped at the history-completeness gate. Relevant existing test files and their coverage boundaries are listed above; their source was inspected but not represented as a fresh passing run.
- **Dependency signal:** No dependency audit was run. No package, dependency, or package configuration was changed or implicated by the verified findings.
- **Not performed:** No production/deployment testing, production database access, runtime-data mutation, test/mock/configuration change, generated-code update, dependency change, or broad ten-category audit.
- **Report-only boundary:** The audit changed no production code, tests, runtime data, or configuration. The later task split changed only the five proposed task descriptions and added two tracked task-plan documents; no repair implementation has started.