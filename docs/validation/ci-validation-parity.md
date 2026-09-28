# CI validation parity

## Scope and evidence

**Collection date:** 2026-09-23
**Repository revision:** `0d71ad7eabbddcbc61718f94a830b133c8cf5018`

This report is a read-only parity analysis of the exact local revision above. The
revision is the checkout analyzed **before this report's commit**, not the hash
of the commit containing this report (which would be self-referential). It
does not change or trigger a workflow, validation command, branch policy,
credential, remote run, or connected-service state.

To refresh the two provenance headers after collecting a new report, run
`node scripts/refresh-ci-validation-parity-report.mjs` from the repository root.
The command captures `HEAD` while the report is being edited; on a clean
checkout where `HEAD` updated this report, the evidence revision is its first
parent. A later unrelated commit makes the report stale again. The command
replaces only those two headers. It fails without writing when a
header is missing, duplicated, or malformed. Review the resulting diff before committing;
the analysis below is otherwise preserved byte-for-byte, and the command does
not print or copy unrelated repository contents.

Revision-aware local evidence comes from the three tracked files under
`.github/workflows`, the shared action, `scripts/validation-steps.mjs`,
`scripts/run-tier.mjs`, `scripts/test-all.sh`, package scripts, and `.replit`.
The repository-owned routing matrix is supporting documentation, not live
provider evidence. On 2026-09-23, the already-authorized GitHub connection
returned HTTP 200 for `makerdan/EES-Parts-ID` and for an Actions runs query
filtered to this exact revision: `total_count: 0`, with an empty first page.
Thus no matching run, attempt, job, or failure log can establish execution or
passing for this revision. GitHub's `main` branch API returned
`79865dba26bcb283726fcd46e364830c07f2e151`, **not** the report
revision. Its readable protection and Actions settings are a dated provider
observation, not a revision-matched snapshot of this checkout. Current-revision
activation, passing, merge-queue execution, and revision-bound policy claims
remain **unknown**; older reports and runs are not promoted to current evidence.

Confidence vocabulary:

- **observed** — read directly from the exact local revision;
- **inferred** — follows deterministically from the tracked command path, but
  was not observed running remotely for this revision;
- **unknown** — current revision-aware provider run, log, or policy evidence
  was unavailable or incomplete.

## Workflow classification

| Workflow/job | Events | Controls and command path | Classification | Confidence |
|---|---|---|---|---|
| `CI` / `Portable validation` | PR open/update/reopen/ready; `merge_group` checks; push to `main`; manual | Ubuntu 24.04, 45 minutes, PostgreSQL 16.4, read-only contents, immutable checkout, full-history and pull-ref fetch, frozen install, workflow-only database prerequisites, then exactly `pnpm run test-standard-plus`; PR and merge-group supersession cancels older runs | pull-request/merge-group candidate validation, main-branch monitoring, and manual portable validation; actual execution for this revision unknown | observed |
| `CI` / `CI / required` | same `CI` run | five minutes; unconditional aggregator; succeeds only when `needs.validate.result` is `success` | stable fail-closed result aggregator; whether GitHub currently requires it is unknown | observed |
| `Scheduled security audit` / `Daily dependency audit (low+)` | daily 08:00 UTC; manual | Ubuntu 24.04, 15 minutes, read-only contents, frozen install, low-threshold audit with two named temporary exceptions expiring 2026-10-08 | scheduled/manual maintenance; duplicate audit signal, not the portable owner | observed |
| `Sync README from replit.md` / `Copy replit.md → README.md` | Monday 07:00 UTC; manual | Ubuntu 24.04, 10 minutes, `contents: write`; updates only `automation/sync-readme` and prints a compare URL | scheduled/manual maintenance writer; not validation | observed |
| `.github/actions/setup-node-pnpm` | called by all three workflows after checkout | `.node-version`, pnpm 10.26.1, lockfile-keyed cache, frozen install; all external actions are SHA-pinned | shared setup prerequisite | observed |

The repository tracks exactly three workflows. Only README maintenance has
write permission. `CI` has no matrix and, after its workflow-only database
prerequisites, runs the canonical tier sequentially. Its opt-in Poe provider step
is diagnostic, conditional, and
`continue-on-error`; it is not parity coverage. Artifact retention is also
diagnostic-only.

