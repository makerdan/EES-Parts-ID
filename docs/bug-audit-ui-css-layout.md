# Bug Audit Report — UI CSS and Layout

**Scope:** Parts ID (Expo / React Native on web and native) and Canvas (React/Vite admin tools and preview renderer). UI layout and CSS only.
**Mode:** Report-only
**Date:** 2026-09-25
**Stack:** TypeScript, Expo Router, React Native Web, React, Vite, Wouter, Jest, Vitest.
**Method:** Read-only inspection of route and component source, styles, existing layout tests, and tracked task coverage. Static screenshots were captured at the viewports listed below. No authenticated session, data write, device interaction, setting change, or product-code change was used. The canonical Bug Audit skill source was not present under `.agents/skills`; the existing tracked audit-report structure and this task's report-only requirements were used. No alternate/local skill mirror was loaded.

## Summary

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 0 |
| Medium | 2 |
| Low | 0 |

| # | Severity | Category | File(s) | Finding |
|---|---|---|---|---|
| 1 | Medium | Responsive layout — keyboard reachability | `artifacts/parts-id/components/CatalogPickerModal.tsx:148-181,183-258` | The barcode create form has no scrollable body when the keyboard reduces the modal height. |
| 2 | Medium | Responsive layout — narrow viewport overflow | `artifacts/mockup-sandbox/src/pages/ZoneEditor.tsx:2943-3169,4338-4434`; `AnchorCalibration.tsx:608-635,944-1011`; `WarehouseMapViewer.tsx:206-223,278-330` | Canvas admin toolbars clip or leave no practical map viewport at phone widths. |

