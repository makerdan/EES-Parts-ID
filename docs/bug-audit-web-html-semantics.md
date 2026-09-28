# Bug & Error Audit Report — Web HTML Semantics

**Scope:** Parts ID Expo web (served document, unauthenticated `/login`, source inventory of authenticated routes and development landing fallback) and Canvas (`/__mockup/`, sign-in, protected admin routes and preview renderer). HTML structure and semantics only.
**Mode:** report-only
**Date:** 2026-09-24
**Stack:** TypeScript, Expo Router/React Native Web, React/Vite/Wouter, Clerk, Vitest/Jest, pnpm.
**Method:** Inspected first-party source and tests; fetched served documents and used headless Chromium DOM dumps at `localhost:80` for the public routes. A DOM dump confirms tags and attributes, not an assistive-technology announcement or a complete accessibility-tree inspection. No authenticated account, data write, application fix, or browser automation of a protected tool was used.

## Summary

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 2 |
| Medium | 2 |
| Low | 0 |

| # | Severity | Category | File:Line | One-line description |
|---|---|---|---|---|
| 1 | High | State & data integrity | `artifacts/parts-id/app/login.tsx:199-223` | Email and password have no programmatically associated names. |
| 2 | High | State & data integrity | `artifacts/parts-id/app/login.tsx:227-239`; `artifacts/parts-id/components/OAuthButtons.tsx:255-282` | Sign-in actions render as focusable generic elements, not buttons. |
| 3 | Medium | State & data integrity | `artifacts/parts-id/app/login.tsx:186-195` | The login page has neither a main landmark nor a heading. |
| 4 | Medium | State & data integrity | `artifacts/mockup-sandbox/src/App.tsx:144-181` | Canvas tool gallery has no main landmark. |

The audit skill's ten categories do not include accessibility; **State & data integrity** is used here for missing browser semantic state. This is not a claim of lost application data. Severity reflects the actual user-facing navigation/form impact rather than lint output.

## Findings

### Finding 1 — Login fields have no accessible labels
- **File and line:** `artifacts/parts-id/app/login.tsx:199-223`
- **Category:** State & data integrity
- **Severity:** High
- **Risk:** A screen-reader user reaching the two login inputs cannot reliably identify which is email and which is password once placeholder text is replaced by a typed value. The adjacent visual `Text` labels are not associated with either control.
- **Evidence:** Chromium-rendered `/login` contains two `<input>` elements (`type="email"` and `type="password"`) but no `<label>` elements, `aria-label`, or `aria-labelledby` on either input. React Native Web rendered the sibling `Text` labels as generic divs; `KeyboardDoneInput` does not add a label. The placeholder is not a persistent accessible label. This is observed DOM, not an inference from React Native props.
- **Recommended fix:** Supply distinct, persistent accessible names to both inputs on web (and preserve appropriate native labels), associating the visible labels with their controls.
- **Possible fix task:** **Make Parts ID sign-in fields identifiable to assistive technology** (P1). Acceptance: in a browser the email and password inputs each have a distinct accessible name matching the visible label before and after typing; keyboard and native input behavior remain intact. Order: independent of finding 2.

### Finding 2 — Login actions lack button semantics
- **File and line:** `artifacts/parts-id/app/login.tsx:227-239`; `artifacts/parts-id/components/OAuthButtons.tsx:255-282`
- **Category:** State & data integrity
- **Severity:** High
- **Risk:** A screen-reader user's button list excludes the Sign In and social sign-in actions, despite their visual appearance and keyboard focusability. They must discover generic focusable elements instead of standard button controls.
- **Evidence:** The rendered `/login` DOM has zero `<button>` elements and three `<div tabindex="0">` actions for Sign In and the Google/Apple actions, with no `role="button"`. The Sign up navigation is correctly emitted as `<a href="/sign-up" role="link">`, so this is not a blanket assertion that React Native Web cannot produce roles. Source `Pressable` elements omit `accessibilityRole`. This confirms missing semantics; activation by keyboard was not exercised and is **not** claimed broken.
- **Recommended fix:** Give each action button semantics and a stable accessible name/state (including disabled/loading state); confirm Enter and Space behavior on the rendered web elements.
- **Possible fix task:** **Expose Parts ID sign-in actions as buttons** (P1). Acceptance: Sign In and available social sign-in actions are discoverable as named buttons in the browser accessibility tree and activate with Enter/Space; loading exposes an appropriate disabled/busy state; native behavior remains unchanged. Order: independent of finding 1.

### Finding 3 — Parts ID login lacks navigation structure
- **File and line:** `artifacts/parts-id/app/login.tsx:186-195`
- **Category:** State & data integrity
- **Severity:** Medium
- **Risk:** A keyboard or screen-reader user cannot jump to the login content via a main landmark or find the visually prominent “Parts ID” title in the headings list.
- **Evidence:** Chromium's `/login` DOM has no `<main>`, `[role="main"]`, `<h1>`–`<h6>`, or `[role="heading"]`; the title is rendered from React Native `Text` into a generic div. The served Expo document does have `<html lang="en">` and `<title>EES Parts ID</title>`, so document language and title are not findings.
- **Recommended fix:** Give the login screen a main landmark and designate its visible title as its level-one heading using web-compatible/native-safe semantics.
- **Possible fix task:** **Let assistive technology navigate the Parts ID login page** (P2). Acceptance: the rendered login has one main landmark and an appropriately named level-one heading, without changing visual layout or native navigation. Order: can be grouped with findings 1–2 in one sign-in repair if selected.

