# Bug Audit Report — Package Runtime Validation

**Scope:** Package-level build, start, preview, generation, dead-export, and
runtime-validation commands for the API Server, Parts ID, Canvas, API
specification, database, root workspace, scripts package, and shared libraries.
Canonical tier orchestration was inventoried for ownership but not re-audited.

**Mode:** Report-only. No package manifest, source file, build output, generated
file, database, or runtime command was changed or started by this audit.

**Date:** 2026-09-16

**Stack:** pnpm workspace, Node.js 24, TypeScript, Expo/Metro, Vite, esbuild,
Drizzle, PostgreSQL, Orval, Jest, Vitest, and Knip.

## Baseline and method

The repository was clean before this report was added. The audit used static
traces and safe focused checks. Production builds, API startup, Expo startup,
Canvas preview, database mutation commands, and deployment were intentionally
not run.

| Check | Result |
|---|---|
| `pnpm --filter @workspace/api-spec run dependency:check` | Passed |
| `pnpm --filter @workspace/api-spec run barrel:check` | Passed; 286 generated names reachable |
| `pnpm --filter @workspace/api-spec run spec:check` | Passed |
| `pnpm --filter @workspace/db run schema:check` | Passed; 26 tables and 188 columns checked |
| `pnpm --filter @workspace/scripts run tsconfig:check` | Passed; 8 library tsconfigs accounted for |
| `pnpm --filter @workspace/api-spec run dist:check` | **Failed**; committed `generated/api.schemas.d.ts` is stale and omits `totalOpOq` from the inventory response documentation |
| `pnpm run test-fast` | Required completion validation; result is recorded below |

The `dist:check` failure is a current repository baseline signal, not a change
made by this audit. Its temporary TypeScript output was removed by the check's
`finally` block. The audit did not run `codegen` to repair the drift because
that would modify generated output and violate the report-only boundary.

## Command matrix

`Tier ownership` identifies the canonical validation step that reaches a
command directly or through an explicit package script. `Not owned` means the
command is available to developers or release tooling but is not independently
covered by the canonical tiers.

### Root workspace and scripts package

| Package | Command | Hooks/prerequisites and boundary | Tier ownership |
|---|---|---|---|
| Root | `build` | Runs root `typecheck`, then recursively runs package `build` scripts with `--if-present`; it does not require every workspace package to declare a build script | Not independently owned |
| Root | `typecheck` | Runs API codegen check, DB schema check, library declaration build, then artifact/scripts typechecks | Reached by package-specific typecheck steps, but not as this root command |
| Root | `typecheck:libs` | `pretypecheck:libs` runs `api-spec codegen:ensure`; `tsc --build` emits declaration output into shared library `dist/` directories | Reached by `tsc` and Parts ID typecheck |
| Root | `codegen:check` | Delegates to API spec `codegen:check`, which regenerates, checks source drift, route drift, barrels, and client declarations | Reached by standard `codegen-check` |
| Root | `lint:libs` | ESLint over `lib/` | Reached by fast `lint` |
| Root | `test-fast`, `test-standard`, `test-standard-plus`, `test-heavy` | Serial-lock wrappers around canonical tiers; these orchestration scripts are out of this audit's scope | Canonical orchestration; not re-audited |
| Scripts | `lint:mocks`, `tsconfig:check`, `env:check`, `privacy:check`, `typecheck` | Static checks over mocks, references, environment declarations, privacy, and scripts code | Reached by fast/standard steps |

### API Server artifact

| Command | Hooks/prerequisites and output | Tier ownership |
|---|---|---|
| `predev` | Runs API codegen guard before `dev` | Not independently owned |
| `dev` | Requires `PORT`; frees it, sets `NODE_ENV=development` and `DATABASE_ENV=development`, then runs `tsx src/index.ts` | Not owned |
| `build` | Runs `check:production-database-target`, then removes and recreates the esbuild `dist/` output | Not owned |
| `check:production-database-target` | Explicit production database-target assertion; confirms only `DATABASE_ENV=production`, does not check `DATABASE_URL` or connectivity, and produces no build output | Reached by standard `production-database-target` with production env |
| `start` | Runs `node --enable-source-maps ./dist/index.mjs`; no build or freshness check | Not owned |
| `typecheck` | Production and test TypeScript passes; `pretypecheck` runs codegen guard | Reached by fast `tsc` |
| `test`, `test:coverage`, `test:provider` | Database-mode wrapper and serialized test runner; provider test opts into a live provider | Coverage is canonical in standard-plus; live provider command is not owned |
| `lint`, `dead-exports` | ESLint followed by Knip, or Knip alone | `lint` reached by fast; `dead-exports` reached through it |
| `seed`, `seed:reference`, `seed:barcodes` | Database-writing/manual data operations with no canonical tier ownership | Not owned |
| `gen:map` | Generates a raw map TypeScript module from SVG | Not owned |

