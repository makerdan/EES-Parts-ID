# UX E2E — Admin Audit Log

**Journey:** People & System → Audit Log → initial page → load more/refresh/retry → leave  
**Mode:** Report-only  
**Phases:** 0–5, 8, 10–12

## App map and happy path

`app/admin-audit-log.tsx` fetches `/admin/audit-log`, uses `before_id` pagination, merges by row ID, and renders refresh/load-more controls. The current source includes request-version, AbortController, admin-access, and inline load-more error guards.

## Persistence and cross-context checks

Rows are server-backed and not locally cached. Refresh/pagination lifecycle work is owned by Task 1171 and its follow-ups; this report treats that work as seed context. `[MANUAL QA NEEDED]` verify that two admin sessions do not present stale counts after another session adds an event.

## Failure, retry, navigation, accessibility

Initial failure has Retry. Later-page failure keeps the current list and shows an inline retry in the current source. Row IDs are deliberately shortened for display.

## Findings

### LOW

#### F-085 · Admin audit log long identifiers · Phase 12 (Cross-context)

**Failure:** `adminClerkUserId` and `targetClerkUserId` are truncated to 14 characters with no detail view, copy action, or accessible full value. For two similar IDs, an admin cannot reliably identify the actor or target from the audit evidence.

**Fix:** `app/admin-audit-log.tsx` `AuditItem` — expose the full IDs through a copyable detail action or accessible label/value, while retaining truncation only for the visual row.

## Seed/context

Task 1171 and follow-ups #1178/#1179 own request cancellation, loaded-event preservation, and pagination retry correctness. No duplicate findings are recorded for those behaviors.

## [MANUAL QA NEEDED]

- High-volume pagination and duplicate-free retry on web/native.
- Copy/detail interaction and screen-reader reading of full IDs.
- Cross-tab freshness after a new admin action.

## Report-only stop

No fix or test change was made.