### CI-only database prerequisites

These commands are configured in `CI` / `Portable validation` for every PR,
`merge_group`, `main` push, and manual event before the canonical
`standard-plus` tier. They prepare that workflow's isolated PostgreSQL service;
they are not members of any local validation tier and do not change the tier
counts below.

| CI prerequisite | Event scope | Exact command path | Classification | Confidence |
|---|---|---|---|---|
| PostgreSQL readiness | PR open/update/reopen/ready; `merge_group` checks; push to `main`; manual | readiness loop → `pg_isready -h 127.0.0.1 -p 5432 -U postgres -d testdb` | workflow-only database readiness prerequisite; not canonical tier coverage | observed |
| PostgreSQL extension setup | PR open/update/reopen/ready; `merge_group` checks; push to `main`; manual | `psql "$DATABASE_URL" --set=ON_ERROR_STOP=1 --command="CREATE EXTENSION IF NOT EXISTS pg_trgm;"` | workflow-only isolated-database extension prerequisite; not canonical tier coverage | observed |
| Isolated PostgreSQL schema preparation | PR open/update/reopen/ready; `merge_group` checks; push to `main`; manual | `pnpm --filter @workspace/db run push-force` | workflow-only isolated-schema preparation; not canonical tier membership | observed |
| Inventory chip function provisioning | PR open/update/reopen/ready; `merge_group` checks; push to `main`; manual | `psql "$DATABASE_URL" --set=ON_ERROR_STOP=1 --file=lib/db/drizzle/inventory_chip_text.sql` | workflow-only isolated-database SQL function setup; not canonical tier membership | observed |
| Inventory chip function verification | PR open/update/reopen/ready; `merge_group` checks; push to `main`; manual | `psql "$DATABASE_URL" --set=ON_ERROR_STOP=1 --no-align --tuples-only --command="SELECT to_regprocedure('inventory_chip_text(text,text,text,text[])')::text;"` and fail unless the returned signature matches | workflow-only fail-closed function-signature check; not canonical tier membership | observed |

Replit-local execution is separate:

- `Project` delegates to `test-fast`;
- `test-fast`, `test-standard`, `test-standard-plus`, and `test-heavy` are named
  validation workflows;
- the Parts ID, API Server, and Canvas workflows are long-running development
  services waiting on ports 19000, 3001, and 8081, not CI jobs.

## Local-to-remote coverage map

The tiers are cumulative and contain 40 `fast`, 52 `standard`, 57
`standard-plus`, and 58 `heavy` steps. The table has exactly one row for every
current `standard-plus` member; the workflow-only database prerequisites above
are intentionally excluded. Except for the five task-provenance rows, the exact
remote path is `CI` → `Portable validation` →
`pnpm run test-standard-plus` → `scripts/run-tier.mjs` → the command registered
for that row in `scripts/validation-steps.mjs`.

