# UX E2E — Help Assistant

**Journey:** Help → Ask Help → success or typed failure → Retry/Contact support  
**Mode:** Report-only  
**Phases:** 0–5, 8, 10–12

## App map and happy path

`help.tsx` calls `askHelpQuestion` with the current conversation and a 10-second transport deadline. Successful turns are retained up to eight entries; failures map shared error codes to retry/contact actions.

## Persistence and cross-context checks

Conversation state is in memory and is cleared on user identity change/logout/unmount. `[MANUAL QA NEEDED]` verify keyboard submit, rapid retry, network throttling, font scale, and that no answer or question is retained across users.

## Failure, retry, navigation, accessibility

The assistant disables input while loading and offers Retry and Contact support after failure. The raw `HelpApiError.message` is rendered below the friendly failure text.

## Findings

### MEDIUM

#### F-092 · Help assistant error recovery · Phase 10 (UI Feedback)

**Failure:** The friendly error card is followed by the raw API/provider message whenever `assistantError.message` exists. Provider/HTTP wording can be technical or unstable, and the error block has no explicit alert/live-region semantics, so the user may miss the actionable Retry or Contact support choices.

**Fix:** `app/(tabs)/help.tsx` assistant failure card — map provider details to stable user-safe copy, mark the failure as an accessible alert/status, and keep Retry focused on the last question without exposing transport internals.

## Seed/context

Grounded response behavior and provider routing are owned by Tasks 981 and 1174. This finding concerns the client-visible failure/recovery boundary only.

## [MANUAL QA NEEDED]

- Timeout/offline/rate-limit/provider-unavailable flows under network throttling.
- Keyboard submit and focus after Retry.
- Screen-reader announcement and Contact handoff.

## Report-only stop

No fix or test change was made.
