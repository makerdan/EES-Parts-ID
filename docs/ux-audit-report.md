# UX E2E Audit — Admin Data-Entry
**Mode:** Report-only
**Scope:** J1 Add Part · J2 Edit Part · J3 Bulk Shelf · J4 Catalog PDF
**Phases covered:** 0–5, 8, 10–12
**Phase gates:** Phase 6 skipped (no keyboard shortcuts in admin flows). Phase 7 skipped (multi-tool applies to map/photo, not admin data-entry). Phase 9 deferred (shared auth infrastructure).

## Summary
| Severity | Count |
|---|---|
| High | 5 |
| Medium | 13 |
| Low | 5 |
| Total | 23 |

## Findings

### HIGH

F-001 · J4 Catalog PDF review · Phase 3 (Silent Failure)
Failure: The progress bar spins indefinitely when a job stalls or the network drops.
The poll loop logs errors silently; the admin never sees a failure state.
Fix: catalog-review.tsx:293-330 — count consecutive failures; after threshold set a
visible error card with Retry.

F-002 · J4 Catalog PDF review (deep-link) · Phase 5 (Navigation)
Failure: /catalog-review?jobId=N with a still-processing job fetches status once,
shows "No items to review" immediately, and never polls. Admin thinks import failed.
Fix: catalog-review.tsx:218-286 — start the poll loop on mount when job is non-terminal.

F-003 · J4 Catalog PDF review · Phase 1 (Happy Path)
Failure: There is no Approve action. Approval is implicit; admins cannot confirm
they have reviewed and accepted items. No approve-all, no completion summary.
Fix: catalog-review.tsx:615-654 — add per-item Approve + Approve All footer;
track approvedIds; show summary card on completion.

F-004 · J4 Catalog PDF cancel/revert · Phase 3 (Silent Failure — backend)
Failure: Cancel and revert API handlers have no try/catch on DB operations.
DB failure hangs the request. Client cancel spinner clears silently; admin believes
job is cancelled when it is not.
Fix: catalogPdf.ts:888-928 and 1423-1492 — wrap DB ops in try/catch, return structured
JSON errors. CatalogPdfUpload.tsx:480-484 — show toast on cancel failure.

F-005 · J3 Bulk shelf (both flows) · Phase 1 (Happy Path)
Failure: Two separate bulk-shelf flows (BarcodeAddPart / BulkShelfAssign) are
reachable from the same Admin tab with different UX and different session keys.
Starting one flow while the other has an active session silently discards it.
Fix: Cross-session warning on mount; distinct section labels in upload.tsx.

### MEDIUM

F-006 · J2 Edit part (KeywordEditor) · Phase 3 (Silent Failure)
Failure: Done button closes KeywordEditor while keyword saves are still in-flight
(void performSaveForId). Admin exits believing keywords saved when they may not be.
Fix: KeywordEditor.tsx:337-345 — disable Done while any item is saving.

F-007 · J2 Edit part (PartDetailsEditor) · Phase 4 (Error & Edge Case)
Failure: Dimension quick-confirm sets fields optimistically; on PATCH failure leaves
stale un-persisted values displayed. Reload shows old data with no error.
Fix: PartDetailsEditor.tsx:247-279 — snapshot + restore on failure (match :437-445).

F-008 · J4 Catalog PDF review (deep-link) · Phase 3 (Silent Failure)
Failure: 4xx/5xx from job-status fetch on deep-link sets no error state. Screen
shows "No items to review" — indistinguishable from a real empty result.
Fix: catalog-review.tsx:252-275 — set visible error state on non-ok response.

F-009 · J4 Catalog PDF review · Phase 5 (Navigation)
Failure: After all items are reverted, screen shows "All reverted" but offers no
next step — no summary, no Done CTA, no auto-navigation.
Fix: catalog-review.tsx:629-1109 — show completion summary card with Done CTA.

F-010 · J4 Catalog PDF upload · Phase 2 (State & Persistence)
Failure: Navigating away during an active upload loses polling state. Returning
to the tab shows no indication a job is in flight.
Fix: CatalogPdfUpload.tsx:405-410 — persist jobId to AsyncStorage on creation;
restore and resume polling on mount.

