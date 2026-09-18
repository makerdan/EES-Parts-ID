# App Support Ops Completion Report

**Product:** Parts ID  
**Workflow:** Combined — Help, Admin Analytics, and Runtime Safety  
**Verification date:** 2026-09-03  
**Status:** Support Ops capability verification complete; required tier is
blocked by an upstream validation-policy contradiction

## Scope and capability matrix

| Workstream | Capability | Status | Evidence |
| --- | --- | --- | --- |
| Help | Authenticated general Help records with bounded, versioned content | Present | `GET /api/help`; `help.integration.test.ts`; `helpContent.ts` runtime validation |
| Help | Admin Help isolated behind current server role and MFA checks | Present | `GET /api/help/admin`; `requireAdminAuth`; non-admin, stale-role, and pending/banned assertions |
| Help | App-only grounded Q&A with bounded input/history/output, no web or inventory context | Present | `POST /api/help/ask`; `helpAssistant.integration.test.ts` provider-prompt assertions |
| Help | First-use orientation and persistent revisit access | Present | Parts ID Help screen and `helpScreen.test.tsx` dismissal/reopen journey |
| Help | Offline general Help fallback with no trusted admin cache | Present | `helpStorage.ts`; `helpStorage.test.ts`; Help screen cache/recovery path |
| Help | Contact fallback and distinct retry/error states | Present | `ContactSheet`; Help screen error controls; `ReferenceModalBack.test.tsx`; `ReferenceModalRetry.test.tsx` |
| Help | Touch, keyboard, and assistive-technology usable controls | Present | React Native `Pressable` controls with explicit roles/labels; rendered Help/Reference workflow assertions |
| Admin Analytics | Privacy-safe aggregate AI and screen-view reporting | Present | `GET /api/admin/dashboard-stats`; UTC window, minimum-cell suppression, aggregate-only response, keyed rotating visitor grouping |
| Admin Analytics | Telemetry accepts only finite, schema-validated events | Present | `POST /api/track/screen-view`; `trackContact.integration.test.ts`; invalid/identified/oversized event assertions |
| Admin Analytics | Protected dashboard and export | Present | `requireAdminAuth`; `adminDashboardWorkflow.test.tsx`; no-admin Not found path; native sharing and web CSV path |
| Runtime Safety | Health status, degraded/error recovery, and bounded client polling | Present | `useApiStatus.test.ts`; `ApiHealthContext`; network-failure reporting and recovery assertions |
| Runtime Safety | Development-only, admin-plus-MFA restart | Present | `POST /api/admin/restart`; `adminRestart.integration.test.ts`; production denial and non-admin/stale-role denial |
| Runtime Safety | Restart idempotence and safe client confirmation | Present | `adminApiRestartWorkflow.test.tsx`; cancel, accepted 202, repeated request, and non-admin journeys |
| Runtime Safety | Port/process safety | Reused | Existing Port Authority and validation lock scripts; this task did not duplicate or redesign them |

No Combined-mode capability was skipped. The three workstreams remain separate
at their authorization and persistence boundaries; only existing app auth,
health, and telemetry adapters are shared.

## Existing components reused

- The existing Clerk-backed app authentication and server-side `requireAppAuth`
  / `requireAdminAuth` middleware.
- The existing `ReferenceModal` and `ContactSheet` for the electrical Reference
  distinction and support-contact recovery.
- The existing Parts ID `AppContext`, logout registry, storage error reporting,
  and API health context.
- The existing admin dashboard screen, CSV serializer, Expo file/sharing
  adapters, and API client base URL.
- The existing AI provider abstraction and cache boundary; Help uses its own
  grounded route and does not broaden the electrical Reference assistant.
- The existing screen-view schema, rate limiter, database retention path, and
  privacy-key material.
- The existing Port Authority/serial-lock validation infrastructure.

## Security, privacy, and safety decisions verified

- Authorization is enforced at the API boundary. Client `isAdmin` state only
  controls presentation; it cannot select or unlock admin API content.
- Admin Help context is added only for a current admin identity that passes the
  existing MFA-aware middleware. General Help responses and caches contain no
  admin records.
- Anonymous, pending, banned, approved non-admin, stale-role, and demoted-admin
  callers receive safe denial behavior without restricted titles, identifiers,
  summaries, prompts, or body content.
- Help questions, history, selected records, provider output, rate checks, and
  timeouts are bounded. Provider failures return retry/contact-safe messages
  without provider details or prompt disclosure.