### Finding 4 — Canvas gallery has no main landmark
- **File and line:** `artifacts/mockup-sandbox/src/App.tsx:144-181`
- **Category:** State & data integrity
- **Severity:** Medium
- **Risk:** A screen-reader user opening the admin tool index cannot jump directly to its primary content by landmark, although the heading and list of three links are otherwise semantic.
- **Evidence:** Rendered ` /__mockup/` has one `<header>`, one `<h1>`, a `<ul>` with three `<li>` links, but no `<main>` or `[role="main"]`. Source wraps them in generic divs. The document has `lang="en"` and title `Mockup Canvas`; no title/language defect was verified.
- **Recommended fix:** Wrap the gallery's primary content in `<main>` while retaining the header, list, and links.
- **Possible fix task:** **Make Canvas admin tools easy to reach by landmark** (P2). Acceptance: the gallery renders exactly one main landmark containing the heading and tool list; links keep their existing destinations and names. Order: independent.

## Coverage and limits

| Surface | Routes/states examined | Result |
|---|---|---|
| Parts ID web | Served `/` and `/login` shell; rendered unauthenticated `/login`; `_layout`, `sign-up`, pending/banned, Search tab, FilterPanel, Settings modal and routed editor source inventoried | Login DOM verified. Authenticated Search, advanced filters, settings, uploads, map, photo, help, edit, admin, AI log, review, inbox and calibration **not rendered** without an authenticated/approved session. |
| Parts ID development landing | `server/serve.js` route selection and `server/templates/landing-page.html` inspected | The template is only served in development fallback with no web build. A web build exists and the running Expo preview did not serve this fallback; missing `lang`, loading status semantics and QR alternatives are **source candidates, not verified served findings**. |
| Canvas | Served `index.html`; rendered gallery `/__mockup/`, signed-out `/__mockup/zone-editor`, `/__mockup/sign-in`, and missing-component `/__mockup/preview/no-such-component` | Gallery and gate DOM verified. Clerk sign-in generated real labels/inputs/headings; its internals are not first-party rewrite targets. Preview missing-component route rendered an error `<pre>`; no real preview component was discovered in the inspected source tree. |
| Canvas protected tools | `/__mockup/zone-editor`, `/__mockup/warehouse-map`, `/__mockup/anchor-calibration` route definitions, source and representative tests inspected | Only signed-out gate rendered for zone editor; protected tool DOM, SVG accessibility tree, dialogs and keyboard operation **unverified** without admin access. `ZoneEditor` custom `Label` divs, `AnchorCalibration` adjacent field-label divs, and mouse-driven SVGs are candidates, not findings. |

Checks covered document shell/title/language, landmarks/headings, control names and roles, link vs. action behavior, field association, gallery list structure, imagery/SVG, dialog/status candidates and keyboard reachability. No table was rendered on the reachable routes. The gallery's semantic links/list and Clerk's labeled controls are positive controls. The Parts ID action's focusable `tabindex` confirms focusability, **not** keyboard activation. No protected modal/status behavior or screen-reader announcement was asserted from source. The Web Interface Guidelines were fetched on this audit date; their landmark, heading, label, button and keyboard checklist was supplementary, not evidence in itself.

## Tooling signals (Phase 0)

- **Typecheck:** Read-only `tsc --noEmit` for Canvas and Parts ID exited 0. Canvas focused ESLint and Parts ID login/FilterPanel focused ESLint exited 0. Neither statically tests the rendered semantics above.
- **Focused tests:** Canvas `AdminGate.test.tsx` and `AnchorCalibrationRoute.test.tsx`: 2 files / 13 tests passed. These verify gate/routing behavior, not an authenticated accessibility tree.
- **Dependency audit:** `pnpm audit --audit-level high --json` exited 1 with two high advisories for `image-size@2.0.2` in Parts ID. They concern image parsing, not HTML semantics; not a finding in this report. No dependency was changed.
- **Baseline:** `docs/validation/failure-baseline.json` has no active records. No focused test failed. The plan's sole completion command, `test-fast`, passed (run `yV07XMmbog-Gaq7KDr8H7`; single command PASSED, exit 0). No heavier tier was run.

## Deferred / not audited

No fixes, tests, guards, configuration, credentials or runtime data were changed. Native iOS/Android semantics, CSS, validation values, APIs, performance and other bug-audit categories (null safety, async timing, error handling, type safety, security, concurrency, dead code and dependency hygiene beyond signal gathering) are out of scope. Sign-up and other unauthenticated Parts ID states were source-inventoried but not browser-observed; they are not implicitly cleared. Browser snapshot of Expo's separate preview domain showed a blank white frame with a floor-plan CORS error; the `localhost:80/login` Chromium DOM did render the login. This preview-domain difference limits visual verification and is not classified as an HTML-semantics finding. No user data or auth state was altered to reach gated pages.

No existing open task in the visible task list specifically covers these four semantic repairs; no repair task was created as part of this report.