| Canonical local check | Remote owner / exact command path | Classification | Confidence |
|---|---|---|---|
| `node-runtime` | canonical portable path → `node scripts/check-node-runtime.mjs` | direct | inferred |
| `gate-guard` | canonical portable path → `bash scripts/check-gate-integrity.sh` | direct | inferred |
| `plan-gate-fix` | none; remote runner adds `--allow-no-plan` | local-only: task archive/provenance | observed |
| `plan-gate-check` | none; remote runner adds `--declared-tier test-standard-plus --allow-no-plan` | local-only: task archive/provenance | observed |
| `plan-gate-stubs` | none; remote runner adds `--allow-no-plan` | local-only: task archive/provenance | observed |
| `regression-guard-fix` | none; remote runner adds `--allow-no-plan` | local-only: task declaration/provenance | observed |
| `regression-guard` | none; remote runner adds `--allow-no-plan` | local-only: task declaration/provenance | observed |
| `api-suite-floor-contract` | canonical portable path → `node scripts/test/api-suite-floor-contract.test.mjs` | direct | inferred |
| `protected-map-timeout-contract` | canonical portable path → `node scripts/test/protected-map-timeout-contract.test.mjs` | direct | inferred |
| `github-actions-contract` | canonical portable path → `node scripts/test/github-actions-contract.test.mjs` | direct | inferred |
| `validation-runtime-contract` | canonical portable path → `node scripts/test/validation-runtime-contract.test.mjs` | direct | inferred |
| `validation-parity-contract` | canonical portable path → `node scripts/test/validation-parity-contract.test.mjs` | direct | inferred |
| `api-route-authorization-contract` | canonical portable path → `node scripts/test/api-route-authorization-contract.test.mjs` | direct | inferred |
| `ai-provider-startup-export-contract` | canonical portable path → `node scripts/test/ai-provider-startup-export-contract.test.mjs` | direct | inferred |
| `poe-setup-targeted-correction-contract` | canonical portable path → `node skill-previews/poe-setup/targeted-correction-contract.test.mjs` | direct | inferred |
| `skill-mirror-sync-contract` | canonical portable path → `node scripts/test/skill-mirror-sync-contract.test.mjs` | direct | inferred |
| `public-repository-boundary` | canonical portable path → `node scripts/test/public-repository-boundary.test.mjs` | direct | inferred |
| `dependency-security-contract` | canonical portable path → `node scripts/test/dependency-security-contract.test.mjs` | direct | inferred |
| `parts-id-dependency-contract` | canonical portable path → `node scripts/test/parts-id-dependency-contract.test.mjs` | direct | inferred |
| `dead-exports-contract` | canonical portable path → `node scripts/test/dead-exports-contract.test.mjs` | direct | inferred |
| `dead-code-policy-contract` | canonical portable path → `node scripts/test/dead-code-policy-contract.test.mjs` | direct | inferred |
| `patched-dependencies-contract` | canonical portable path → `node scripts/test/patched-dependencies.test.mjs` | direct | inferred |
| `patched-dependencies` | canonical portable path → `node scripts/check-patched-dependencies.mjs` | direct | inferred |
| `replit-config-contract` | canonical portable path → `node scripts/test/replit-config-contract.test.mjs` | direct | inferred |
| `tsc` | canonical portable path → `pnpm run typecheck:libs` plus artifact/script typechecks | direct | inferred |
| `api-spec-typecheck-contract` | canonical portable path → `node scripts/test/api-spec-typecheck-contract.test.mjs` | direct | inferred |
| `api-spec-typecheck` | canonical portable path → API-spec `typecheck` | package-specific | inferred |
| `lint` | canonical portable path → DB reachability, three artifact lints, and library lint | direct composite | inferred |
| `lint-mocks` | canonical portable path → scripts `lint:mocks` | package-specific | inferred |
| `validation-parser-tests` | canonical portable path → scripts `test:parsers` | package-specific | inferred |
| `tsconfig-check` | canonical portable path → scripts `tsconfig:check` | package-specific | inferred |
| `static-validation-boundaries` | canonical portable path → `static-validation-boundaries.test.mjs` via scripts `tsx` | direct | inferred |
| `port-authority-contract` | canonical portable path → `node scripts/test-port-authority.mjs` | direct | inferred |
| `port-guard` | canonical portable path → serialized `scripts/check-hardcoded-ports.sh` | direct | inferred |
| `bundle-domain-check` | canonical portable path → Parts ID `check:bundle-domain` | package-specific | inferred |
| `browser-bundle-dependency-contract` | canonical portable path → `node scripts/check-browser-bundles.mjs` → each declared mobile/web artifact's `check:browser-bundle` script | package-specific fan-out | inferred |
| `browser-bundle-contract` | canonical portable path → `node scripts/test/browser-bundle-dependency-contract.test.mjs` | direct contract | inferred |
| `light-mode-config` | canonical portable path → `bash scripts/check-light-mode-config.sh` | direct | inferred |
| `ci-validation-parity-contract` | canonical portable path → `node scripts/test/ci-validation-parity-contract.test.mjs` | direct contract | inferred |
| `ci-validation-parity-revision-contract` | canonical portable path → `node scripts/test/ci-validation-parity-revision-contract.test.mjs` | direct contract preventing stale or malformed report revision metadata | inferred |
| `codegen-check` | canonical portable path → serialized API-spec `codegen:check` | package-specific | inferred |
| `spec-check` | canonical portable path → API-spec `spec:check` | package-specific | inferred |
| `env-check` | canonical portable path → scripts `env:check` | package-specific | inferred |
| `privacy-check` | canonical portable path → scripts `privacy:check` | package-specific | inferred |
| `privacy-check-contract` | canonical portable path → `node scripts/test/production-privacy-check.test.mjs` | direct | inferred |
| `production-database-target` | canonical portable path → production-mode API `check:production-database-target` | target-safety assertion; no production connection | inferred |
| `spec-check-tests` | canonical portable path → API-spec `test` | package-specific | inferred |
| `failure-gate-package-sync` | canonical portable path → `node scripts/publish-failure-gate.mjs --sync` | direct canonical-source synchronization | inferred |
| `failure-gate-contract` | canonical portable path → `node scripts/test/failure-gate-contract.test.mjs` | direct contract; task archive remains local-only | inferred |
| `protected-map-authorization` | canonical portable path → `DATABASE_ENV=test pnpm --filter @workspace/api-server exec node scripts/run-tests.mjs --runTestsByPath __tests__/protectedMapAuthorization.integration.test.ts` | direct request-level API authorization contract; local Clerk test double and test database only | inferred |
| `test` | canonical portable path → serialized `node scripts/serial-lock.mjs --resource shared-test-results --priority 2 -- pnpm test` → root `scripts/test-all.sh`: `pnpm --filter @workspace/api-spec run codegen:ensure`; `node scripts/test/api-suite-floor-contract.test.mjs`; timeout-wrapped Canvas Vitest (`180s`), Parts ID Jest (`300s`), and API Server Jest (`240s`) legs writing staged JSON results, published into the run-owned manifest; then `node scripts/test-timeout-report.mjs "$MANIFEST_FILE"` (the focused contract still searches for the obsolete literal `node scripts/test-timeout-report.mjs /tmp/jest-run-manifest.json`, which is **not** the executed command) | package-specific fan-out with harness preflight/post-processing, not a CI matrix | inferred |
| `serve-proxy-smoke` | canonical portable path → Parts ID `test:serve-proxy` | package-specific | inferred |
| `schema-check` | canonical portable path → DB `schema:check`; CI runs the separate isolated-PostgreSQL prerequisites first | direct | inferred |
| `verify-fts` | canonical portable path → DB `verify-fts` against isolated PostgreSQL | direct | inferred |
| `api-server-coverage` | canonical portable path → serialized API Server `test:coverage` | package-specific | inferred |
| `security-audit` | canonical portable path → `pnpm audit --audit-level=low`; scheduled workflow is a duplicate with bounded exceptions | direct portable owner plus scheduled duplicate | inferred |
| `post-merge-health-test` | canonical portable path → `bash scripts/test-post-merge.sh` | contract coverage for the post-merge implementation; does not execute the `.replit`-configured `postMerge` hook or its live service-health behavior | inferred |

