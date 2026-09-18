# UX E2E Audit — Run 4: Admin · Support · Recovery · Observability

**Mode:** Report-only  
**Scope:** Admin hub section recovery · Dashboard/tools · Inbox · Audit log · AI log · Help content · Help assistant · Contact submission · AI controls · API health/restart · People management · Read-only query tools  
**Source date:** 2026-09-08  
**Phases covered:** 0–5, 8, 10–12  
**Stop boundary:** Documentation and triage only. This report stops before the Phase 13 fix loop.

## Stack flags

- backend: true
- auth: true
- multi-tool: true (admin hub sections and linked tools)
- interactions (keyboard shortcuts / drag-and-drop): false

## App map

- **Root/auth:** `app/_layout.tsx` registers the protected stack routes and mounts `AuthGate`, `AppContext`, and `ApiHealthProvider`.
- **Admin hub:** `app/(tabs)/upload.tsx` is the admin tab. It persists `admin_activeSection` and renders Import, AI & Enrichment, Warehouse, and People & System sections.
- **Linked admin routes:** `/admin` dashboard, `/admin-inbox`, `/admin-audit-log`, `/ai-log`, `/catalog-review`, and `/admin-map-calibration`.
- **Support:** `app/(tabs)/help.tsx` loads general/admin Help records, uses the validated general cache, runs the Help assistant, and opens `ContactSheet` or `ReferenceModal`.
- **Operational health:** `contexts/ApiHealthContext.tsx` shares `useApiStatus`; the admin hub exposes status, bot probes, a manual check, and a long-press restart.
- **Server boundaries:** dashboard, contact/inbox, audit-log, AI status/provider/routes, Help, user-management, inventory/query, upload, and health endpoints all use raw authenticated fetches from the mobile artifact.
- **Persistence/cache boundaries:** `admin_activeSection`, general Help cache, Help introduction dismissal, server-backed users/messages/logs, and in-memory screen state.

## Clean-state journeys

1. Enter the admin tab as an approved admin, select each hub section, leave and return, reload, and switch to a different signed-in user.
2. Open dashboard tools, load and refresh metrics, export them, and return from calibration/map links.
3. Load the inbox, expand an unread message, retry a failed read, refresh, and inspect empty/long-message states.
4. Load the audit log, refresh, load more, retry a failed later page, and leave during each request.
5. Open the AI answer log, expand answers, refresh, and inspect an empty/high-volume/error state.
6. Load general and admin Help, dismiss/restore the introduction, use offline cache, and retry admin content.
7. Ask the Help assistant, retry each failure class, preserve conversation context, and hand off to Contact.
8. Open Contact, submit valid and invalid messages, retry offline/server failures, and verify confirmation.
9. Load AI status, probe bots, refresh the catalogue, change provider/fallbacks, and reload the section.
10. Check API health, probe individual bots, request restart, and observe rejected, timed-out, recovering, and recovered states.
11. Load People, approve/ban/promote/demote/delete users, recover from failed action refreshes, and protect self/admin state.
12. Run a read-only query, inspect empty/malformed/high-volume results, export CSV/XLSX, browse inventory, and validate floor-plan upload.

## Phase gates and manual checks

- Phase 6 skipped: no keyboard-shortcut contract in these journeys.
- Phase 7 skipped: no drag-and-drop or multi-tool gesture contract beyond explicit admin section switching.
- Phase 9 applied as an existing admin/auth boundary; authentication flows themselves were not re-audited.
- Browser, native-device, network-throttle, second-tab, font-scale, and assistive-technology checks are labeled `[MANUAL QA NEEDED]` in the journey reports.

## Seed/context reconciliation

- F-001–F-023 are seed findings from the original admin data-entry report; they are not renumbered here.
- F-024–F-068 are seed findings from the Search/Map/Photo/Barcode/Auth/Reference report; they are not re-reported here.
- F-069–F-076 are seed findings from the Search → Edit → Save → Display report; they are not re-reported here.
- The current source resolves the seed behavior where the prior reports explicitly say “fixed” or “resolved”; those statuses remain context only.
- Task 1171 and its audit-log lifecycle follow-ups own request cancellation and preservation of loaded events during pagination/refresh errors. The audit-log report below records that ownership and only adds a separate accessibility/usability gap.
- The queued journey-fix tasks own implementation of this run’s findings. Existing tasks for People refresh consistency, failed inbox actions, provider/fallback persistence, Help error contracts, and runtime/port hygiene are treated as ownership context rather than duplicate findings.

