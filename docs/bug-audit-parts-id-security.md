# Parts ID Security Audit Report

**Scope:** Parts ID API server, mobile/web client, and shared storage/database security boundaries.
**Mode:** Report-only.
**Date:** 2026-09-24.
**Stack:** TypeScript, React Native/Expo, React, Express, PostgreSQL/Drizzle, Jest, pnpm.

## Summary

Four verified security findings were identified: three Medium and one Low. No Critical or High product-code finding was verified. This is not a claim that the application is vulnerability-free; the limitations below describe paths and configurations that were not verified.

| Severity | Verified findings |
|---|---:|
| Critical | 0 |
| High | 0 |
| Medium | 3 |
| Low | 1 |

The dependency audit reported two High upstream advisories for `image-size` version `2.0.2`. The checkout has a lockfile-registered local parser-safety patch, and no Parts ID TypeScript/TSX application source imports the package. The advisories are recorded as a tooling signal, not as a verified unmitigated product finding; see Tooling results.

No product code, tests, credentials, external services, or configuration were changed. The only intended change from this audit is this report.

## Findings at a glance

| # | Severity | Finding | Primary file and line |
|---|---|---|---|
| 1 | Medium | Device-wide search and scan histories remain visible after account changes. | `artifacts/parts-id/utils/searchHistory.ts:5-6`; `artifacts/parts-id/utils/scanHistory.ts:5` |
| 2 | Medium | Side-effectful PostgreSQL functions can bypass the admin query endpoint’s rollback-based read-only promise. | `artifacts/api-server/src/routes/adminQuery.ts:183-217,268-281` |
| 3 | Medium | Sensitive-column filtering can be bypassed by renaming a result column. | `artifacts/api-server/src/routes/adminQuery.ts:105-132,283-292` |
| 4 | Low | Admin SQL failures return raw database/driver messages. | `artifacts/api-server/src/routes/adminQuery.ts:351-369` |

## Scope and method

Read-only tracing covered:

- API server startup, method-aware route access inventory, application/admin authorization, request-body ordering, upload authorization/limits, and SQL/query boundaries.
- Parts ID Clerk token retrieval and local session cleanup, client API-origin construction, local persistence, search/scan history, and public/static client assets.
- Shared database runtime-mode guards and private object-storage boundaries.
- Relevant authorization, storage, upload, and parser-safety tests/contracts by source inspection.

The route access matrix is method-aware, enumerates mounted API declarations, and has explicit completeness/admin-guard checks in `routeAuthorizationMatrix.integration.test.ts`. The inspected public routes are limited to health and warehouse-layout reads. No route-authorization bypass, object-ownership failure, unbounded upload path, DDL/DML or stacked-statement execution bypass, or database runtime-mode escape was verified in the inspected paths. The separate SQL-function side-effect issue below concerns the admin query endpoint’s incomplete read-only boundary.

The canonical Bug Audit skill source was not available under `.agents`; a non-canonical runtime copy was not used. This audit therefore follows the assigned task procedure and the repository’s prior bug-audit report structure.

## Verified findings

### 1. Device-wide search and scan histories remain visible after account changes

- **Severity:** Medium
- **Classification:** Confirmed local privacy-boundary defect.
- **Affected locations:**
  - `artifacts/parts-id/utils/searchHistory.ts:5-6,37-43,74-80,86-99` — query and viewed-item histories use fixed AsyncStorage keys and load without an account identity.
  - `artifacts/parts-id/utils/scanHistory.ts:5,35-42,47-52` — barcode scan history uses one fixed device-wide key.
  - `artifacts/parts-id/hooks/useScanHistory.ts:18-29` — loads that history when the hook mounts, without associating it with a signed-in user.
  - `artifacts/parts-id/app/(tabs)/index.tsx:772-776,1560-1587` — loads and displays recent searches and viewed items.
  - `artifacts/parts-id/components/BarcodeScreen.tsx:549-605` — displays recent scan details, including barcode, matched catalog/vendor, and admin-action labels.
  - `artifacts/parts-id/contexts/AppContext.tsx:363-369,745-766`; `artifacts/parts-id/utils/sessionStorage.ts:20-25` — identity changes abort selected asynchronous work, while logout clears session and search-cache keys but does not clear or scope these histories.
- **Exposure scenario:** On a shared device, account A searches for or scans parts and signs out. Account B then signs in and opens Search or Barcode; the fixed device-wide keys are loaded and A’s recent searches, viewed items, and scans are displayed. Up to 10 search/viewed entries and 50 scans can remain, including records labeled as admin-linked or admin-created.
- **Impact and limits:** This exposes account-specific activity to a later user of the same installation. It does not grant API access or expose the shared inventory/floor-plan caches, which are not treated as private user history in this finding.
- **Recommended remedy:** Namespace these histories by the current Clerk user ID and clear in-memory state on identity change/logout. Discard legacy unscoped history rather than assigning it to the next account. Ensure asynchronous loads/saves cannot publish one account’s entries after a switch, and retain the intentionally shared inventory and public-layout caches.