- Screen telemetry has a finite schema, rejects client identifiers, rate-limits
  by privacy-safe key, and writes only a server-derived keyed visitor digest.
  Visitor grouping rotates daily and is disabled when server-held key material
  is unavailable rather than falling back to a linkable identifier.
- Dashboard reporting is aggregate-only, uses one bounded UTC reporting window,
  suppresses cells below the configured minimum, and discloses suppression and
  unique-visitor availability.
- Export is available only after protected dashboard data is loaded. The web
  path downloads a generated CSV; the native path writes to cache and uses the
  platform sharing sheet.
- Restart is gated by current admin authorization and development mode, returns
  an explicit accepted response, rejects repeats while in flight, and is denied
  in production. The client does not treat cancellation or denial as recovery.
- Help and admin controls use touchable controls with accessibility roles and
  labels; no verified capability depends on hover or client-only authorization.

## Journey and negative-path evidence

The focused cross-layer pass exercised:

- General Help load, structured records, first-use dismissal, revisit, and
  worker-only content.
- Current admin Help, stale/demoted role removal, and admin-content isolation.
- Offline general Help storage validation and safe invalid-cache handling.
- App-only Q&A grounding, unsupported questions, rate limiting, provider
  failure, timeout/retry/contact recovery, and bounded history.
- Contact submission, admin-only inbox access, telemetry-invalid events, and
  rate-limited event/contact requests.
- Privacy-safe dashboard aggregates, suppression metadata, protected export, and
  unauthenticated dashboard access.
- Health error/recovery behavior, development restart cancellation, accepted
  restart, repeated restart rejection, production rejection, and unmounted
  client cleanup.

Explicitly safe failure audiences and conditions verified: anonymous, pending,
banned, non-admin, stale-role, demoted-admin, offline/network failure,
rate-limited, provider-down, telemetry-invalid, restart-rejected, and
production-mode.

## Inapplicable or environment-bounded branches

- Native binary execution from the iOS Replit app was not performed, per the
  task boundary; the Parts ID React Native test suites exercised native-shaped
  controls and storage/sharing adapters, and web-specific export behavior is
  covered in the rendered workflow suite.
- A real production restart was intentionally not attempted. Production
  exclusion is verified by the API route returning `503 RESTART_UNAVAILABLE`
  before any scheduling or exit.
- No new provider, support destination, analytics category, deployment
  infrastructure, or Canvas behavior was introduced; those branches are
  outside this Combined workflow.
- Unique-visitor reporting is deliberately unavailable when server-held privacy
  key material is absent. The dashboard reports that state instead of
  fabricating a visitor identifier.

## Validation evidence

### Focused Support Ops suites

- API Server: 8 suites, 75 tests passed.
- Parts ID: 8 suites, 58 tests passed.
- Combined focused result: **133 tests passed**.

### Required task tier

Command: `pnpm run test-heavy`

After the dependency-remediation work merged, the required tier was run again
from the updated main branch. The previously vulnerable dependency paths were
replaced or patched: Orval is 8.22.0, SheetJS uses the maintained
`@e965/xlsx` package, `@xmldom/xmldom` resolves to 0.8.15/0.9.12, and the
workspace dependency overrides contain the corresponding advisory floors.

That run acquired the validation lock immediately and ran solo, but stopped at
its first `gate-guard` step. Upstream main currently wires the Project workflow
to the individual validation commands, while
`scripts/check-gate-integrity.sh` requires the same Project workflow to contain
only `test-fast`. The failure is deterministic before any Support Ops code or
test executes.

Ownership evidence:

- The task branch changes only this report relative to updated main.
- The conflicting `.replit` and gate-guard contracts arrived from upstream
  validation-policy commits; task #985 does not own either surface.
- Validation-policy activation and follow-up work are tracked separately.
- Changing the Project gate or weakening gate-guard here would exceed the
  App Support Ops scope and could silently change repository merge policy.

The baseline catalog has no active records, so this report does not claim an
authorized test-failure waiver. The earlier inventory failure remains
diagnostic context only: 7 assertions reported PostgreSQL
`too many clients already` under concurrent validation, followed by three
isolated 50/50 passes; it did not recur in the later full test step. No
additional validation tier was run or escalated manually.

## Configuration and handoff

Production deployments should provide the documented CORS allowlist and
server-held privacy key material. Without the latter, unique-visitor analytics
remain intentionally disabled. The existing Port Authority implementation is
the runtime-safety dependency; this completion pass reuses it rather than
duplicating process or port management.