## Summary

| Severity | Count |
|---|---:|
| High | 6 |
| Medium | 14 |
| Low | 10 |
| **Total** | **30** |

## Cross-report finding index

| ID | Journey report | Severity | Root cause / user-visible outcome |
|---|---|---|---|
| F-077 | admin-hub-section-recovery | Medium | Section persistence failures are swallowed, so reload recovery is not truthful. |
| F-078 | admin-hub-section-recovery | Low | Hub section cards and back control lack explicit accessible names/state. |
| F-079 | admin-dashboard-tools | High | Refresh failure replaces already-loaded dashboard evidence with a dead-end error screen. |
| F-080 | admin-dashboard-tools | Medium | External map-tool URL rejection has no visible recovery. |
| F-081 | admin-dashboard-tools | Medium | Native export with unavailable sharing has no user-visible outcome. |
| F-082 | admin-dashboard-tools | Low | Dashboard navigation/action controls are not consistently labeled for assistive technology. |
| F-083 | admin-inbox | Medium | Refresh failure hides the last trustworthy inbox rows. |
| F-084 | admin-inbox | Low | Message rows do not expose expanded/read state to assistive technology. |
| F-085 | admin-audit-log | Low | Audit IDs are truncated with no full-value inspection or accessible expansion. |
| F-086 | admin-ai-log | High | An old log response can overwrite a newer session after logout, token change, or unmount. |
| F-087 | admin-ai-log | Medium | Refresh failure hides already-loaded AI evidence. |
| F-088 | admin-ai-log | Medium | Fixed “last 100” browsing has no pagination/filter/export path for older evidence. |
| F-089 | admin-ai-log | Low | Expandable log rows have no explicit accessibility state/name. |
| F-090 | help-content | Low | Help-introduction dismissal is optimistically hidden even when persistence fails. |
| F-091 | help-content | Medium | Failed admin Help loading looks identical to a valid account with no admin topics. |
| F-092 | help-assistant | Medium | Provider/transport error text can expose technical details without a stable user action target. |
| F-093 | contact-submission | Medium | Successful Contact submission closes immediately without confirmation or message identity. |
| F-094 | contact-submission | Low | Device-token persistence failure silently degrades sender continuity to anonymous. |
| F-095 | ai-controls | High | Provider save has no cancellation/current-session guard and can report a stale outcome. |
| F-096 | ai-controls | Medium | Catalogue refresh can replace usable status with an error payload before checking HTTP success. |
| F-097 | api-health-restart | High | Restart outcome is mostly a one-shot alert; leaving the hub loses the recovery explanation. |
| F-098 | api-health-restart | Medium | A recovered/error health status does not retain a visible “last checked/recovery” explanation. |
| F-099 | api-health-restart | Low | Restart is hidden behind long-press with no discoverable affordance or instruction. |
| F-100 | people-management | High | A successful user mutation followed by refresh failure is reported as a failed action. |
| F-101 | people-management | Medium | User-list refresh failure does not preserve a clearly marked last-known snapshot. |
| F-102 | people-management | Low | User action controls and collapsible group state lack explicit accessible names/state. |
| F-103 | readonly-query-tools | High | Query result rendering assumes stable row/column values and can crash or misrepresent malformed data. |
| F-104 | readonly-query-tools | Medium | Query/inventory high-volume results have no paging/virtualization contract for query rows or export limits. |
| F-105 | readonly-query-tools | Medium | Floor-plan upload has no client-side size/type validation before reading and posting the file. |
| F-106 | readonly-query-tools | Low | Query warnings/results/download actions do not consistently expose semantic labels and state. |

## Report-only triage boundary

No product source, tests, configuration, artifact, or existing audit report was changed. Findings are documented for the dependent journey tasks and no fix loop was started.

## Pre-existing failures to ignore

None known at audit start. This task changes reports only; the required fast validation is run exactly as declared in the task plan.

## Validation

**Command:** `test-fast`  
**Why:** This task adds only the scoped tracked audit reports and uses the lightest registered tier for the report-only contract and repository boundaries.  
**Do not escalate:** Run exactly this command. Pre-existing failures are not a reason to run a heavier tier.