### 2. Side-effectful SQL functions can mutate state despite the rollback

- **Severity:** Medium
- **Classification:** Confirmed read-only-boundary bypass for database functions with effects outside transactional rollback.
- **Affected locations:**
  - `artifacts/api-server/src/routes/adminQuery.ts:183-217` — the validator allows `SELECT`/`WITH`, rejects selected DDL/DML keywords, and does not reject all effectful PostgreSQL functions.
  - `artifacts/api-server/src/routes/adminQuery.ts:268-281` — the query executes in a transaction that is rolled back after success.
- **Test coverage note:** `artifacts/api-server/src/__tests__/adminQuery.test.ts:210-248` mocks the database and verifies that a `ROLLBACK` call occurs; it does not exercise PostgreSQL sequence behavior or prove that every `SELECT` is side-effect-free.
- **Exposure scenario:** An approved admin submits a syntactically valid `SELECT` that invokes a PostgreSQL sequence-mutating function. PostgreSQL sequence changes are not undone by transaction rollback; the endpoint therefore permits persistent database state changes through a route presented as read-only. Resetting a sequence can cause later inserts to collide with existing identifiers or fail until the sequence is repaired.
- **Impact and limits:** The route remains admin-only, and ordinary DML/DDL is blocked. The verified issue is that rollback is not a complete read-only control for every callable function; it does not establish non-admin access or arbitrary SQL statement execution.
- **Recommended remedy:** Enforce read-only behavior at the database boundary with a role/transaction policy that rejects state-changing operations and functions, rather than relying on rollback and a keyword blocklist. Add a test that demonstrates a disallowed effectful query cannot change persistent state.

### 3. Sensitive-column filtering can be bypassed with result aliases

- **Severity:** Medium
- **Classification:** Confirmed bypass of the admin-query sensitive-field filter.
- **Affected locations:**
  - `artifacts/api-server/src/routes/adminQuery.ts:79-97,105-132` — the denylist matches column names provided to the filter.
  - `artifacts/api-server/src/routes/adminQuery.ts:283-292` — those names are taken from PostgreSQL result-field labels, which reflect a query’s output aliases rather than the underlying source column.
- **Test coverage note:** `artifacts/api-server/src/__tests__/adminQuery.test.ts:296-326` tests direct `email` and `clerk_user_id` output labels; the inspected tests do not cover aliased sensitive columns.
- **Exposure scenario:** An approved admin selects a field the endpoint intends to suppress (for example, an email address or Clerk identity reference) but gives the result a non-sensitive output label. The filter sees only that label and returns the underlying value to the admin-query client.
- **Impact and limits:** This bypass is limited to the already-admin-only query tool. It defeats the explicit sensitive-column suppression for aliased output; no non-admin route to the data was found in this audit.
- **Recommended remedy:** Enforce the sensitive-data boundary using source-column lineage or restricted database views/roles, not only output labels. Add regression coverage showing aliases cannot return suppressed source fields.

### 4. Admin SQL failures return raw database/driver messages

- **Severity:** Low
- **Classification:** Confirmed privileged diagnostic-information disclosure.
- **Affected locations:**
  - `artifacts/api-server/src/routes/adminQuery.ts:251` — the route is guarded by `requireAdminAuth`.
  - `artifacts/api-server/src/routes/adminQuery.ts:351-369` — non-timeout failures use `err.message` directly as the HTTP 500 response body.
- **Exposure scenario:** An approved admin submits a query that fails. The caller receives the underlying PostgreSQL/driver diagnostic, which can reveal schema names, database behavior, or other internal implementation details. This is limited to callers who already pass the admin guard; no non-admin access to the route was found.
- **Impact and limits:** The message is an additional disclosure to an authenticated privileged caller, not an authorization bypass. The route’s query validation, row cap, timeout, rollback, and admin authorization remain in place.
- **Recommended remedy:** Return a stable client-safe error with the request ID for unexpected failures, while retaining only carefully sanitized operational diagnostics in server logs. Preserve the existing explicit timeout response and add a regression test proving internal database details do not appear in the response.

## Proposed fix-task mapping

The following are recommendations for user selection, not approved implementation work. At the time of the duplicate check, no existing open task matched these findings. The proposed follow-ups are **#1915** for Finding 1 and **#1916** for Findings 2–4. The completed task **#248 — “Audit fix: API server — redact sensitive logs & roll back partial saves”** addressed admin-query log redaction, not its database write boundary, sensitive-field filtering, or HTTP error response, so #1916 is not a duplicate. The existing route-authorization coverage task is also distinct from local-history privacy.

