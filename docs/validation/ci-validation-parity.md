# CI validation parity

## Scope and evidence

This is a read-only parity analysis of the repository at **2026-09-07**. It
does not change application code, tests, validation commands, workflow files,
credentials, branch policy, or remote workflow state.

Evidence was collected from:

- the tracked workflow and action definitions in
  `.github/workflows/*.yml` and `.github/actions/setup-node-pnpm/action.yml`;
- the canonical tier manifest in `scripts/validation-steps.mjs`, its runner in
  `scripts/run-tier.mjs`, the suite harness in `scripts/test-all.sh`, package
  scripts, `.replit`, and `replit.md`;
- the repository-owned matrix in
  `docs/validation/github-actions-coverage.md`, treated as historical routing
  documentation rather than live evidence;
- read-only GitHub API responses for `makerdan/EES-Parts-ID` on 2026-09-07:
  repository, workflow, run, job, branch-protection, and ruleset endpoints.

The local checkout is clean at revision
`e1446eedc829776fd3c2ee39010ac7d6e0b1d217`. GitHub returned HTTP 422 when that
revision was requested, and no run in the returned run inventory used that
SHA. The latest observed remote `main` run used
`a91289795b048e1fb6375fda78f5ff7cca65f83e`. Therefore remote results below are
observations about the cited remote revisions, not claims about the local
checkout.

The GitHub API returned HTTP 200 for the workflow inventory (four workflows),
the run inventory, and `main` branch protection. It returned HTTP 200 with zero
repository rulesets. A `merge_group` trigger is present in the tracked CI
files, but no `merge_group` run was observed in the returned run inventory and
no independent merge-queue policy evidence was available; merge-queue
activation is **unknown**.

Confidence labels used below:

- **observed** — directly returned by a local file or the read-only GitHub API;
- **inferred** — the command path follows from the tracked tier runner, but no
  remote execution of the local revision was observed;
- **unknown** — the relevant live run, policy, log detail, or source was
  unavailable.

## Workflow classification

| Workflow/job | Triggers and event scope | Execution and controls | Classification | Confidence |
|---|---|---|---|---|
| `CI` / `Portable validation` | `pull_request` (`opened`, `synchronize`, `reopened`, `ready_for_review`), `merge_group` (`checks_requested`), push to `main`, manual dispatch | Ubuntu 24.04; 45-minute timeout; PostgreSQL 16.4 service; readiness loop; `pnpm --filter @workspace/db run push-force`; then exactly `pnpm run test-standard-plus`; sanitized diagnostics are retained for seven days | pre-merge candidate, merge-queue candidate, default-branch monitor, and manual validation; portable owner | observed |
| `CI` / `CI / required` | Same events as `CI` | Unconditional five-minute job depending on `validate`; reads `needs.validate.result` and fails closed for failure, cancellation, skip, empty, or unexpected results | stable fail-closed aggregator; required status is separately verified in branch protection below | observed |
| `LiDAR Measure Tests` / `Run LidarMeasureTests` | Same revision/manual events as `CI` | macOS 15; 35-minute timeout; Expo iOS prebuild; CocoaPods cache and install; `xcodebuild test` against iPhone 16; Apple result artifacts retained seven days | supplemental package-specific platform job; not part of the portable tier | observed |
| `Scheduled security audit` / `Daily dependency audit (low+)` | Daily at `08:00 UTC` and manual dispatch; no pull-request event | Ubuntu 24.04; 15-minute timeout; `pnpm audit --audit-level=low`; read-only contents permission | scheduled maintenance; duplicate command coverage for the portable `security-audit` row, with a separate maintenance cadence | observed |
| `Sync README from replit.md` / `Copy replit.md → README.md` | Mondays at `07:00 UTC` and manual dispatch; no pull-request event | Ubuntu 24.04; 10-minute timeout; commits only to `automation/sync-readme`, using force-with-lease when the branch exists, and prints a compare URL | scheduled/manual maintenance; remote write operation, not validation | observed |
| `setup-node-pnpm` | Called by the three validation/platform workflows | Node from `.node-version`; pnpm 10.26.1; lockfile-keyed store cache; `pnpm install --frozen-lockfile`; no checkout and no credentials | shared setup prerequisite | observed |