### Parts ID artifact

| Command | Hooks/prerequisites and output | Tier ownership |
|---|---|---|
| `predev` | Runs API codegen guard | Not independently owned |
| `dev` | Requires `PORT` and several Replit/Expo environment values; frees the port and starts Expo with `--clear` | Not owned |
| `build` | Runs the custom Metro/Expo build script; it clears and recreates `static-build/`, starts Metro, downloads bundles/manifests, verifies domains, and exports web | Not owned |
| `serve` | Frees `PORT` and starts `server/serve.js`; it does not invoke or validate `build` output | Not owned |
| `pretest` | Regenerates `.expo/types/router.d.ts` before tests | Not independently owned |
| `pretypecheck` | Regenerates router types and checks shim compatibility versions | Not independently owned |
| `typecheck` | Runs root library declaration build, then the app typecheck | Reached by fast `tsc` |
| `test`, `lint` | Jest-like custom test runner and ESLint | `lint` reached by fast; test is reached by standard shared tests |
| `gen:map` | Generates the raw map TypeScript module from SVG | Not owned |
| `check:bundle-domain` | Scans a built bundle for the expected domain and forbidden dev domains | Reached by fast `bundle-domain-check` |
| `test:serve-proxy` | Focused static server/API proxy test | Reached by standard `serve-proxy-smoke` |

### Canvas / mockup-sandbox artifact

| Command | Hooks/prerequisites and output | Tier ownership |
|---|---|---|
| `dev` | Requires `PORT` and `BASE_PATH`; Vite config also reads the registered API port and configures `/api` proxying | Not owned |
| `build` | Vite build into `dist/`; no package pre-hook | Not owned |
| `preview` | Vite preview of the existing `dist/`; no build or freshness check | Not owned |
| `typecheck` | Vite/React TypeScript check | Reached by fast `tsc` |
| `lint` | ESLint followed by `dead-exports` | Reached by fast `lint` |
| `dead-exports` | Knip with `PORT=5000` and `BASE_PATH=/__mockup` | Reached through fast `lint` |
| `test` | Vitest | Reached by standard shared tests |
| `test:protected-map-smoke` | Protected map smoke test | Reached by heavy |

### API specification package

| Command | Hooks/prerequisites and output | Tier ownership |
|---|---|---|
| `codegen` | Runs dependency floors, Orval with clean generated directories, post-codegen processing, and root library declaration build | Reached through standard `codegen-check` |
| `codegen:ensure` | Hash/lock guard for generated API clients; used by API and Parts ID pre-hooks | Indirectly reached by typecheck and artifact pre-hooks |
| `codegen:check` | Runs `codegen`, checks tracked generated source drift, route drift, barrel reachability, and API client declarations | Reached by standard `codegen-check` |
| `codegen:fix` | Runs codegen, stages generated sources, and may commit them automatically before route checking | Not owned |
| `dependency:check` | API dependency-floor check | Reached through `codegen` |
| `spec:check` | Route/OpenAPI drift check | Reached by standard `spec-check` and `codegen:check` |
| `barrel:check` | Generated-name reachability check | Reached through `codegen:check` |
| `dist:check` | Rebuilds temporary API client declarations and compares four committed declaration files | Reached through `codegen:check`; also runnable independently |
| `test` | Jest tests for specification helpers | Reached by standard `spec-check-tests` |

### Database package

| Command | Hooks/prerequisites and output | Tier ownership |
|---|---|---|
| `generate` | Drizzle migration generation; `drizzle.config.ts` requires `DATABASE_URL` and `DATABASE_ENV` of `development` or `test` | Not owned |
| `push`, `push-force` | Database-mutating schema synchronization; same development/test environment guard | Not owned |
| `schema:check` | Static schema/migration/barrel/taxonomy check; no database connection | Reached by standard-plus |
| `verify-reference-log-indexes` | Database-backed index verification | Not owned |
| `verify-fts` | Database-backed full-text index and planner verification | Reached by standard-plus |

### Shared libraries

The shared libraries (`api-client-react`, `api-zod`, `db`, the AI integration
packages, and `zone-validation`) do not define package-level build, start,
preview, test, or dead-export scripts. Their declaration output is generated
by the root `tsc --build` invoked through `typecheck:libs`, and their source
typechecks are therefore covered indirectly. `api-client-react` and `api-zod`
export `dist/` types while their default workspace condition resolves source
TypeScript, so declaration freshness remains a separate concern from source
typechecking.

## Ten-category coverage

