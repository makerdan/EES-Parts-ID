# UX E2E — Admin Audit Log

**Journey:** People & System → Audit Log → initial page → load more/refresh/retry → leave  
**Mode:** Report-only  
**Phases:** 0–5, 8, 10–12

## App map and happy path

`app/admin-audit-log.tsx` fetches `/admin/audit-log`, uses `before_id` pagination, merges by row ID, and renders refresh/load-more controls. The current source includes request-version, AbortController, admin-access, and inline load-more error guards. The focused workflow also covers obsolete-request cancellation, refresh supersession, cursor-preserving retry, and screen-reader lifecycle status.

## Persistence and cross-context checks

Rows are server-backed and not locally cached. The rendered workflow verifies two authenticated admin sessions against shared server state: an already-open screen keeps its snapshot until its explicit Refresh action, then updates its count and visible rows with the event created by the other session. The Refresh control announces that boundary through its accessibility hint; there is no background polling or implied live update.

## Failure, retry, navigation, accessibility

Initial failure has Retry. Later-page failure keeps the current list and shows an inline retry in the current source. Row IDs are deliberately shortened for display, with full values available to screen readers and compact copy buttons for both administrator and target IDs.

## Findings

### Resolved

#### F-085 · Admin audit log long identifiers · Phase 12 (Cross-context)

The compact row preserves truncated visual IDs while exposing the full administrator and target values through screen-reader labels and copy controls. Copy success and failure are announced in the row.

## Seed/context

Request cancellation, loaded-event preservation, pagination retry correctness, refresh supersession, and lifecycle accessibility are covered by the consolidated rendered workflow. No duplicate findings are recorded for those behaviors.

## [MANUAL QA NEEDED]

- High-volume pagination and duplicate-free retry on web/native.
- Copy/detail interaction and screen-reader reading of full IDs.

## Report-only stop

The cross-session freshness check is covered by the rendered admin audit-log workflow. Background cross-tab synchronization remains out of scope; admins are given an explicit refresh boundary instead.
