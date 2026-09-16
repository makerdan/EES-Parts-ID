# Bug & Error Audit Report — Service Smoke Contracts

**Scope:** Protected-map route smoke tests, the Parts ID static-server proxy
smoke test, API route authorization, AI-provider startup exports, Poe setup
safety guidance, and account skill-mirror synchronization contracts.
**Mode:** Report-only
**Date:** 2026-09-16
**Stack:** Node.js 24, pnpm, TypeScript, Express, React/Vitest, Expo/React
Native Web, Clerk, and filesystem-backed account-skill projection.

The audit applied all ten Bug Audit categories. No live provider call,
production-service access, full package test suite, or implementation change
was used.

## Baseline and evidence limits

The required validation command was run exactly:

```text
pnpm run test-fast
```

It passed all 27 of 27 steps. The focused checks reported:

- API route authorization contract: 73 admin-only declarations require an
  approved-admin guard.
- AI provider startup export contract: passed.
- Poe targeted correction contract: passed.
- Skill Mirror Sync contract: passed.
- Typecheck, lint, port, and configuration checks: passed.

The fast tier does not execute the serve-proxy smoke (standard tier) or the
protected-map concurrency runner (heavy tier). Those two checks were audited
by static trace only, as required by the task's validation ceiling. No
provider or production endpoint was contacted.

## Coverage inventory

| Check | Service or boundary | Claimed invariant | Mechanism and tier | Audit boundary |
|---|---|---|---|---|
| `scripts/run-protected-map-smoke.mjs` | `@workspace/mockup-sandbox` | Warehouse map, zone editor, and anchor-calibration route workflows remain usable under concurrent load. | Spawns three independent Vitest files concurrently; registered as `protected-map-concurrency` in heavy. | React/jsdom workflow coverage only. Clerk and API calls are mocked; it is not a server authorization or native-render smoke test. |
| `artifacts/parts-id/scripts/test-serve-proxy.mjs` | Parts ID `server/serve.js` | `/api/*` forwards status, body, authorization, response headers, and returns JSON 502 when the API is unavailable. | Starts a stub API and a production server on selected local ports; tiny HTTP runner; standard. | Does not exercise static/SPA fallback, manifest routing, or an actual API server. Its proxy assertions are appropriately narrow. |
| `scripts/test/api-route-authorization-contract.test.mjs` | API route declarations and `routeAccessMatrix.ts` | Every matrix entry marked `admin-only` has a visible route-level admin guard. | Regex-based route-mount and declaration scan; fast. | It is a source contract, not a request-level auth test, and currently excludes `approved-admin` entries. |
| `scripts/test/ai-provider-startup-export-contract.test.mjs` | `artifacts/api-server/src/lib/aiProvider.ts` | No misleading startup-named live probe is exported from the provider module. | Reads TypeScript and rejects exported names containing both `startup` and `probe`; fast. | It does not import the provider or exercise startup, environment failure, or network behavior. |
| `skill-previews/poe-setup/targeted-correction-contract.test.mjs` | `skill-previews/poe-setup/SKILL.md` | The Poe guide uses the `POE_API_KEY2` lazy `/v1` client pattern and rejects eager import-time setup. | Text assertions plus a simple brace-depth heuristic over the approved raw-SDK example; fast. | This is documentation/source-text validation, not compilation or execution of every guide example. |
| `scripts/test/skill-mirror-sync-contract.test.mjs` | Account-skill projection, disposable mirror, and public-repository boundary | Projection is recursive, fresh, owned, atomic, fail-closed, and does not expose private source data. | Large temporary filesystem fixture, child-process status/sync calls, recovery failure cases, and boundary scan; fast. | The fixture is realistic for filesystem behavior, but child-process calls have no per-call timeout. |

## Ten-category audit

| Category | Result |
|---|---|
| Null / undefined safety | No verified finding. The source contracts do not claim to validate runtime response shapes; their narrowness is documented above. |
| Async & timing | Findings 1–3. Smoke and contract subprocess/request operations have no local deadline. |
| Error handling | Finding 2. The proxy harness has no `finally` cleanup when an unexpected harness error escapes. |
| Type safety | No verified finding. The audited JavaScript contracts intentionally use source parsing and runtime fixtures rather than a type-level claim. |
| State & data integrity | No verified finding. Map route tests assert stale-response and route-state behavior within their client scope. |
| Security | Finding 4, plus the protected-map boundary in Finding 5. The authorization contract omits one privileged audience, and the map smoke does not reach server auth. |
| Performance | No verified finding. Concurrent map execution is intentional and is the reason this separate runner exists. |
| Concurrency & shared state | No verified finding. The map runner preserves independent suite ownership, and the mirror fixture uses temporary roots and cleanup. |
| Dead / unreachable code | No verified finding. The fast lint/dead-export checks passed. |
| Dependency hygiene | No verified finding from this scoped audit. Dependency vulnerability auditing is outside the required fast command and no live provider dependency was exercised. |

