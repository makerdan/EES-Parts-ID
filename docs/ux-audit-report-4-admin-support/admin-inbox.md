# UX E2E — Admin Inbox

**Journey:** People & System → Inbox → load messages → expand/mark read → refresh/retry  
**Mode:** Report-only  
**Phases:** 0–5, 8, 10–12

## App map and happy path

`app/admin-inbox.tsx` loads `/contact`, renders a FlatList, expands a message, and PATCHes `/contact/:id/read`. Failed read writes already expose a row-level Retry/Dismiss state.

## Persistence and cross-context checks

Read state is server-backed; the list is local screen state and is not cached. The route redirects non-admins through `shouldRedirectNonAdmin`. `[MANUAL QA NEEDED]` check two tabs and a second admin session for read-count freshness.

## Failure, retry, navigation, accessibility

Initial fetch has loading/error/Retry/empty states. Refresh errors set `error` and therefore replace the list even when rows were previously loaded. Rows are pressable but do not expose expanded state.

## Findings

### MEDIUM

#### F-083 · Admin inbox refresh · Phase 3 (Silent Failure)

**Failure:** A failed refresh calls `setError`, and the render branch replaces the loaded FlatList with a centered error screen. The admin loses access to already-loaded messages while retrying, even though the server’s failure affected only the refresh.

**Fix:** `app/admin-inbox.tsx` `fetchMessages` and render branch — preserve `rows` when a refresh fails, show an inline stale-refresh error with Retry, and keep the last unread count visible.

### LOW

#### F-084 · Admin inbox message state · Phase 12 (Accessibility)

**Failure:** `MessageItem` toggles expansion and may change read state, but its outer `Pressable` has no role, label, or `expanded` state. Screen-reader users cannot tell whether a long message is open or whether activation will mark it read.

**Fix:** `app/admin-inbox.tsx` `MessageItem` — add an accessible name including subject, read/unread state, and expand/collapse action; expose `accessibilityState.expanded`.

## Seed/context

The failed mark-read action path already has a visible error and Retry. Task 1097 owns the remaining row-toggle consistency behavior; it is not re-reported here.

## [MANUAL QA NEEDED]

- Long subject/body/sender values at narrow web/native layouts.
- Refresh failure with existing rows and a second tab.
- Screen-reader read/expanded announcements.

## Report-only stop

No fix or test change was made.
