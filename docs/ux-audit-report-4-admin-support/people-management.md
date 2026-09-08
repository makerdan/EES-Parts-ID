# UX E2E — People Management

**Journey:** People & System → User Management → load → approve/ban/promote/demote/delete → refresh/recover  
**Mode:** Report-only  
**Phases:** 0–5, 8, 10–12

## App map and happy path

`upload.tsx` calls `fetchAdminUsers`, `handleUserAction`, and `deleteAdminUser` from `utils/adminUserActions.ts`. The view groups admins, approved members, and pending requests and protects self-actions in the row UI.

## Persistence and cross-context checks

The list is server-backed and held only in local state. Successful actions refresh the list; delete removes the row locally and reports partial Clerk deletion. `[MANUAL QA NEEDED]` verify two admins acting on the same user, session expiry, high-volume lists, and long email/Clerk IDs.

## Failure, retry, navigation, accessibility

Loading/error/empty states exist. `handleUserAction` treats the mutation and its follow-up `fetchUsers()` as one try/catch, which conflates a successful action with a failed refresh. User controls use visible text but lack consistent semantic metadata.

## Findings

### HIGH

#### F-100 · People action followed by refresh failure · Phase 11 (Data Lifecycle)

**Failure:** `handleUserAction` awaits `fetchUsers()` inside the same try block as the POST. If the server applies approve/ban/promote/demote but the follow-up GET fails, the catch shows a failure toast even though the destructive/privilege-changing action succeeded. The admin may repeat the action or distrust the current row.

**Fix:** `utils/adminUserActions.ts` `handleUserAction` — separate mutation success from refresh failure; show “Action completed, list refresh failed,” retain the previous list, and provide explicit Refresh/Retry without replaying the mutation.

### MEDIUM

#### F-101 · People list refresh snapshot · Phase 3 (Silent Failure)

**Failure:** A failed initial/refresh fetch sets `usersError`, but the UI does not distinguish an empty list from a last-known list needing refresh. During recovery, admins can see stale rows without a timestamp or clear “not current” indicator.

**Fix:** `upload.tsx` People section and `adminUserActions.ts` — retain the last successful list, show a refresh-failed banner with Retry and last-updated context, and use the empty state only when no snapshot has ever loaded.

### LOW

#### F-102 · People management accessibility · Phase 12 (Accessibility)

**Failure:** Approve, ban, delete, promote, demote, and collapsible group controls have no consistent explicit labels or expanded state. Long IDs/emails are also visually truncated without a full accessible value.

**Fix:** `upload.tsx` People rendering and `UserAdminButtonRow` — add roles/labels/state, identify the target user in each action label, and expose full identifiers through accessible text or a detail/copy action.

## Seed/context

Existing People action and refresh-follow-up work owned by Tasks 963 and 1012 must be reconciled before implementation. This report documents the boundary that remains visible to users.

## [MANUAL QA NEEDED]

- Failed follow-up refresh after each action, with no duplicate mutation.
- Self-admin/self-delete protection and session expiry.
- Long identifiers, screen-reader action labels, and high-volume scrolling.

## Report-only stop

No fix or test change was made.