Both findings have proposed implementation follow-ups: [Task #1927](#finding-1--barcode-create-actions-can-fall-below-the-keyboard) and [Task #1928](#finding-2--canvas-admin-tools-do-not-adapt-to-phone-widths).

## Findings

### Finding 1 — Barcode create actions can fall below the keyboard

- **File and line:** `artifacts/parts-id/components/CatalogPickerModal.tsx:148-181,183-258`
- **Category:** Responsive layout — keyboard reachability
- **Severity:** Medium
- **Scenario:** An admin scans a barcode, starts creating a catalog item, and opens the keyboard in a short landscape viewport. The modal's available height shrinks while the vendor-code field, optional bin field, and final Cancel / Create & assign row remain stacked vertically. The user may have to dismiss the keyboard before the lower input or action row is visible.
- **Evidence:** The `pageSheet` modal wraps its contents in a `KeyboardAvoidingView` (lines 148-152). The header and search row are followed by a conditional create-form `View` containing both inputs and the action row (lines 183-258). There is no `ScrollView` or other scrolling content container around these siblings or the create form. Keyboard avoidance can adjust the modal's layout, but this structure does not provide a way to scroll clipped content back into view. The source trace verifies the missing reachability mechanism; an actual keyboard-open native/browser reproduction was not available.
- **Recommended fix:** Make the modal's content vertically scrollable while the keyboard is open, keeping the header and close action usable and ensuring both inputs and the final actions can be reached without losing entered values.
- **Follow-up:** Proposed **Task #1927 — Keep barcode assignment actions reachable with the keyboard open** (P2 / Medium). This is a scoped residual in the barcode create state, not a proposal to repeat the broad landscape work in merged Task #1317. The existing `landscapeReachability.test.ts` does not mount `CatalogPickerModal`.

### Finding 2 — Canvas admin tools do not adapt to phone widths

- **File and line:**
  - `artifacts/mockup-sandbox/src/pages/ZoneEditor.tsx:2943-3169,4338-4434`
  - `artifacts/mockup-sandbox/src/pages/AnchorCalibration.tsx:608-635,944-1011`
  - `artifacts/mockup-sandbox/src/pages/WarehouseMapViewer.tsx:206-223,278-330`
- **Category:** Responsive layout — narrow viewport overflow
- **Severity:** Medium
- **Scenario:** An admin opens one of the Canvas tools on a phone-width browser or a short landscape display. Zone Editor's toolbar extends beyond the visible root, Anchor Calibration's fixed-width sidebar leaves no practical width for its map, or Warehouse Map Viewer's one-line header pushes its hint beyond the viewport.
- **Evidence:** These tools are source-verified; their authenticated screens were not directly rendered at narrow widths.
  - Zone Editor places the back link, title, mode controls, edit actions, grid controls, fill controls, and hint into a single `bannerRow`. The row has no wrapping rule, while the fixed root uses `overflow: hidden`; at 320 CSS pixels the row's combined minimum content width exceeds the viewport and its trailing controls are clipped.
  - Anchor Calibration's body is a horizontal flex row. Its sidebar is `width: 320` with `flexShrink: 0` (lines 1001-1010), while the page root clips overflow (lines 944-952). At a 320px viewport, the sidebar consumes the available body width and the adjacent map has no practical visible area.
  - Warehouse Map Viewer uses a single-line flex banner. The back link and hint both use `whiteSpace: "nowrap"` (lines 300-323), and the root clips overflow (lines 280-288). Their combined width with the title exceeds a phone-width viewport.
- **Recommended fix:** Add narrow/short viewport behavior for the tool shells: reflow or compact Zone Editor's controls, provide a responsive or collapsible Anchor Calibration sidebar, and wrap or compact the Warehouse Map Viewer header. Preserve usable map space and the current desktop layout.
- **Follow-up:** Proposed **Task #1928 — Keep Canvas admin tools usable on narrow screens** (P2 / Medium). Existing Task #1893 covers Zone Editor map/zone placement alignment, not viewport sizing or toolbar reachability; this report does not duplicate its map-placement scope.

## Coverage and limits

### Parts ID

| Surface | Routes and states inspected | Viewport / platform | Result |
|---|---|---|---|
| Signed-out and account states | `/login`, `/sign-up`, `/pending`, `/banned`; source and `landscapeReachability.test.ts` contracts inspected. `/login` was captured in a static preview. | Expo web at 402×874 and 874×402. Native iOS/Android runtimes were not available. | At 874×402 the sign-in card continues below the captured fold, but the route uses a `ScrollView` with a growing content container. This is not a finding. No keyboard interaction was performed. |
| Main tabs | `/(tabs)/index` (Search), `/(tabs)/map`, `/(tabs)/upload`, `/(tabs)/photo`, and `/(tabs)/help`; relevant route source and layout tests inspected. | Source/test inspection; no authenticated tab screen was visually observed. | Search tab clearance and keyboard dismissal, tab sizing, upload guard reachability, map control stacking, and photo/help keyboard-aware scrolling have focused source assertions. |
| Nested screens | `/edit-item`, `/catalog-review`, `/admin`, `/admin-audit-log`, `/admin-inbox`, `/admin-map-calibration`, and `/ai-log`; route source and available tests inspected. | Source/test inspection only. | Virtualized-list and guarded-screen scroll contracts were inspected; authenticated screen states were not rendered. |
| Shared overlays and complex states | `CatalogPickerModal`, `WarehouseMapView` loading/error/empty/zone states, camera/photo and measurement surfaces, and shared filter/editor UI. | Source and available component tests. No interactive keyboard, modal, or native safe-area session. | The barcode create form is Finding 1. The map empty-state/tab-bar geometry remains an unverified candidate below. Camera foreground placement and measurement scrolling had no confirmed layout defect in the inspected source/tests. |

### Canvas

| Surface | Routes and states inspected | Viewport / platform | Result |
|---|---|---|---|
| Tool gallery | `/__mockup/` and its three tool links. | Web screenshots at 402×874 and 1440×900. | Gallery cards and links fit in both observed widths; no gallery layout finding. |
| Admin tools | `/__mockup/zone-editor`, `/__mockup/warehouse-map`, and `/__mockup/anchor-calibration`; route gates, component source, and route tests inspected. | Source-level geometry at 320px and short landscape; no authenticated tool screenshot. | Finding 2 is based on fixed-width/no-wrap layout rules. Without an authorized admin session, actual protected route states could not be observed. |
| Sign-in and preview renderer | Sign-in/gate source inspected. The generated preview-module registry and preview route were checked. | Web preview. | The generated registry is empty. A screenshot request routed to `/__mockup/preview/zone-editor` and showed “No component found”; there were no actual preview components to inspect. |

### Viewport and state coverage

- **Observed screenshots:** Parts ID web sign-in at 402×874 and 874×402; Canvas gallery at 402×874 and 1440×900.
- **Short landscape:** Parts ID sign-in was captured at 874×402; its scroll container is visible in source and asserted by the reachability test. The protected Parts ID map/editor/camera states and Canvas admin tools were not rendered at this size.
- **Narrow widths:** Canvas admin behavior at 320px is a source/layout trace, not a captured authenticated screenshot. The gallery was observed at a narrow viewport and did not show a defect.
- **Keyboard-open reachability:** Static source was inspected; no keyboard was interactively opened in a browser or native device. Finding 1 is supported by the modal's non-scrollable content structure, not claimed as a device reproduction.
- **Safe area and bottom-tab clearance:** Parts ID tab height and map overlay styles were inspected. The no-zones card's effective position depends on its containing safe-area viewport and the runtime tab-bar overlay, which were not visually observable in the authenticated empty-map state.
- **Text scaling and light/dark:** Relevant tokens and layout rules were inspected, but no native text-scale setting or Canvas theme toggle was exercised. No layout defect from scaling or theme changes is claimed.
- **Modal/sheet stacking and map/camera foreground placement:** Source and available tests were inspected. No cross-platform visual reproduction was available for protected or native-only states.

## Unverified candidates and exclusions

These are not findings and have no new task:

- **Parts ID map empty-state card vs. bottom tabs:** `WarehouseMapView.tsx:2672-2717,2872-2885` places the empty-state overlay 44px above its container bottom; the web tab bar is styled at 84px in `app/(tabs)/_layout.tsx`. The effective map-container boundary and actual empty-zone state were not rendered, so clipping of the setup action is not confirmed. Merged Task #1317 already defines broad map/tab-bar clearance coverage; no duplicate task was proposed.
- **Canvas initial map fit:** The floor-plan SVG viewBox is 3592.55×2457.41 and map viewers start at scale 0.18. This can leave part of the drawing outside a 320px-wide viewport, but the tools are pan/zoom canvases and the source does not establish that the initial whole-map fit is required. No placement finding was promoted. Task #1893's Zone Editor alignment scope was not treated as evidence of a viewport-fit defect.
- **Large text, device keyboard geometry, system safe areas, and dark-mode visibility:** No protected/native visual state was available to verify a user-visible layout failure; no finding or task was created from these candidates.
- **Mouse/touch support and map gesture behavior:** These are interaction behavior, not CSS/layout defects for this report.

## Tooling signals

- **Parts ID typecheck:** Direct read-only `tsc --noEmit` exited 0.
- **Canvas typecheck:** `tsc --noEmit` exited 0.
- **Focused lint:** ESLint on the inspected Parts ID route/components and Canvas gallery/admin pages exited 0.
- **Focused tests:** Parts ID `landscapeReachability.test.ts`: 1 file, 18 tests passed. Canvas gallery, Zone Editor workflow, Warehouse Map route, and Anchor Calibration route tests: 4 files, 16 tests passed. These tests exercise source contracts and route/data behavior, not authenticated viewport rendering.
- **Dependency audit:** `pnpm audit --audit-level=high` exited 1 with two high advisories for `image-size@2.0.2` in Parts ID (JXL/HEIF and ICNS parser denial-of-service advisories). This is unrelated to CSS/layout; no dependency was changed.
- **Failure baseline:** `docs/validation/failure-baseline.json` contained no active records at audit time.
- **Task validation:** The task plan specifies only `test-standard`. The completion callback also launched `test-fast`, `test-standard-plus`, and `test-heavy`: fast passed; the first standard run timed out after its 420-second step budget at `spec-check`; standard-plus and heavy failed at `spec-check-tests` on the unrelated API-spec `ensure-codegen.test.ts` stale-owner lock test (expected exit 0, received 1). After those runs ended, `test-standard` was run alone and again timed out at its 420-second step budget, this time at the unchanged `production-database-target` check. These outcomes are validation-runner/tooling signals, not UI findings. No app code or tests were changed.

## Follow-up mapping and scope

| Finding | Proposed follow-up | Existing-work comparison |
|---|---|---|
| 1 — Barcode create form keyboard reachability | **#1927 — Keep barcode assignment actions reachable with the keyboard open** | Specific residual modal path not mounted by the current reachability test; not a duplicate of the broad Task #1317. |
| 2 — Canvas admin narrow-width layout | **#1928 — Keep Canvas admin tools usable on narrow screens** | Responsive sizing and toolbar reachability are separate from Task #1893 map placement/alignment. |

No application behavior, product code, tests, settings, runtime data, or credentials were changed. Only this tracked audit report and the two proposed follow-up task records were added.