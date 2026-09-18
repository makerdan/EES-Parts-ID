# UX E2E — API Health and Restart Recovery

**Journey:** Admin hub health pill → check/probe → long-press restart → rejected/timeout/recovering/recovered outcome  
**Mode:** Report-only  
**Phases:** 0–5, 8, 10–12

## App map and happy path

`ApiHealthProvider` shares `useApiStatus` with admin screens. The hook polls `/healthz`, probes bots, posts `/admin/restart`, and polls recovery for up to 20 attempts. `upload.tsx` renders the pill and maps the returned outcome to an alert.

## Persistence and cross-context checks

Health state is in memory only and polling is correctly stopped on blur/background/unmount in the current source. `[MANUAL QA NEEDED]` exercise network throttling, app backgrounding during recovery, a second tab, and each platform’s long-press behavior.

## Failure, retry, navigation, accessibility

The hook distinguishes authorization, rejection, timeout, server failure, recovery failure, and recovery. The visible pill renders only “Restarting…” during work and otherwise renders API status; restart state is not a durable visible history.

## Findings

### HIGH

#### F-097 · API restart outcome persistence · Phase 3 (Silent Failure)

**Failure:** The restart result is communicated primarily through a one-shot `Alert.alert` in `handleRestartPress`. If the admin navigates away, backgrounds the app, or the alert is dismissed before recovery finishes, the hub does not retain the accepted-but-failed/recovery-failed explanation or a retry action.

**Fix:** `app/(tabs)/upload.tsx` and `hooks/useApiStatus.ts` — render restart state as a persistent inline status card with outcome copy and safe next action; retain it until the admin dismisses it or a later health check establishes recovery.

### MEDIUM

#### F-098 · API health explanation · Phase 10 (UI Feedback)

**Failure:** After a manual check or normal poll, the pill exposes only a short color/text status and bot chips. There is no last-checked time, distinction between a transient check failure and a confirmed outage, or explanation of what “degraded” means, so an admin may treat stale status as current.

**Fix:** `ApiHealthContext`/`useApiStatus` and the admin hub health card — retain last-check metadata and show concise status/retry guidance while preserving the existing request cancellation.

### LOW

#### F-099 · API restart discoverability · Phase 12 (Interaction Gate)

**Failure:** Restart is available only through `onLongPress` on the health pill. The normal UI gives no label or hint that a destructive restart action exists, and web/keyboard users have no equivalent discoverable activation.

**Fix:** `app/(tabs)/upload.tsx` health controls — expose a labeled “Restart API” action behind the existing confirmation dialog; keep long-press as an optional shortcut rather than the only entry point.

## Seed/context

Port/process hygiene and server readiness are owned by existing runtime tasks. This report covers the admin-facing health/restart state machine only.

## [MANUAL QA NEEDED]

- Web/native long-press and keyboard access.
- Accepted restart followed by timeout/recovery failure while navigating away.
- Background/foreground recovery and second-tab status freshness.

## Report-only stop

No fix or test change was made.