All tracked workflows have top-level read-only permissions except the README
maintenance workflow's explicit `contents: write` job permission. All external
actions are SHA-pinned. No pull-request workflow declares production
credentials or a write permission. No job has a matrix, retry, or
`continue-on-error` validation path. The only `always()` path is the
fail-closed aggregator and diagnostic/artifact retention.

The Replit workflows are a separate local execution surface:

- the `Project` workflow runs `test-fast` and is the current Replit gate;
- `test-standard`, `test-standard-plus`, and `test-heavy` are named local
  validation workflows but are not GitHub jobs;
- `artifacts/parts-id: expo`, `artifacts/api-server: API Server`, and
  `artifacts/mockup-sandbox: Component Preview Server` are long-running
  development/preview workflows. They wait on ports 19000, 3001, and 8081,
  respectively, and are not CI validation jobs.

## Local-to-remote coverage map

The four local tiers are cumulative: `fast` has 20 steps, `standard` has 29,
and both `standard-plus` and `heavy` have the same 34 steps. The remote
portable owner invokes `standard-plus` exactly once. The table therefore
contains one row for every registered `standard-plus` step; the identical
`heavy` membership is recorded as duplicate coverage rather than a second
remote owner.

| Local check | Exact local command | Remote evidence/owner | Classification | Confidence |
|---|---|---|---|---|
| `gate-guard` | `bash scripts/check-gate-integrity.sh` | `CI` → `Portable validation` → `pnpm run test-standard-plus` | direct | inferred |
| `plan-gate-fix` | `node scripts/check-failure-gate.mjs --fix-stub` | The same tier command passes `--allow-no-plan` through the root runner | local-only with task-plan dependency; remote path is an explicit no-plan no-op | observed |
| `plan-gate-check` | `node scripts/check-failure-gate.mjs` | Same no-plan invocation | local-only with task archive/provenance dependency; remote path is an explicit no-plan no-op | observed |
| `plan-gate-stubs` | `node scripts/check-failure-gate.mjs --stubs-only` | Same no-plan invocation | local-only with task archive dependency; remote path is an explicit no-plan no-op | observed |
| `regression-guard-fix` | `node scripts/check-regression-guard.mjs --fix-stub` | Same no-plan invocation | local-only with task-scoped declaration dependency; remote path is no-plan bypass | inferred |
| `regression-guard` | `node scripts/check-regression-guard.mjs` | Same no-plan invocation | local-only with Replit task provenance dependency; remote path is no-plan bypass | inferred |
| `api-suite-floor-contract` | `node scripts/test/api-suite-floor-contract.test.mjs` | `CI` portable validation | direct | inferred |
| `github-actions-contract` | `node scripts/test/github-actions-contract.test.mjs` | `CI` portable validation | direct | inferred |
| `api-route-authorization-contract` | `node scripts/test/api-route-authorization-contract.test.mjs` | `CI` portable validation | direct | inferred |
| `skill-mirror-sync-contract` | `node scripts/test/skill-mirror-sync-contract.test.mjs` | `CI` portable validation | direct | inferred |
| `public-repository-boundary` | `node scripts/test/public-repository-boundary.test.mjs` | `CI` portable validation | direct | inferred |
| `patched-dependencies-contract` | `node scripts/test/patched-dependencies.test.mjs` | `CI` portable validation | direct | inferred |
| `patched-dependencies` | `node scripts/check-patched-dependencies.mjs` | `CI` portable validation | direct | inferred |
| `tsc` | `pnpm run typecheck:libs && pnpm -r --filter "./artifacts/**" --filter "./scripts" --if-present run typecheck` | `CI` portable validation | direct | inferred |
| `lint` | `node scripts/check-db-reachability.mjs && pnpm --filter @workspace/parts-id run lint && pnpm --filter @workspace/api-server run lint && pnpm --filter @workspace/mockup-sandbox run lint && pnpm run lint:libs` | `CI` portable validation with the PostgreSQL service and test database environment | direct | inferred |
| `lint-mocks` | `pnpm --filter @workspace/scripts run lint:mocks` | `CI` portable validation | direct | inferred |
| `tsconfig-check` | `pnpm --filter @workspace/scripts run tsconfig:check` | `CI` portable validation | direct | inferred |
| `port-guard` | `node scripts/serial-lock.mjs --resource ports --priority 90 -- bash scripts/check-hardcoded-ports.sh` | `CI` portable validation | direct | inferred |
| `bundle-domain-check` | `pnpm --filter @workspace/parts-id run check:bundle-domain` | `CI` portable validation | direct | inferred |
| `light-mode-config` | `bash scripts/check-light-mode-config.sh` | `CI` portable validation | direct | inferred |
| `codegen-check` | `node scripts/serial-lock.mjs --resource codegen --priority 80 -- pnpm --filter @workspace/api-spec run codegen:check` | `CI` portable validation after frozen install | direct | inferred |
| `spec-check` | `pnpm --filter @workspace/api-spec run spec:check` | `CI` portable validation | direct | inferred |
| `env-check` | `pnpm --filter @workspace/scripts env:check` | `CI` portable validation | direct | inferred |
| `privacy-check` | `pnpm --filter @workspace/scripts privacy:check` | `CI` portable validation | direct | inferred |
| `privacy-check-contract` | `node scripts/test/production-privacy-check.test.mjs` | `CI` portable validation | direct | inferred |
| `spec-check-tests` | `pnpm --filter @workspace/api-spec test` | `CI` portable validation | package-specific | inferred |
| `failure-gate-contract` | `node scripts/test/failure-gate-contract.test.mjs` | `CI` portable validation | direct | inferred |
| `test` | `node scripts/serial-lock.mjs --resource shared-test-results --priority 60 -- pnpm test` | `CI` portable validation; root `pnpm test` invokes `scripts/test-all.sh` | direct | inferred |
| `serve-proxy-smoke` | `pnpm --filter @workspace/parts-id run test:serve-proxy` | `CI` portable validation | package-specific | inferred |
| `schema-check` | `pnpm --filter @workspace/db run schema:check` | `CI` portable validation; schema is also prepared before the tier by `push-force` | direct | inferred |
| `verify-fts` | `pnpm --filter @workspace/db run verify-fts` | `CI` portable validation | direct | inferred |
| `api-server-coverage` | `node scripts/serial-lock.mjs --resource shared-test-results --priority 60 -- pnpm --filter @workspace/api-server run test:coverage` | `CI` portable validation | package-specific | inferred |
| `security-audit` | `pnpm audit --audit-level=low` | `CI` portable validation; also `Scheduled security audit` | direct | observed for the duplicate scheduled owner; portable execution remains inferred |
| `post-merge-health-test` | `bash scripts/test-post-merge.sh` | `CI` portable validation | direct | inferred |

