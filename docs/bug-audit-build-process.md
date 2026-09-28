# Bug Audit Report — End-to-End Build Process

**Scope:** Root build and typecheck ordering; API Server, Parts ID, and Canvas
builders and their serve/preview consumers; shared-library declaration builds;
API code generation; and build-related validation contracts.

**Mode:** Report-only. No application code, build configuration, generated
output, deployment, running service, or database was changed or started. This
report is the only intended repository change.

**Date:** 2026-09-24

**Stack:** pnpm workspace, Node.js 24, TypeScript project references, Orval,
Expo/Metro, esbuild, Vite, PostgreSQL/Drizzle, and the repository validation
tiers.

## Result

One new, verified Medium-severity security finding was identified: the Parts ID
web-export child process receives the full parent environment, and the native
Metro path also retains server variables outside its denylist. This verifies
build-time access to unrelated environment values; it does **not** establish
that any current secret is embedded in the browser bundle or that an existing
dependency exfiltrates one.

No previously reported build-process finding was verified as still reproducing
as a current defect. Several prior findings are resolved in the current code;
remaining checker-scope differences are listed as coverage gaps, not findings.

| ID | Status | Severity | Category | Location | Impact |
|---|---|---|---|---|---|
| B-001 | New; verified by environment-flow trace | Medium | Security | `artifacts/parts-id/scripts/build.js:250-303,808-834` | Expo build-time code can read unrelated server credentials inherited by Metro and the web-export process. |

## Build graph and artifact consumers

| Stage | Current path and prerequisite | Output and consumer |
|---|---|---|
| Root build | `package.json:7`: `pnpm run typecheck` must finish successfully before the recursive `pnpm -r --if-present run build` phase starts. | Does not require every workspace package to define its own build script. |
| Root typecheck | `package.json:8-10`: codegen check, DB schema check, shared-library `tsc --build`, then recursive artifact/scripts typechecks. `pretypecheck:libs` runs `api-spec:codegen:ensure`. | Establishes generated API clients and library declaration outputs before artifact checks. |
| API code generation | `lib/api-spec/package.json:12-19`: codegen runs under the shared `codegen` serial-lock resource; `run-codegen.mjs` validates dependency floors, invokes Orval, then rebuilds libraries. `codegen:check` additionally checks generated inventory, route drift, React barrel reachability, and React declaration output. | Generated API-client and Zod source under `lib/api-client-react/src/generated` and `lib/api-zod/src/generated`; declaration output under library `dist/` directories. |
| Shared libraries | Root TypeScript references in `tsconfig.json:5-33`; `typecheck:libs` invokes `tsc --build`. | Composite-project declaration outputs under `lib/*/dist`; consumed through workspace package `types` exports and by artifact typechecks. |
| API Server | `artifacts/api-server/package.json:10-12`: `build` checks `DATABASE_ENV=production` and runs `build.mjs`; `build.mjs:13-16` removes `artifacts/api-server/dist` before esbuild writes the Node ESM bundle and linked source map. | `artifacts/api-server/dist/index.mjs`; `start` serves this existing output and does not build or freshness-check it. The production-target assertion checks the mode, not database connectivity. |
| Parts ID | `artifacts/parts-id/package.json:9`: `build.js` clears `static-build/` and Metro caches, builds native bundles/manifests/assets, checks native domains, then runs Expo web export. Contact-data sanitization, content-hash and domain checks run after export; build metadata is written last. | Timestamped native bundles/assets and manifests under `static-build/`, plus `static-build/web`; production `server/serve.js` preflights required files, metadata, JSON, JS directory, domain, and stale marker timestamps before binding. |
| Canvas / mockup-sandbox | `artifacts/mockup-sandbox/package.json:8-10`: `build` runs Vite and `preview` serves its existing output; no package pre-build or freshness hook is declared. | `artifacts/mockup-sandbox/dist/`; preview was not configured as a current workflow or started for this audit. |

The root typecheck is the explicit prerequisite for the root build. Standalone
artifact `start` and Canvas `preview` commands consume existing output instead;
their output-freshness behavior was inspected but not exercised.

## Verified finding

### B-001 — Parts ID Expo build subprocesses inherit server environment values

- **File and line:** `artifacts/parts-id/scripts/build.js:250-303,808-834`
- **Category:** Security
- **Severity:** Medium
- **Failure scenario:** A Parts ID build runs in an environment containing
  server credentials such as database, session, AI-provider, administrator,
  backup, or GitHub credentials. `startMetro()` begins with all of
  `process.env` and removes only a fixed list plus unknown `EXPO_PUBLIC_*`
  variables. Other server credentials remain available to Metro and any
  build-time configuration/plugin code it loads. Separately, `buildWeb()`
  passes an unfiltered copy of the entire parent environment to
  `pnpm exec expo export`. A faulty or compromised build-time plugin or
  dependency could read, log, or transmit those values during a client build.