## Summary

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 0 |
| Medium | 2 |
| Low | 5 |

| # | Severity | Category | File:Line | One-line description |
|---:|---|---|---|---|
| 1 | Medium | Async & timing | `scripts/run-protected-map-smoke.mjs:18-43` | Concurrent protected-map child processes have no execution deadline or forced cleanup path. |
| 2 | Medium | Async & timing / Error handling | `artifacts/parts-id/scripts/test-serve-proxy.mjs:76-103, 177-184, 271-283` | A stalled proxy response can hang the smoke and an unexpected harness error can leave both servers running. |
| 3 | Low | Async & timing | `scripts/test/skill-mirror-sync-contract.test.mjs:77-95` | Repeated synchronous status/sync child processes have no timeout, so a lock or filesystem hang blocks the fast tier. |
| 4 | Medium | Security | `scripts/test/api-route-authorization-contract.test.mjs:44-50` | `approved-admin` matrix entries are parsed out and therefore receive no guard assertion. |
| 5 | Low | Security | `artifacts/mockup-sandbox/src/__tests__/WarehouseMapRoute.test.tsx:12-18, 106-114`; `AnchorCalibrationRoute.test.tsx:29-35, 90-120` | Protected-map smoke proves the client gate with mocked Clerk/API state, not the server authorization boundary. |
| 6 | Low | Error handling / Type safety | `scripts/test/ai-provider-startup-export-contract.test.mjs:12-38` | The startup contract is a name heuristic and cannot detect import-time side effects or incorrectly named live probes. |
| 7 | Low | Error handling / Async & timing | `skill-previews/poe-setup/targeted-correction-contract.test.mjs:29-69, 105-140` | The Poe import-safety check covers only a selected text pattern and cannot reject other network transports or compile the guide example. |

## Findings

### Finding 1 — Protected-map runner has no child-process deadline

- **File and line:** `scripts/run-protected-map-smoke.mjs:18-43`
- **Related implementation/contract:** `scripts/validation-steps.mjs:127-131`;
  `artifacts/mockup-sandbox/package.json:13`
- **Category:** Async & timing
- **Severity:** Medium
- **Classification:** Verified validation-harness reliability gap; no product
  defect reproduced.
- **Evidence:** `runSuite()` resolves only on `error` or `close`, and the
  `spawn()` call has no timer, `AbortSignal`, or kill path. The outer
  `Promise.all()` waits for every suite. A Vitest worker, pnpm process, or
  descendant that stops producing output can therefore keep the heavy check
  pending indefinitely. The runner intentionally waits for all three results
  after failures, so this is not an accidental early-exit issue.
- **Risk:** A hung route workflow can consume the heavy validation slot and
  prevent a result from being reported. This produces a stuck validation run
  rather than a bounded failure with suite ownership.
- **Recommended fix:** Add a per-suite deadline that terminates the child
  process group, records a timeout result with the suite path, and still
  performs bounded cleanup before the aggregate runner exits.

### Finding 2 — Proxy smoke has unbounded requests and non-final cleanup

- **File and line:** `artifacts/parts-id/scripts/test-serve-proxy.mjs:76-103,
  177-184, 271-283`
- **Related implementation/contract:** `artifacts/parts-id/server/serve.js:148-171`;
  `scripts/validation-steps.mjs:106-117`
- **Category:** Async & timing / Error handling
- **Severity:** Medium
- **Classification:** Verified validation-harness reliability gap; no proxy
  regression reproduced.
- **Evidence:** `sendRequest()` attaches only an `error` listener and never
  sets a request timeout or destroys a socket when the response never ends.
  The main body closes the child and stub only after all test functions return.
  The `main().catch()` path reports an error and exits without a `finally`
  block that kills the child or closes the stub. The startup-failure path
  cleans up, but later assertion or unexpected errors do not.
- **Risk:** A proxy regression that leaves a connection open can hang the
  standard validation step. A harness exception before the final cleanup can
  leave a server holding a port, contaminating later checks and obscuring the
  original failure.