| Finding | Proposed task | Priority | Scope and observable acceptance criteria | Dependency / sequencing |
|---|---|---|---|---|
| 1 | **#1915 — Keep one user’s search and scan history private on shared devices** | P1 — address before the next security-focused release | Scope the search-query, viewed-item, and barcode-scan histories to the signed-in identity; clear account-owned in-memory state on sign-out or identity change; discard legacy unscoped entries. Tests prove A’s entries never appear for B after logout/account switch, including when an earlier async load finishes late. Shared inventory and floor-plan caches remain available across accounts. | No dependency; can be implemented independently. |
| 2, 3, 4 | **#1916 — Keep the admin query tool read-only and prevent sensitive-data leaks** | P2 — admin-endpoint hardening | Enforce a database-level read-only boundary that rejects effectful functions even if wrapped in `SELECT`; prevent aliases from returning protected source columns; return a stable safe error and request ID for unexpected failures while preserving timeout behavior. Tests prove a sequence-changing query cannot alter persistent state, aliases cannot return filtered fields, internal driver details do not appear in responses, and ordinary permitted reads still work. | No dependency; can be implemented independently of Finding 1. |

## Tooling results

- **Failure baseline:** `docs/validation/failure-baseline.json` contained zero active records before this audit.
- **Dependency audit:** `pnpm audit --audit-level=low` exited 1 and reported two High advisories for `image-size` version `2.0.2`: **GHSA-w3rx-r6r6-pgpr** (ICNS parser denial of service) and **GHSA-5p2g-fcmc-qvqq** (JXL/HEIF parser denial of service). `pnpm audit --prod --audit-level=low` reported the same advisories through the Expo → Metro dependency path. The upstream package version remains flagged; the workspace lockfile registers a local parser-safety patch for that package, which adds ICNS entry-length checks and HEIF/JXL box-size checks. The package is also listed as a Parts ID development dependency, and no Parts ID application TypeScript/TSX import was found. This is a real audit signal, but the reviewed patch and build-tool-only usage mean an unmitigated app-runtime vulnerability was not verified.
- **Public-repository boundary:** The final `test-fast` history scan checked 1,324 tracked paths and 10,313 reachable blobs; its summary reported nine historical private-path categories requiring owner-led remediation. This repository-history signal is outside the Parts ID runtime findings listed above and is not counted as a product finding. Raw paths and values are not reproduced here.
- **Assigned validation:** The final standalone `pnpm run test-fast` passed with exit code 0 (41/41 steps). The first foreground invocation reached the shell’s 300-second limit during the history scan; an earlier standalone retry passed before this report was staged. The completion callback then launched all four registered tiers despite the task’s fast-only plan; all stopped at the repository-boundary check because the report’s package-patch filename matched its email heuristic. That notation was removed, and the final assigned fast run passed. No higher tier was rerun after correction, per plan. Lint output also included a Knip diagnostic that `vite.config.ts` could not load because `PORT` was unset. The runner still reported the complete fast tier as passed; this is an environment/tooling signal, not a product finding.
- **API/mobile integration suites:** Not run separately. The assigned validation tier is `test-fast`; it includes static route-authorization and patched-dependency contracts, but not the full API route-authorization integration suite or Parts ID auth/history UI suites.
- **Production probing:** No production account, service, or database was contacted. No live attack or mutation was performed.

## Unverified candidates and audit limitations

- **Production API origin may accept HTTP:** `artifacts/parts-id/utils/apiBase.ts:5-24,36-47` accepts `EXPO_PUBLIC_API_BASE` without requiring HTTPS; `artifacts/parts-id/utils/appAuth.ts:145-160` supplies the Clerk token to API requests. A cleartext endpoint could expose bearer tokens on a client/platform configured to permit it. The checked Expo manifest has no explicit allow-cleartext setting, HTTPS-page browsers block active mixed content, and the actual production build profile/device policy was not inspected. Therefore cleartext token exposure is **not counted as a verified finding**. The build-time value and generated release binaries remain unaudited.
- **Clerk email-identity migration:** `requireAppAuth` migrates an existing user row by email for a newly seen Clerk ID. The code path was noted, but the Clerk-side verification/configuration guarantees needed to prove an unverified-email takeover were not established. It is **not counted as a verified finding**.
- The report is based on static code tracing and existing test/contract definitions; it is not a penetration test, deployment review, or sign-off for every client build profile.
- The Canvas artifact, production configuration values, environment secrets, live network traffic, and production data were not inspected. No secret values were read or displayed.

**Report-only boundary:** No findings were fixed. The task proposes follow-up work only; each proposed fix requires separate user approval.