The `test` step executes its codegen preflight and API suite-floor preflight,
then three sequential package legs with 180-second Canvas, 300-second Parts ID,
and 240-second API Server limits under an 18-minute outer cap. Each leg writes
JSON results to a per-run staging area and publishes them with a run ID to a
per-run manifest before the timeout diagnostic. The outer watchdog owns process
trees and has an 18-minute cap. The old `/tmp/jest-run-manifest.json` spelling
above is present only because a focused static assertion still requires it; it
must not be used as evidence of the current runtime path. The
`api-suite-floor-contract` command is also a separate canonical
`standard-plus` member above; its second execution inside `scripts/test-all.sh`
is required nested harness coverage, not an additional tier member. Partial
package coverage is not claimed as full tier parity.

### Heavy-only coverage

| Canonical local check | Exact local command | Remote decision | Confidence |
|---|---|---|---|
| `protected-map-concurrency` | `pnpm --filter @workspace/mockup-sandbox run test:protected-map-smoke` | **absent from remote CI**; intentional heavy-only local stress/concurrency check, not covered by standard-plus or by the protected-map timeout contract | observed |

No partial or similarly named portable check is counted as parity for the
heavy-only command. Adding remote coverage is outside this report.

## Failures and confidence

The authorized read-only Actions query
`GET /repos/makerdan/EES-Parts-ID/actions/runs?head_sha=0d71ad7eabbddcbc61718f94a830b133c8cf5018&per_page=100&page=1`
returned HTTP 200 and zero runs on 2026-09-23. No matching run ID, attempt,
job result, or job log exists in that response to map to `Portable validation`
(`pnpm run test-standard-plus`), `CI / required` (aggregator), the scheduled
audit (`pnpm audit` with exceptions), or README maintenance (`cp replit.md
README.md`). **Unknown** is the result for whether any of these commands
ran or passed at this revision; absence of a run is not a passing or failing
command result. No passing claim is made from workflow YAML, a historical run,
or a badge.

