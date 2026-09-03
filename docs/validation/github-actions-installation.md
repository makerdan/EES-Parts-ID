# GitHub Actions installation

## Scope and evidence

This task applies the tracked GitHub Actions contract only. It does not change
GitHub branch rules, required checks, secrets, environments, runners, or live
workflow state. Workflow and repository evidence below is inferred from the
tracked files; remote activation and run evidence remain pending for the
dependent activation task.

## Changed files

- `.github/actions/setup-node-pnpm/action.yml` — reusable checkout, Node 24.13.0,
  pnpm 10.26.1, frozen install, and lockfile/OS/architecture/toolchain cache.
- `.github/workflows/ci.yml` — portable standard-plus validation, isolated
  PostgreSQL, diagnostics, and stable fail-closed `CI / required` aggregator.
- `.github/workflows/lidar-measure-tests.yml` — bounded macOS native test job
  with Apple result retention.
- `.github/workflows/scheduled-audit.yml` — read-only scheduled/manual audit.
- `.github/workflows/sync-readme.yml` — schedule/manual-only maintenance writer.
- `scripts/test/github-actions-contract.test.mjs` — deterministic workflow and
  coverage contract with a mutable-action negative control.
- `scripts/validation-steps.mjs` — registers the contract check in standard.
- `package.json` — records the exact pnpm package manager.
- `docs/validation/github-actions-coverage.md` — complete local-to-remote matrix.
- `docs/validation/github-actions-installation.md` — this installation report.

## Local-to-remote coverage

The complete matrix is in
`docs/validation/github-actions-coverage.md`. Portable checks have one owner:
the Linux validation job runs `pnpm run test-standard-plus` exactly once, and
the stable aggregator depends on that job. Task-plan and task-scoped
Failure/Regression Gate provenance is intentionally local-only. The LiDAR
native suite is separately owned by the macOS job because Xcode and the iOS
simulator are not portable to the Linux runner.

## Event scopes and security

CI and LiDAR cover pull requests, `merge_group`, pushes to `main`, and manual
dispatch. Scheduled audit and README synchronization cover only their schedule
and manual dispatch. Validation jobs use explicit `contents: read`, no
production secrets, no write credentials, no privileged pull-request execution,
and checkout disables persisted credentials. The README job is the sole
write-capable workflow and never processes pull-request code.

All third-party action references use immutable commit SHAs. Jobs have finite
timeouts and safe concurrency. pnpm installs are frozen. The PostgreSQL service
uses a fixed `postgres:16.4` image with health checks, readiness polling, and
schema preparation. Cache keys include OS, architecture, Node version,
pnpm version, and lockfile context; artifacts are diagnostic-only with
seven-day retention and `continue-on-error` limited to upload steps.

## Exclusions, gaps, and duplicate decisions

- GitHub branch protection, required-check configuration, Actions policy,
  merge-queue enablement, and live remote runs are not changed here.
- Task-plan archive checks remain local-only because their provenance is owned by
  Replit task validation.
- No separate codegen, typecheck, test, coverage, or audit jobs are created;
  the canonical tier owns these checks once rather than duplicating execution.
- Native LiDAR coverage is separate by necessity, not a duplicate Linux suite.
- No production credentials, self-hosted runners, deployments, or application
  behavior changes are included.

## Validation results

- Focused contract: `node scripts/test/github-actions-contract.test.mjs` is
  designed to verify all tracked workflow properties and rejects a mutable
  action in its negative control.
- Required task validation: `test-standard` is the mandated command and must be
  run with the task lock. The initial baseline run was interrupted during the
  long test phase before a result was emitted; it was not treated as a failure.
- No GitHub revision, event, matrix leg, cancellation, retry, or aggregator run
  is claimed because live remote verification is out of scope.

## Remaining manual GitHub settings

The dependent `Activate GitHub Validation Policy` task must inspect and, with
separate authorization, configure the default branch, required `CI / required`
check, merge queue, Actions permissions, and any ruleset/branch-protection
requirements. It must verify actual revision-aware PR, merge-queue, push, and
manual results rather than treating YAML presence as activation.

## Rollback and follow-up actions

Before disabling or renaming the stable check, remove its required-check
reference in GitHub settings. Then revert the workflow contract and report,
confirm the old local/Replit validation remains wired, and only afterward
disable obsolete workflows or caches. Do not remove the aggregator first if
branch protection already requires it. Follow-up activation and live
negative-control verification belong to the dependent task.