The portable command is not a hidden matrix: it runs the registered steps
sequentially through `scripts/run-tier.mjs`, fail-fast, under the validation
serial lock. The `test` step then runs three package suites through
`scripts/test-all.sh`: `mockup-sandbox` with Vitest (180 seconds),
`parts-id` with Jest (300 seconds), and `api-server` with Jest (240 seconds),
with an 18-minute outer cap and JSON diagnostics. Those are package-specific
legs inside one local command, not GitHub matrix shards.

Additional relevant commands and their remote decisions:

| Local or platform command | Remote evidence/owner | Classification | Confidence |
|---|---|---|---|
| `pnpm --filter @workspace/api-spec test` | `CI` through `spec-check-tests` | package-specific | inferred |
| `pnpm --filter @workspace/parts-id run test` | `CI` through the `parts-id` leg of root `pnpm test` | package-specific | inferred |
| `pnpm --filter @workspace/api-server run test` | `CI` through the `api-server` leg of root `pnpm test` | package-specific | inferred |
| `pnpm --filter @workspace/mockup-sandbox exec vitest run` | `CI` through the `mockup-sandbox` leg of root `pnpm test` | package-specific | inferred |
| `pnpm --filter @workspace/api-server run test:coverage` | `CI` through `api-server-coverage` | package-specific | inferred |
| `pnpm exec expo prebuild --platform ios --no-install`, `pod install`, and the documented `xcodebuild test` invocation | `LiDAR Measure Tests` / `Run LidarMeasureTests` | package-specific | inferred |
| `pnpm run test-fast` | Replit `Project` → `test-fast`; no GitHub equivalent for the task gate | local-only with Replit Project-gate dependency | observed |
| `pnpm run test-standard`, `pnpm run test-standard-plus`, `pnpm run test-heavy` | Named Replit validation workflows; GitHub portable owner uses only `test-standard-plus` | duplicate/local execution surface | observed |
| Three development-server commands in `.replit` | No GitHub job; they are long-running preview workflows with port readiness | local-only with live service/port dependency | observed |