The same connection returned HTTP 200 for `main` protection and Actions
permissions: strict status context `CI / required`, administrator enforcement,
pull-request reviews, conversation resolution, blocked force pushes/deletions,
read-only default workflow token, disabled token PR approval, selected actions,
and SHA pinning were observed at collection time. The rulesets endpoint
returned an empty list. These are **observed dated provider settings**, not
proof that the required job ran or passed for this checkout. Since remote
`main` was at a different revision, exact-revision policy freshness is
**unknown**; a revision-matched protection snapshot with policy and permission
context and a current re-check is missing. No merge-group run was returned for
the requested revision, and a `merge_group` trigger alone proves neither queue
activation nor a successful queue run.

The task's completion command is `test-fast`. The 2026-09-23 local run
`_6lBh3lPe7Cv4mSR9HHgi` passed the focused parity contracts but stopped
at `public-repository-boundary` because the historical protection snapshot
for `8d82e3953a756074325b9332665a3063686cd572` was incorrectly marked
current. That failure also reproduced on unchanged HEAD. The historical
snapshot is now explicitly stale; this does not approve a release, attest
to a GitHub job result, or replace the missing exact-revision provider
evidence. That first run's later steps were skipped after fail-fast. A later
local `test-fast` run (`4CaLxVK9_bfclmx4Hv7x_`) passed the parity,
revision, and public-boundary steps but stopped at unrelated Parts ID import
sorting in `utils/mapViewport.ts` and `utils/webSvgScene.ts`. Those unrelated
import-order errors were corrected after explicit approval. Remaining steps
in that run were skipped; no complete fast-tier pass is claimed from it.

## Coverage decisions

1. `CI` / `Portable validation` is the sole configured remote owner for portable
   `standard-plus`; its sequential path first runs the five workflow-only
   database prerequisites mapped above. `CI / required` aggregates its result
   and is not duplicate implementation coverage.
2. The five plan/regression operations remain local-only because an untrusted
   GitHub checkout lacks Replit task provenance; `--allow-no-plan` is a bypass,
   not semantic parity.
3. Package checks and the three root-test legs remain visible as
   package-specific execution inside one sequential tier, not CI matrix shards.
4. The scheduled audit is a maintenance duplicate. Its temporary exception
   means it is not command-identical to the portable audit and cannot replace
   the portable owner.
5. README synchronization is maintenance, not validation.
6. `heavy` is a strict superset: its one additional protected-map concurrency
   check is explicitly absent remotely and remains local-only.
7. Provider capability and security-control checks are evidence boundaries, not
   local tier commands. Unavailable current evidence remains unknown.
8. `post-merge-health-test` is portable contract coverage only. CI runs the
   test harness and its mocks/structural assertions; it does not invoke the
   `.replit` `postMerge` hook. The hook's platform-specific behavior—conditional
   dependency/schema work, code generation and settling, live API and sibling
   service probes, viewBox verification, Failure Gate refresh, protected
   synchronization, and API restart/recovery—therefore remains unexecuted
   remotely and is not claimed as direct parity. The complete hook inventory
   and its unavailable live evidence are recorded separately below.

## Gaps, risks, and next actions

- The exact-revision Actions query yielded zero runs; job/attempt/log evidence
  is therefore unavailable. Dated protection settings were readable, but a
  revision-matched policy/permission snapshot and live merge-queue evidence
  are missing. Re-check only after this revision reaches GitHub; do not
  reuse historical evidence.
- GitHub runs the workflow-only database prerequisites and then
  `standard-plus`, not `heavy`; protected-map concurrency therefore has no
  remote owner.