F-011 · J3 Bulk shelf assignment · Phase 4 (Error & Edge Case)
Failure: When all items fail, admin sees individual toasts but no aggregate error
state, no retry-all, and no terminal state. Session stays open indefinitely.
Fix: BulkShelfAssign.tsx:305-324 — detect all-fail; show aggregate error card with Retry All.

F-012 · J3 Bulk shelf assignment · Phase 2 (State & Persistence)
Failure: Two flows use different AsyncStorage keys. Active session in one flow is
invisible to the other; in-progress work lost silently on switch.
Fix: On mount, read both keys and warn admin if the other flow has an active session.

F-013 · J3 Bulk shelf (BarcodeAddPart legacy) · Phase 10 (UI Feedback)
Failure: Individual assignment failure clears the scanned code and shows a generic
alert with no row-level error and no per-item retry.
Fix: BarcodeAddPart.tsx:462-495 — retain failed item in queue with error state and Retry.

F-014 · J3 Bulk shelf assignment · Phase 3 (Silent Failure)
Failure: loadShelfSession().then() and loadBulkSession().then() have no .catch().
AsyncStorage throw leaves sessionChecked false; modal stuck in loading gate forever.
Fix: Add .catch(() => setSessionChecked(true)) to both session-load calls.

F-015 · J3 Bulk shelf assignment · Phase 3 (Silent Failure)
Failure: saveBulkSession() called without await or .catch. Storage write failure
is silent; admin's session lost on app restart with no warning.
Fix: BulkShelfAssign.tsx:302 — await with try/catch; toast on failure.

F-016 · J4 Catalog PDF (large-job / 409 paths) · Phase 3 (Silent Failure)
Failure: catalog-review.tsx:440-446 and 549-555 parse response JSON without checking
response.ok. 4xx/5xx body parsed as data; shows "No resumable chunks found" instead
of the real error.
Fix: Add response.ok checks at both sites before parsing JSON.

F-017 · J1/J4 Add part / Catalog PDF import · Phase 11 (Data Lifecycle)
Failure: Inventory/search query cache not invalidated after catalog PDF import
completes. Newly imported parts invisible until manual refresh.
Fix: catalog-review.tsx:318-322 — invalidateQueries(['searchInventory'], ['listInventory'])
on terminal success.

F-018 · J1 Add part (CSV upload) · Phase 11 (Data Lifecycle)
Failure: CSV upsert loop has no DB transaction. Mid-loop failure returns 500 but
prior rows are already committed. Admin sees failure while inventory is partial.
Fix: adminUpload.ts:382-413 — wrap loop in db.transaction() for atomic all-or-nothing.

### LOW

F-019 · J2 Edit part (PartDetailsEditor) · Phase 4 (Error & Edge Case)
Failure: Dimension quick-save has no in-flight guard. Rapid confirms dispatch
concurrent PATCHes producing spurious error toasts.
Fix: PartDetailsEditor.tsx:247 — add dimensionSaving guard; disable confirm while saving.

F-020 · J1 Add part (AddPartModal) · Phase 4 (Error & Edge Case)
Failure: AddPartModal handleSubmit has no if(loading)return guard. Race-condition
window for programmatic double-submission.
Fix: AddPartModal.tsx:109 — add if (loading) return; as first statement.

F-021 · J4 Catalog PDF review · Phase 5 (Navigation)
Failure: "Add extracted item" modal has no backdrop-tap dismissal on web/iOS.
Missing one of the three required close mechanisms.
Fix: catalog-review.tsx:763-773 — add backdrop Pressable with onPress to close.

F-022 · J3 Bulk shelf assignment · Phase 10 (UI Feedback)
Failure: Rapid failures fire multiple showToast calls without deduplication,
stacking identical "Assignment failed" toasts.
Fix: BulkShelfAssign.tsx — track last toast + timestamp; suppress same message
within 2 s.

F-023 · J4 Catalog PDF upload · Phase 3 (Silent Failure)
Failure: Cancel-request failure caught silently (empty catch). Admin believes job
cancelled when server may not have processed the cancel.
Fix: CatalogPdfUpload.tsx:480-484 — toast "Cancel request failed — job may still be running."
(Requires F-004 for full resolution.)

## Prior Audit Reports
No bug-audit-report.md or ux-audit-report.md found in repository root or docs/
prior to this run.