## Failures and confidence

### Current remote run evidence

The following entries are observed read-only GitHub API results. Each records
the revision, event, workflow/run, job and attempt, exact tracked command or
condition, result, and local counterpart.

| Revision | Event and run | Job/attempt and condition | Result | Local counterpart |
|---|---|---|---|---|
| `a91289795b048e1fb6375fda78f5ff7cca65f83e` | push to `main`; `CI` run `#13`, run ID `33715076900` | `Portable validation`, job `100522441535`, attempt 1; step `Run the canonical standard-plus validation tier` (`pnpm run test-standard-plus`) | failed; `CI / required`, job `100522672766`, then failed closed at `Fail closed unless portable validation passed` | `pnpm run test-standard-plus`; aggregator has no local test command |
| `a91289795b048e1fb6375fda78f5ff7cca65f83e` | push to `main`; `LiDAR Measure Tests` run `#11`, run ID `33715076909` | `Run LidarMeasureTests`, job `100522553259`, attempt 1; `Pod install` failed and `Run LidarMeasureTests` was skipped | failed before the native test command | Expo prebuild + `pod install` + `xcodebuild test` sequence in `artifacts/parts-id` |
| `a91289795b048e1fb6375fda78f5ff7cca65f83e` | schedule `2026-09-07`; `Scheduled security audit` run `#44`, run ID `34130561665` | `Daily dependency audit (low+)`, job `101769396869`, attempt 1; `pnpm audit --audit-level=low` | failed | `security-audit`: `pnpm audit --audit-level=low` |
| `a91289795b048e1fb6375fda78f5ff7cca65f83e` | schedule `2026-09-07`; `Sync README from replit.md` run `#10`, run ID `34127383358` | `Copy replit.md → README.md`, job `101759139278`, attempt 1; copy/branch maintenance steps completed | passed | no local validation counterpart; maintenance-only |
| `c4f6284beaa690b03e4849cbd98c35966e4eb90c` | pull request; `CI` run `#16`, run ID `33840964946` | `Portable validation`, job `100922996328`, attempt 1; standard-plus step failed; aggregator job `100923816520` failed closed | failed | `pnpm run test-standard-plus` |
| `c4f6284beaa690b03e4849cbd98c35966e4eb90c` | pull request; `LiDAR Measure Tests` run `#14`, run ID `33840964952` | `Run LidarMeasureTests`, job `100922996290`, attempt 1; `Pod install` failed and native test was skipped | failed | Expo/CocoaPods/xcodebuild sequence |