- **Recommended fix:** Give each client request a bounded timeout and move
  child/stub shutdown into an outer `try/finally`; on timeout, destroy the
  request and include the path in the failure output.

### Finding 3 — Skill-mirror child commands have no timeout

- **File and line:** `scripts/test/skill-mirror-sync-contract.test.mjs:77-95`
- **Related implementation/contract:** `scripts/account-skill-status.mjs`;
  `scripts/account-skills-sync.mjs`;
  `scripts/lib/account-skill-projection.mjs:301-406`
- **Category:** Async & timing
- **Severity:** Low
- **Classification:** Verified validation-harness reliability gap; current
  filesystem scenarios passed.
- **Evidence:** `runStatus()` and `runSync()` use `spawnSync()` without
  `timeout` or `killSignal`. The contract invokes those helpers repeatedly
  across missing-source, permission, mismatch, recovery, and cleanup cases.
  The outer `try/finally` removes the temporary root only after each child
  returns, so it cannot protect the validation process from a blocked child.
- **Risk:** A lock, inaccessible filesystem, or regression in one of the
  command-line wrappers can block the fast tier indefinitely instead of
  producing a classified contract failure.
- **Recommended fix:** Set an explicit per-invocation `spawnSync` timeout and
  surface a structured timeout assertion; retain the existing outer cleanup
  for normal and terminated cases.

### Finding 4 — Authorization contract ignores approved-admin routes

- **File and line:** `scripts/test/api-route-authorization-contract.test.mjs:44-50`
- **Related implementation/contract:** `artifacts/api-server/src/routes/routeAccessMatrix.ts:79-82`;
  `artifacts/api-server/src/routes/adminUpload.ts:165,374,513-514`;
  `artifacts/api-server/src/routes/inventory.ts`
- **Category:** Security
- **Severity:** Medium
- **Classification:** Verified contract false negative; current routes are
  guarded, so no live authorization bypass was reproduced.
- **Evidence:** `parseAdminOnlyEntries()` accepts the access alternatives
  `public|approved-user|admin-only` and then filters to `admin-only`.
  The matrix currently contains five `approved-admin` entries, but none can
  reach `missingGuards`. The declaration matcher already recognizes
  `requireApprovedAdminAuth`, so the omission is in matrix parsing and
  selection rather than in the route syntax. The current fast output's
  “73 admin-only declarations” confirms that this audience is excluded from
  the reported count.
- **Risk:** A future upload or inventory route marked `approved-admin` can
  lose its route-level approved-admin guard while this required contract still
  passes. That is a security-relevant false negative in the validation layer,
  even though the currently inspected approved-admin declarations are guarded.
- **Recommended fix:** Include `approved-admin` in the parsed access values and
  validate it against `requireApprovedAdminAuth`; report separate counts and
  require the appropriate guard for each privileged access level.

### Finding 5 — Protected-map smoke does not exercise server authorization

- **File and line:** `artifacts/mockup-sandbox/src/__tests__/WarehouseMapRoute.test.tsx:12-18, 106-114`;
  `artifacts/mockup-sandbox/src/__tests__/AnchorCalibrationRoute.test.tsx:29-35, 90-120`
- **Related implementation/contract:** `scripts/run-protected-map-smoke.mjs:12-15`;
  `artifacts/api-server/src/routes/mapAnchors.ts`;
  `artifacts/api-server/src/routes/warehouseZones.ts`
- **Category:** Security
- **Severity:** Low
- **Classification:** Verified coverage boundary, not a current product defect.
- **Evidence:** The route suites replace Clerk hooks with in-memory state and
  replace `fetch` with fixture functions. Their successful admin paths receive
  `{ isAdmin: true }` from `/api/admin/me` and fixture data from mocked
  endpoints; no request reaches Express or `requireAdminAuth`. The denial
  cases prove that the client stops loading when the mock says the user is
  not an admin, which is useful but distinct from server-side authorization.
- **Risk:** A server guard regression or mismatch between Clerk claims and the
  API middleware can pass the protected-map smoke because the UI fixture
  already grants the expected answer. The separate static route contract
  reduces this risk for recognized declarations but does not provide a
  request-level check.
- **Recommended fix:** Add a small API-level authorization contract for the
  map and zone mutation/read boundaries, or rename/document the runner as a
  client workflow smoke so it is not treated as end-to-end protection
  coverage.

### Finding 6 — Provider startup contract checks names, not startup behavior