- **Evidence:** `startMetro()` spreads `process.env` at line 290, then filters
  only `SERVER_ONLY_ENV_VARS` and unknown `EXPO_PUBLIC_*` keys at lines
  297-303. The denylist does not cover every configured secret name. The
  web-export environment independently spreads `process.env` at line 809 and
  passes the resulting object as the child `env` at lines 825-834 without
  applying either filter. The task environment lists server secrets including
  `ADMIN_PASSWORD`, `APP_PASSWORD`, `INVENTORY_BACKUP_TRIGGER_SECRET`,
  `GITHUB_PAT`, and `GITHUB_TOKEN`, none of which appears in the native denylist.
  No secret values were read. A source search found no current Parts ID app
  reference to those specific secret names; therefore this finding concerns
  unnecessary build-process access, not a verified client-bundle disclosure.
- **Recommended fix:** Construct one explicit, minimal child environment for
  both native Metro and web export. Preserve only required runtime/toolchain
  variables and the known public Expo configuration values already assembled
  for the build; do not inherit arbitrary server variables. Add a unit test
  using harmless sentinel variables to prove that server-only and unknown
  values are absent from both child environments while required public values
  remain present.

## Possible fix-task option

This is a suggestion only; no fix task was created or executed.

| Finding | Suggested task title | Goal and scope | Priority | Expected outcome | Dependencies |
|---|---|---|---|---|---|
| B-001 | **Keep server credentials out of Parts ID Expo builds** | Replace the native/web build subprocess environment inheritance with a shared explicit allowlist; add sentinel-based tests covering both launch paths. | Medium | Neither Metro nor Expo web export receives database, session, provider, admin, backup, GitHub, or unrecognized environment variables; required build and public app settings remain available. | None. Coordinate with proposed Task 1896, “Audit Parts ID security,” to avoid duplicating any remediation it may include. |

## Prior-report comparison

The following statuses compare the findings in
`docs/bug-audit-package-runtime-validation.md` and
`docs/bug-audit-api-codegen-validation.md` with current source. These are not
counted as new findings.

| Prior finding | Current disposition |
|---|---|
| Package Runtime R-001 — codegen timeout could accept merely non-empty stale output | **Resolved in current code.** `codegen:ensure` runs under the shared serial-lock resource and fails when the codegen child or lock setup fails; the old timeout fallback accepting `generatedOutputPresent()` is absent. |
| Package Runtime R-002 — schema check could match a column on a different table | **Resolved in current code.** `schema-check.ts:101-139` builds a `Map<table, Set<column>>` from parsed migration columns and checks the expected columns against the matching table. |
| Package Runtime R-003 — local API React declaration lacked `totalOpOq` | **Not reproduced in the current workspace.** The current generated source and local ignored `dist` declaration both contain `totalOpOq`. The local `dist` file is not tracked; this audit did not regenerate it. |
| Package Runtime R-004 — Parts ID server could bind and serve a fallback without a production build | **Resolved in current code.** Production startup calls `preflightWebArtifact`; missing/empty required web/native outputs, malformed metadata, invalid JS/domain checks, or artifacts newer than the build marker cause startup to exit before listening. |
| API Codegen 1 — boot and post-merge codegen used different locks | **Resolved in current code.** Both paths use the `codegen` resource; the generator runner refuses to run without the live shared lock. |
| API Codegen 2 — stale-lock cleanup could remove a replacement lock | **Resolved in current code.** Lock acquisition and reclaim use a kernel-backed `flock` guard and token-checked ownership operations. |
| API Codegen 3 — post-merge could accept an incomplete generated tree | **Resolved in current code.** Post-merge preflight and postflight use the shared generated-output inventory, including missing, empty, unexpected, and untracked source output checks. |
| API Codegen 4 — `api-zod` declarations were not in React `dist:check` | **Checker-scope gap; not verified as a current root-build defect.** The dedicated declaration comparator remains React-specific, but codegen runs `typecheck:libs` and the root typecheck does so again before artifact typechecks. No missing or stale `api-zod` output was demonstrated. |
| API Codegen 5 — ensure marker omitted generator dependency inputs | **Resolved in current code.** The marker hash includes the resolved Orval dependency graph, lockfile version, package generator settings, Node, and pnpm versions. |
| API Codegen 6 — stale extra React declarations were ignored | **Resolved in current code.** The checker inventories fresh and existing declaration files and compares both against the expected declaration inventory. |
| API Codegen 7 — unexpected/untracked generated source could evade drift checks | **Resolved in current code.** The generated-output checker rejects unexpected files and, in the repository, untracked expected generated outputs. |