| Category | Result |
|---|---|
| Security | No new package-script secret or production-database bypass was verified. Database schema synchronization rejects production targets. |
| Null / undefined safety | Required `PORT`, `BASE_PATH`, database target, and generated-file checks were traced; no separate verified finding. |
| Async & timing | Covered by the codegen lock and timeout analysis in Finding R-001; no additional finding. |
| Error handling | Covered by the static-server fallback analysis in Finding R-004 and the declaration-check baseline in Finding R-003. |
| Type safety | Finding R-003 covers stale committed declaration output; source TypeScript coverage itself passed the focused reference check. |
| State & data integrity | Finding R-002 covers table/column scope loss in schema validation. |
| Performance | Build and validation commands were inspected for unbounded package-level loops or repeated rebuild hooks; no separate finding. |
| Concurrency & shared state | Finding R-001 covers the shared generated-client directory and lock-timeout fallback. |
| Dead / unreachable code | Knip/dead-export commands are present and owned by fast lint where applicable; no separate finding. |
| Dependency hygiene | Workspace package scripts use pinned pnpm/Node declarations and focused dependency floors passed; no separate finding. |

## Summary of verified findings

| ID | Severity | Category | Location | Impact |
|---|---|---|---|---|
| R-001 | Medium | Concurrency & shared state | `lib/api-spec/scripts/ensure-codegen.mjs:256-265` | A codegen lock timeout can accept non-empty but stale generated clients after the API spec changes. |
| R-002 | Medium | State & data integrity | `lib/db/scripts/schema-check.ts:101-120` | A column with the same name on another table can satisfy a missing-column check. |
| R-003 | Medium | Type safety / stale artifact | `lib/api-spec/src/check-dist-declarations.ts:72-76,120-139`; `lib/api-spec/package.json:13` | The current committed API client declaration artifact is stale; consumers can resolve incomplete declarations. |
| R-004 | Medium | Error handling / runtime artifact | `artifacts/parts-id/package.json:10`; `artifacts/parts-id/server/serve.js:98-132,194-222` | The static server can bind and return a landing page without a usable Expo web artifact. |

## Findings

### R-001 — Codegen timeout fallback accepts stale generated clients

- **Location:** `lib/api-spec/scripts/ensure-codegen.mjs:256-265`
- **Category:** Concurrency & shared state
- **Severity:** Medium
- **Failure:** When `acquireLock()` times out after ten minutes, the fallback
  accepts either `inSync(hash)` **or merely** `generatedOutputPresent()`.
  `generatedOutputPresent()` only checks that a small set of generated files is
  non-empty; it does not compare them to the current input hash.
- **Realistic failure scenario:** An API specification changes while another
  codegen process remains live or hung. A second API Server or Parts ID dev boot
  waits ten minutes, sees old non-empty generated files, logs
  “proceeding without regenerating,” and starts against clients that do not
  represent the current specification.
- **Evidence:** The focused source probe confirmed the timeout branch contains
  `inSync(hash) || generatedOutputPresent()`. The normal path correctly hashes
  `openapi.yaml`, `orval.config.ts`, and `post-codegen.mjs`; the timeout path
  bypasses that hash requirement.
- **Recommended fix:** Fail closed unless `inSync(hash)` is true after the
  timeout, or make the waiting process revalidate the marker/hash before
  proceeding. Add a focused test for changed inputs plus a live lock and
  non-empty stale outputs. This audit made no fix.

### R-002 — Schema checker matches columns outside their table

- **Location:** `lib/db/scripts/schema-check.ts:101-120`
- **Category:** State & data integrity
- **Severity:** Medium
- **Failure:** The migration check first confirms table names globally, then
  checks each column with `allSQL.includes(\`"${entry.columnName}"\`)`. The
  column predicate is not scoped to the DDL block for `entry.tableName`.
- **Realistic failure scenario:** A migration creates `target_table` without
  its required `shared_name` column, while a different table contains a
  `shared_name` column. The checker reports the schema as synchronized even
  though a runtime query against `target_table.shared_name` can fail after
  deployment.
- **Evidence:** A non-mutating reproduction using the checker’s predicate
  returned `columnPresent: true` for `"shared_name"` in `"other_table"` while
  the target table was absent from the synthetic DDL. The current real
  repository passes because its actual migration set is complete; the issue is
  in the validator’s acceptance condition.
- **Recommended fix:** Parse migrations into table-scoped definitions and
  compare each table’s columns, or use a migration/snapshot parser that also
  validates type, nullability, defaults, and indexes. Add a regression fixture
  where the same column name appears on two tables. This audit made no fix.

### R-003 — Committed API client declarations are stale

- **Location:** `lib/api-spec/src/check-dist-declarations.ts:72-76,120-139`;
  command exposed by `lib/api-spec/package.json:13`