- **File and line:** `scripts/test/ai-provider-startup-export-contract.test.mjs:12-38`
- **Related implementation/contract:** `artifacts/api-server/src/lib/aiProvider.ts:31-69,
  399-452, 749-907`
- **Category:** Error handling / Type safety
- **Severity:** Low
- **Classification:** Verified contract coverage gap; no startup failure
  reproduced.
- **Evidence:** The contract reads the file as text, extracts exported names,
  and rejects only names matching both `/startup/i` and `/probe/i`. It never
  imports `aiProvider.ts`, stubs environment variables, or invokes
  `getAiClient()`, `initProvider()`, or the exported probe operations. The
  current module contains lazy client construction and separately exports live
  probe functions, but a wrongly named startup side effect would not be
  observed by this check.
- **Risk:** A future module change can reintroduce eager environment access,
  client construction, or a network probe under a name that does not contain
  both keywords while the contract remains green. The check therefore cannot
  prove the startup-safe behavior suggested by its filename.
- **Recommended fix:** Add an import-only subprocess fixture with missing
  optional provider configuration and a mocked provider boundary, then assert
  that import succeeds without a client/network call. Keep the naming check
  only as a supplementary API-shape guard.

### Finding 7 — Poe import-safety contract is pattern-limited

- **File and line:** `skill-previews/poe-setup/targeted-correction-contract.test.mjs:29-69, 105-140`
- **Related implementation/contract:** `skill-previews/poe-setup/SKILL.md:143-176,
  180-241`
- **Category:** Error handling / Async & timing
- **Severity:** Low
- **Classification:** Verified documentation-contract coverage gap; no live
  provider call was made.
- **Evidence:** `assertImportSafeModule()` tracks a simple brace depth and
  rejects only module-scope `new OpenAI`, a `POE_API_KEY2` read, three named
  helper/network patterns, and the six hand-written mutations. It does not
  compile or execute the extracted TypeScript example and does not detect
  other transports or call shapes such as module-scope `fetch`, another SDK,
  `responses.create`, or a renamed helper. The surrounding guide contains
  several raw HTTP examples, while the contract validates only the one
  “Raw SDK fallback” block.
- **Risk:** A future edit can preserve the checked phrases and pass the
  contract while introducing an import-time network call or invalid TypeScript
  in another provider example. This is a false negative in documentation
  safety validation, not evidence that the current guide contacts Poe at
  import time.
- **Recommended fix:** Extract and compile the approved example(s), and add a
  small AST or executable import-safety fixture that rejects any top-level
  network/client construction rather than a fixed list of spellings.

## Confirmed strengths and intentionally narrow coverage

- The proxy fixture checks both request-body preservation and response-header
  forwarding, not only a status code. The 502 case also checks that the
  proxy process remains alive.
- The map suites use deferred responses and stale-response assertions, so the
  important client race scenarios are represented. Their concurrent runner is
  intentionally separate from serialized package suites.
- The mirror contract exercises unavailable sources, unreadable metadata,
  directories and symlinks in metadata positions, fingerprint/revision
  mismatch, atomic install failure, retained backups, recovery, and the
  public-repository boundary. Its temporary-root cleanup is present for
  normal completion and assertion failures.
- The AI provider implementation itself documents and implements lazy client
  initialization. Finding 6 is about the contract's ability to detect a
  regression, not a reproduced eager initialization failure.
- The Poe guide explicitly uses `POE_API_KEY2`, the OpenAI-compatible `/v1`
  endpoint, and a lazy client example. Finding 7 is about the static contract's
  parser ceiling, not a live-provider or secret-handling failure.

## Deferred / not audited

- No fixes were made to smoke tests, contracts, route declarations, provider
  code, skill guidance, fixtures, validation tiers, or service
  implementations.
- The serve-proxy smoke was not executed because it is registered in the
  standard tier and the task explicitly capped validation at `test-fast`.
- The protected-map concurrency smoke was not executed because it is
  registered in the heavy tier. Its three route suites were inspected
  statically for fixture realism and cleanup.
- No live Poe, OpenAI, Clerk, API-server, production database, deployment, or
  external service access was performed.
- Findings 1–3 are harness timeout/cleanup risks; Findings 4–7 are validation
  coverage gaps. None is a claim that the current product services are
  failing in production.

**Report-only boundary:** This audit added this report only. No smoke test,
contract, service implementation, fixture, generated artifact, or validation
baseline was changed.