The GitHub job API exposed the failed step and result but not the underlying
log line that caused the portable tier or CocoaPods failure in this analysis.
The root cause of those failures is therefore **unknown**, even though the
failed step is observed. The audit failure is likewise recorded as a command
failure only; no vulnerability count is inferred from the workflow name.

The local revision `e1446ee...` has no matching remote run evidence. Current
branch-policy evidence is available for `main`: the API returned required
status context `CI / required`, `strict: true`, enabled administrator
enforcement, blocked force-pushes and deletions, and required conversation
resolution. The API returned no rulesets. Whether a merge queue is enabled,
which exact merge-queue policy is active, and whether any other checks are
required are **unknown** because no merge-group run or independent merge-queue
policy source was available. No claim of current pass status is made from YAML,
workflow names, badges, or dated documents.

## Coverage decisions

1. **Portable owner:** `CI` / `Portable validation` is the one remote owner
   for all portable `standard-plus` rows. It runs the root command once, after
   installing the frozen lockfile and preparing an isolated PostgreSQL schema.
2. **Fail-closed owner:** `CI / required` is an aggregator, not a second
   validation implementation. It is deliberately the only stable required
   context observed in `main` branch protection.
3. **Task provenance stays local:** Failure Gate and Regression Guard plan
   operations require the Replit task archive and task declaration. The remote
   command's explicit `--allow-no-plan` behavior is documented as a no-op, not
   counted as remote semantic coverage.
4. **Package and platform boundaries stay visible:** API-spec tests, the three
   root-suite package legs, API coverage, and the macOS LiDAR job are labeled
   package-specific rather than incorrectly described as shards of one matrix.
5. **Scheduled audit is an intentional duplicate:** the scheduled audit
   retains an independent daily maintenance signal for the same audit command;
   it does not own the portable pre-merge check.
6. **Heavy has no new remote coverage:** `heavy` currently has the same 34
   registered steps as `standard-plus`; adding another CI job would duplicate
   coverage without adding a check.
7. **README synchronization is not validation:** its write-capable maintenance
   branch and weekly/manual events are excluded from the validation owner map.
8. **No missing portable row is silently accepted:** every registered
   standard-plus member appears once above. The existing deterministic contract
   test independently enforces one row per registered surface in the
   repository-owned coverage matrix.

## Gaps, risks, and next actions

### Gaps and risks

- There is no current GitHub run for local revision `e1446ee...`; remote
  evidence is revision-specific and currently describes `a912897...` or the
  cited historical PR revision.
- The underlying log detail for the observed portable-tier, CocoaPods, and
  audit failures was not available through the inspected job response. Root
  causes remain unknown.
- Merge-group activation and the complete current merge policy are unknown.
  The tracked `merge_group` trigger alone is not evidence that a queue is
  enabled or that its checks are required.
- The Replit Project gate, task-plan provenance checks, development servers,
  database reachability, and native toolchains do not have a GitHub equivalent.
  Their local ownership must remain explicit.
- The portable workflow performs a schema push against an isolated PostgreSQL
  service. That is suitable for validation but is not evidence about production
  schema state.
- The README maintenance workflow has `contents: write` by design. It is
  isolated from pull-request code and pushes only its automation branch, but
  its branch protection and review outcome are not part of validation parity.

### Bounded next actions

1. On a future revision that is actually pushed to GitHub, capture one
   pull-request or default-branch run for that exact SHA, including the full
   portable job logs and all required/aggregator results.
2. Query and record the provider's merge-queue/ruleset policy source
   independently; leave it unknown until the API exposes a definitive result.
3. When the portable or native failures recur, record the exact log line,
   revision, run attempt, and local command in the failure baseline rather than
   inferring a cause from the failed step name.
4. Keep the existing local `test-fast` task validation and Replit Project gate
   as the owner of task provenance and local-only checks; do not add duplicate
   GitHub jobs for those dependencies.

No action above triggers, reruns, cancels, dispatches, approves, or changes a
remote workflow or policy.