- Task-plan checks, the Replit Project gate, and development workflows depend on
  local platform context and intentionally have no GitHub equivalent.
- CI database checks use an isolated PostgreSQL service and say nothing about
  production database state.
- Any future evidence refresh must query the exact revision, record workflow,
  run, attempt, job, and bounded failure evidence, and label inaccessible or
  mismatched responses unknown. Extend the existing owning tier or harness
  if a gap is approved, rather than adding a duplicate workflow. It must
  remain read-only.

No action in this section authorizes dispatching workflows, changing policy, or
adding coverage.

## Platform-owned post-merge hook evidence

The configured hook is `scripts/post-merge.sh` (configured hook:
`scripts/post-merge.sh`) from `.replit`'s `[postMerge]` block. This is a
platform-owned live verification path, not a GitHub workflow. It was not
executed while collecting this report; its live results are therefore
**unavailable** and **hook-specific**. Portable CI does not execute the
configured hook, and the portable `post-merge-health-test` row above must not
be treated as evidence that these responsibilities ran.

| Responsibility | Hook evidence | Portable CI evidence | Classification | Confidence |
|---|---|---|---|---|
| `dependency-install` | conditional frozen install when `pnpm-lock.yaml` changes | unavailable — portable CI installs through the shared GitHub setup action, not the hook | hook-specific, remote hook absent | observed configuration; unknown live result |
| `schema-sync` | conditional development database schema push when the DB schema changes | unavailable — portable CI uses its isolated database prerequisites instead | hook-specific, remote hook absent | observed configuration; unknown live result |
| `fts-verification` | development full-text-search verification after schema synchronization | unavailable — not invoked by portable CI | hook-specific, remote hook absent | observed configuration; unknown live result |
| `codegen` | serialized API client `codegen:fix` and bounded watcher settling | unavailable — portable CI uses its contract checks, not the live hook | hook-specific, remote hook absent | observed configuration; unknown live result |
| `failure-gate-refresh` | refreshes and commits the tracked Failure Gate package when needed | unavailable — not invoked by portable CI | hook-specific, remote hook absent | observed configuration; unknown live result |
| `protected-sync` | invokes the protected GitHub synchronization boundary without bypassing policy | unavailable — not invoked by portable CI | hook-specific, remote hook absent | observed configuration; unknown live result |
| `api-health` | retries the live API health endpoint before and after recovery | unavailable — portable CI has no live Replit API process | hook-specific, remote hook absent | observed configuration; unknown live result |
| `sibling-services` | probes the Canvas and Expo development services through their platform domains | unavailable — portable CI has no Replit sibling-service domains | hook-specific, remote hook absent | observed configuration; unknown live result |
| `viewbox-sync` | runs the live SVG viewBox/API synchronization check | unavailable — not invoked by portable CI | hook-specific, remote hook absent | observed configuration; unknown live result |
| `restart-recovery` | frees the registered API port and verifies the post-restart health path | unavailable — portable CI does not own the Replit workflow process | hook-specific, remote hook absent | observed configuration; unknown live result |

This table is a completeness boundary: if the configured hook gains another
recognized platform-owned responsibility, the parity contract fails until the
responsibility is documented here. No unavailable hook result is promoted to
portable CI coverage.

## Read-only evidence collector contract

The optional collector accepts a repository identity and one exact 40-character
revision. It follows provider pagination for workflow runs and jobs until all
pages are read, retains only matching `head_sha` runs, and records workflow
path, run/attempt, event, status, conclusion, bounded timestamps, job identity,
and bounded failure evidence. Provider-denied logs are `withheld`; missing
detail is `unavailable`; neither is a pass. If a later page cannot be read, the
returned bundle is explicitly marked `complete: false` and `truncated: true`;
partial evidence must remain unknown rather than being treated as complete.
Pagination diagnostics retain the failed stage and page, and jobs-page failures
also identify the affected workflow run and attempt without retaining provider
error text.

Protection evidence is current only when repository, exact revision, policy,
and permission context all match the read-only re-check. Missing or changed
context is `stale`. The collector does not dispatch, retry, cancel, approve,
mutate, or download unbounded logs.