- **Category:** Type safety / stale artifact acceptance
- **Severity:** Medium
- **Failure:** The package’s declaration-validation command currently rejects
  the committed `lib/api-client-react/dist/generated/api.schemas.d.ts` because
  its inventory response documentation lacks `totalOpOq`, which is present in
  the freshly emitted declaration.
- **Realistic failure scenario:** A consumer resolving the package’s `types`
  export reads the committed `dist/` declaration rather than the current
  source shape. Editors and downstream TypeScript builds can therefore expose
  incomplete inventory response types even though source typechecks are clean.
- **Evidence:** `pnpm --filter @workspace/api-spec run dist:check` failed with:
  `generated/api.schemas.d.ts: first difference at line 115`, where the fresh
  output describes `orderPurchase`, `orderQuantity`, and `totalOpOq` while the
  committed output describes only the first two. The checker correctly caught
  this mismatch and did not modify the repository.
- **Recommended fix:** Regenerate and commit the declaration artifact through
  the repository’s approved codegen flow, then retain `dist:check` in the
  standard codegen gate. This audit made no generated-file changes.

### R-004 — Parts ID static server can be healthy without a usable build

- **Location:** `artifacts/parts-id/package.json:10`;
  `artifacts/parts-id/server/serve.js:98-132,194-222`
- **Category:** Error handling / runtime artifact validation
- **Severity:** Medium
- **Failure:** The `serve` script only frees the requested port and launches
  `server/serve.js`; it does not run `build` or validate a build marker,
  manifests, bundles, or web entrypoint before binding. If
  `static-build/web/index.html` is absent, `serveWebOrFallback()` falls through
  to the Expo Go landing page, and the server still binds successfully.
- **Realistic failure scenario:** A developer or release job runs `serve` in a
  fresh checkout or after a failed/partial build. A port-based health check sees
  the “Serving static Expo build” log and receives HTTP 200 HTML, but users get
  the landing page instead of the app. An older `static-build/` can likewise be
  served without any freshness signal.
- **Evidence:** The package script has no pre-hook. The server explicitly
  falls back to `serveLandingPage()` when the web build is absent and logs
  success from `server.listen()` without checking the required artifact set.
- **Recommended fix:** Add a preflight that requires the expected web entry,
  native manifests, and a build metadata/freshness marker; exit non-zero before
  binding when the output is missing or stale. Keep the landing-page fallback
  only for an explicitly selected development mode. This audit made no fix.

## Coverage gaps and deferred commands

The following commands are important but are not independently represented in
the canonical tiers. They are recorded as coverage gaps, not additional
verified findings:

- `artifacts/api-server:start` can run an old `dist/index.mjs` without proving
  it corresponds to current source. Its missing-file case fails loudly, so it
  was not promoted to a separate finding here.
- `artifacts/mockup-sandbox:preview` starts Vite against the existing `dist/`
  without a package pre-build or freshness check. It is not a configured
  workflow and was not started during this audit.
- `artifacts/parts-id:build`, API Server `build`, and Canvas `build` are not
  canonical validation steps. Their output guards were inspected statically;
  no build was run because production artifact creation is out of scope.
- `lib/db:generate`, `push`, `push-force`, and
  `verify-reference-log-indexes` are not canonical steps. The Drizzle config
  rejects missing or production database modes, but mutation commands were not
  executed.
- `lib/api-spec:codegen:fix` is not canonical and can stage/commit generated
  output. It was not run because this audit must not mutate generated files or
  history.
- Shared library package manifests have no independent `build`, `test`, or
  dead-export commands. Their source declaration coverage is indirect through
  root `tsc --build`; package-level artifact freshness is not uniformly
  validated.

## Validation result

The required completion command was run exactly:

```text
pnpm run test-fast
```

The fast tier passed all 27 steps. The completion validator also launched
standard, standard-plus, and heavy despite the task plan naming only
`test-fast`; their pre-test contract, typecheck, lint, codegen, environment,
privacy, and security steps passed, but each shared test step failed in the
untouched Parts ID suite. The three runs consistently reported nine failures
in `UploadScreen — rendered admin query workflow` and 2,274 passing Parts ID
tests; Canvas and API Server passed in each run. This matches the documented
Parts ID full-suite harness cluster in
`docs/bug-audit-parts-id-api-failures.md` and the related memory entries, so it
is classified as pre-existing rather than a regression from this report.

No heavier tier was intentionally selected by this task. The report does not
modify validation orchestration or change code to address those unrelated
failures.

## No-fix confirmation

This report is the complete deliverable for the report-only task. No package
manifest, source code, generated source, declaration output, build output,
runtime command, database, dependency version, or validation-tier definition
was changed.