The only prior codegen limitation retained as a coverage note is that the
dedicated declaration comparator does not independently compare `api-zod`
declaration bytes. Current root typecheck rebuilds library declarations before
artifact checks, so no end-to-end failure was reproduced in this report-only
audit.

## Ten-category disposition

1. **Null / undefined safety:** No separate build-path finding verified.
   Builders validate required domains and configuration, check child process
   errors/exits, and reject missing bundle directories before post-export
   checks.
2. **Async & timing:** No independent promise-lifecycle defect verified.
   Parts ID build sequencing awaits each stage; no build was run to exercise
   remote Metro timing.
3. **Error handling:** No additional finding. API Server build rejects esbuild
   failures; Parts ID propagates child errors/nonzero exits and writes build
   metadata only after its web checks; production serve preflight fails closed.
4. **Type safety:** No additional finding. Root library and artifact typechecks
   are ordered before the root build. The separate `api-zod` declaration
   comparator limitation is recorded above as a coverage gap.
5. **State & data integrity:** No additional stale-output finding verified.
   Codegen uses a required/unexpected output inventory; API Server and Parts ID
   remove old build output before rebuilding, and Parts ID writes its marker
   last.
6. **Security:** **B-001** verifies unnecessary server-environment access by
   Expo build subprocesses. No evidence showed those values in current browser
   bundle bytes.
7. **Performance:** No build-specific performance defect verified. Production
   build durations and memory use were not measured because builds were not
   run.
8. **Concurrency & shared state:** No additional race verified. API codegen
   and post-merge generation share the serialized `codegen` resource. Build
   commands themselves were not run concurrently.
9. **Dead / unreachable code:** No separate finding verified in the traced
   build entry points.
10. **Dependency hygiene:** No new dependency defect verified. Fast-tier
     dependency-contract steps were skipped after the earlier fast-tier
     failure; no standalone package vulnerability scan was run because
     validation is capped at `test-fast`.

## Baseline signals and validation limits

The failure-baseline catalog lists no authoritative pre-existing test
failures. The workspace was clean before this report was added. Generated
source directories had no working-tree changes when inspected. The local
ignored React declaration file matched the current `totalOpOq` source shape.

| Signal | Result |
|---|---|
| Static build-graph/source trace | Completed for the root, API Server, Parts ID, Canvas, codegen, and shared-library consumers described above. |
| Parts ID child environment | **Verified statically:** native Metro gets a spread-and-denylist environment; web export gets a full environment spread. No secret values were read. |
| Parts ID sanitizer/hash candidate | **Rejected as a finding:** A disposable post-export-only fixture did produce a filename/hash mismatch after sanitization. That fixture omitted Metro’s configured custom serializer, which sanitizes web artifacts and recomputes hashed filenames/references before export. Existing focused tests cover that serializer path, but were inspected rather than executed. The fixture therefore does not reproduce the configured build path. |
| `pnpm run test-fast` | **Failed at `public-repository-boundary`** after 19 steps passed. The failing check reports that provider-retained pull-request refs are absent from the fetched ref set; fail-fast skipped the remaining 21 steps, including typecheck, lint, and dependency contracts. No other validation tier was run. |
| Isolated failure retries | `node scripts/test/public-repository-boundary.test.mjs` reproduced the same missing-provider-ref failure in 3/3 isolated attempts. This is an observed validation limitation, not an authorized pre-existing-failure waiver; no validation code was changed. |
| Separate focused build tests | The Parts ID Jest suite was not run; the validation boundary requires only `test-fast`. A disposable hash fixture was used only to assess the sanitizer-order candidate above; existing serializer-path tests were inspected, not executed by this audit. |
| Separate dependency vulnerability audit | Not run; `pnpm audit` is outside the allowed validation command. The fast-tier dependency/security contract steps were configured but skipped after the earlier failure. |
| Production builds / API startup / Parts ID build / Canvas preview | Not run. API Server build removes `dist/`; Parts ID build clears `static-build/` and Metro caches; production startup, Preview, and deployment are outside the allowed boundary. |
| Database or production prerequisites | No database command, live service, production credential, or deployment was used. API Server’s database-target assertion and the Parts ID production-domain path were inspected statically only. |

## Report-only boundary

No source, package manifest, build configuration, validation configuration,
generated file, build output, database, or live service was changed. The
possible fix in this report is not an approved implementation task; approval
should be requested before any remediation is started.