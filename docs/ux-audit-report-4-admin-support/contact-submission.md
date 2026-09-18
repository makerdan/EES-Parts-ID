# UX E2E — Contact Submission

**Journey:** Help/Reference → Contact Admin → validate → submit → confirm or retry  
**Mode:** Report-only  
**Phases:** 0–5, 8, 10–12

## App map and happy path

`components/ContactSheet.tsx` owns subject/body state, device token lookup, authenticated POST `/contact`, and modal dismissal. It retains fields on failure and disables close/submit while submitting.

## Persistence and cross-context checks

The device token is stored under `contact_device_token`; subject/body are not persisted. The server-backed message is visible later in Admin Inbox. `[MANUAL QA NEEDED]` verify keyboard avoidance, long text, offline retry, duplicate taps, and sender identity across reinstall/session changes.

## Failure, retry, navigation, accessibility

Invalid empty fields are blocked by `canSubmit`; server/network errors remain in the form. Successful submission clears and closes immediately, with no confirmation view.

## Findings

### MEDIUM

#### F-093 · Contact submission success · Phase 1 (Happy Path)

**Failure:** A successful POST clears the fields and immediately calls `onClose` without a success toast, confirmation screen, or message reference. From Help, the modal simply disappears; a user cannot distinguish “sent” from an accidental dismissal.

**Fix:** `ContactSheet.tsx` `handleSubmit` and the Help/Reference handoff — show a visible success confirmation (with a non-sensitive reference or timestamp), then allow the user to close; do not duplicate the server write.

### LOW

#### F-094 · Contact sender continuity · Phase 2 (State & Persistence)

**Failure:** Device-token creation writes to AsyncStorage with an empty catch. If storage is unavailable, the form submits with `anonymous`, so later messages cannot be reliably grouped for support and the user receives no indication that continuity was lost.

**Fix:** `ContactSheet.tsx` device-token effect — expose a non-blocking storage warning or retry token creation before submission, while keeping the privacy-safe anonymous fallback explicit.

## Seed/context

Contact API rate-limit/privacy policy and analytics work are out of scope. This report covers the form’s user-visible state and handoff.

## [MANUAL QA NEEDED]

- iOS/Android keyboard and modal dismissal during editing.
- Long subject/body, Dynamic Type, screen reader labels, and focus return.
- Offline/server rejection followed by retry and one-message confirmation in Inbox.

## Report-only stop

No fix or test change was made.
