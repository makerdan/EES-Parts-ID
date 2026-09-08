# UX E2E — Admin AI Answer Log

**Journey:** People & System → AI Log → load/expand/refresh → logout or return  
**Mode:** Report-only  
**Phases:** 0–5, 8, 10–12

## App map and happy path

`app/ai-log.tsx` fetches `/reference/ask-log`, renders the last 100 Q&A rows, and expands an answer in place. The route redirects non-admins through `shouldRedirectNonAdmin`.

## Persistence and cross-context checks

Log rows live only in component state. The route has no local cache, cursor, filter, export, or clear operation. `[MANUAL QA NEEDED]` verify privacy when an admin logs out while the request is pending and when two admin sessions use the route.

## Failure, retry, navigation, accessibility

Initial load and full refresh have Retry. The request is not abortable and has no generation/mounted guard. Refresh errors replace the list. Expandable rows use a bare Pressable.

## Findings

### HIGH

#### F-086 · Admin AI log session lifecycle · Phase 3 (Silent Failure)

**Failure:** `fetchLog` has no AbortController, request generation, or mounted/session-token guard. A response from the previous admin token can resolve after logout or a new session fetch and overwrite `rows`, allowing stale prior-session evidence to appear in the current screen.

**Fix:** `app/ai-log.tsx` `fetchLog` and lifecycle effects — abort on unmount/admin-token change, gate every state update by request generation and current admin access, and clear rows when the identity boundary changes.

### MEDIUM

#### F-087 · Admin AI log refresh · Phase 3 (Silent Failure)

**Failure:** A failed pull-to-refresh sets the full-screen `error` state and hides already-loaded answers. The admin cannot inspect the last known evidence or distinguish stale data from an empty log.

**Fix:** `app/ai-log.tsx` render and `fetchLog` — keep loaded rows visible during refresh errors, add an inline stale banner and Retry, and reserve the full error state for the initial empty load.

#### F-088 · Admin AI log high-volume browsing · Phase 10 (UI Feedback)

**Failure:** The screen promises only “Last 100 questions” and provides no pagination, filter, export, or clear/search affordance. An admin investigating an older or specific support answer cannot find it and receives no explanation of the retention boundary.

**Fix:** `app/ai-log.tsx` plus the log route contract — add bounded pagination and a query/filter path, or make the retention boundary and export/diagnostic handoff explicit; keep the protected route and privacy limits intact.

### LOW

#### F-089 · Admin AI log expandable rows · Phase 12 (Accessibility)

**Failure:** A log row has no explicit accessible label or `accessibilityState.expanded`; the answer’s visibility change is not announced.

**Fix:** `app/ai-log.tsx` `LogItem` — label each row with question, match count, timestamp, and expand/collapse action; expose expanded state and preserve keyboard activation.

## Seed/context

The protected route boundary is owned by Task 1002. This report covers the post-entry lifecycle and browsing experience only.

## [MANUAL QA NEEDED]

- Logout/token replacement while fetch and refresh are pending.
- More than 100 records, long questions/answers, narrow layout, font scale.
- Screen-reader expansion and privacy confirmation across two sessions.

## Report-only stop

No fix or test change was made.
