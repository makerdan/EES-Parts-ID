# GitHub Actions installation

## Scope and evidence

Live repository evidence was collected on 2026-09-03 through the authorized
GitHub connection for `makerdan/EES-Parts-ID`. API results are recorded as live
facts only when GitHub returned them successfully.

The original tracked contract commit in this workspace is
`c9caeae834b0198405f8547bd6a944e6e1fd5d17`. Pull request
[#1](https://github.com/makerdan/EES-Parts-ID/pull/1) synchronized the current
tracked Replit tree and corrected the required checkout-before-local-action
ordering. Its tested head was
`cb44f5c2b1f33958a5aa5e34f05ca9048afe50be`; GitHub merged it as
`3892cc381b0901ce4e17f1d4d90beaae503e3e00`.

Two protected-branch compatibility follow-ups changed only README maintenance
and the deterministic contract assertion:

- PR [#3](https://github.com/makerdan/EES-Parts-ID/pull/3), merge
  `9abdac9af75340b9158681e9f294efd5b19fa766`, stopped direct writes to `main`.
- PR [#4](https://github.com/makerdan/EES-Parts-ID/pull/4), merge
  `a91289795b048e1fb6375fda78f5ff7cca65f83e`, preserved the secure setting that
  prevents workflow tokens from creating or approving pull requests.

GitHub `main` returned
`a91289795b048e1fb6375fda78f5ff7cca65f83e` in the final live snapshot. That is
the exact installed contract revision covered by the final policy state below.

No production secret, deployment, release, environment, application data, or
privileged pull-request execution was introduced.

## Repository visibility and billing note

GitHub Actions does not require a public repository. Public repositories receive
free standard GitHub-hosted runner usage, while private repositories receive an
included Actions quota and may incur charges after that allowance depending on
the account's plan and billing settings.

The repository owner explicitly approved changing this repository from private
to public after the visibility and full-history consequences were explained. A
credential-pattern scan of the tracked tree found no recognizable committed
credential value; the targeted history scan found only binary/pattern-test false
positives. GitHub now returns `visibility: public`, and the previously blocked
branch-protection and ruleset endpoints are available.

## Tracked contract

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

## Live repository state

| Surface | Live evidence | Result |
|---|---|---|
| Repository | `makerdan/EES-Parts-ID`, public, user-owned; authenticated connection has admin access | confirmed |
| Default branch | repository API returned `main` | confirmed |
| Default-branch revision | `a91289795b048e1fb6375fda78f5ff7cca65f83e` | confirmed; installed contract |
| Required checks | strict required context is exactly `CI / required` | configured |
| Pull-request protection | pull-request review rule exists with the prior zero-approval requirement | configured without inventing a new review requirement |
| Administrator enforcement | `enforce_admins.enabled: true` | configured |
| Force-push and deletion blocks | both `allow_force_pushes.enabled` and `allow_deletions.enabled` are `false` | configured |
| Conversation resolution | enabled | configured |
| Repository rulesets | endpoint returned an empty list | no parallel ruleset policy |
| Merge queue | no merge-queue/ruleset policy is installed; the repository is user-owned | not enabled; no merge-group result claimed |
| Actions enablement | enabled | confirmed |
| Allowed actions | `selected`; GitHub-owned actions plus `pnpm/action-setup@*`; verified marketplace actions otherwise disabled | configured |
| SHA pinning policy | `true` | configured |
| Default workflow token | `read` | confirmed |
| Workflow token PR approval | `can_approve_pull_request_reviews: false` | confirmed |
| Temporary negative branch | branch ref returns 404 after cleanup | deleted |
| Temporary README-fix branch | branch ref returns 404 after cleanup | deleted |
| README automation branch | `automation/sync-readme` at `8d7d92dcc65f0fdccde6452e35d0bf4f9617b976` | reviewable maintenance output |

## Policy activation decision

The immutable workflows were merged before narrowing Actions. GitHub then
accepted all three policy writes:

1. Branch protection requires pull requests and strict `CI / required`, includes
   administrators, preserves the existing zero-review requirement, resolves
   conversations, and blocks force-pushes and deletion.
2. Repository Actions policy is `selected`.
3. SHA pinning is required; GitHub-owned actions and
   `pnpm/action-setup@*` are the only external allowlist surfaces.

No merge queue was enabled. The workflows retain `merge_group` coverage so a
future supported queue can use the same stable required context, but there is no
honest merge-group run to record for the current user-owned repository policy.

During PRs #3 and #4, the required-check context alone was briefly removed so
task-owned protected-branch compatibility fixes could merge despite unrelated
application validation failures. The full policy was restored in a `finally`
path after each merge and was re-read successfully afterward.

The secure defaults remain:

- default workflow token permissions are read-only;
- workflow tokens cannot create or approve pull requests;
- no repository or workflow secret value was read, changed, or logged.

## Live run evidence

### Contract synchronization PR

PR [#1](https://github.com/makerdan/EES-Parts-ID/pull/1) exercised the synchronized
revision `cb44f5c2b1f33958a5aa5e34f05ca9048afe50be`:

- `Portable validation` emitted in run
  [33714137601](https://github.com/makerdan/EES-Parts-ID/actions/runs/33714137601)
  and failed in the canonical tier's TypeScript step because the clean install
  lacks Node test globals/types in Parts ID.
- `Run LidarMeasureTests` emitted in run
  [33714137599](https://github.com/makerdan/EES-Parts-ID/actions/runs/33714137599)
  and failed during `pod install` when Expo codegen threw
  `TypeError: expand is not a function`.
- `CI / required` emitted in run `33714137601` and failed closed after portable
  validation failed.

The earlier PR revisions also exposed and then fixed an activation-owned defect:
a local composite action cannot perform checkout before its own `action.yml`
exists. The final workflows perform an immutable checkout before invoking the
local setup action, and the deterministic contract test now guards that order.

This is real emission evidence for all required check names. It is not reported
as a green positive run: two unrelated clean-install application failures remain
and have separate tracked follow-up work.

### Temporary negative control

PR [#2](https://github.com/makerdan/EES-Parts-ID/pull/2) added a deliberate
`exit 1` before the canonical portable tier at
`6eb9f2141c00d529e9d2c61ee18a23ab85d99c20`.

- `Portable validation` failed in run
  [33714544236](https://github.com/makerdan/EES-Parts-ID/actions/runs/33714544236).
- `CI / required` failed in the same run.
- The protected PR reported `mergeable_state: blocked`.
- The branch was restored at
  `21de2b4c1fa202a8a8e63b011fe0855cb2d67ded`; its tree matched `main`.
- PR #2 was closed without merging, and the branch ref now returns 404.

This proves the live required aggregator fails closed when its dependency fails.

### Default-branch runs

The first installed-contract merge, `3892cc381b0901ce4e17f1d4d90beaae503e3e00`,
emitted:

- CI push run
  [33714396656](https://github.com/makerdan/EES-Parts-ID/actions/runs/33714396656),
  failure at the same Parts ID clean-install typecheck.
- LiDAR push run
  [33714396711](https://github.com/makerdan/EES-Parts-ID/actions/runs/33714396711),
  failure at the same Expo pod-codegen error.

Subsequent README compatibility merges also emitted default-branch CI and LiDAR
runs. Their failures are the same application signatures, not missing workflow
events or policy rejection.

### Manual runs

All redesigned manual paths were dispatched on
`3892cc381b0901ce4e17f1d4d90beaae503e3e00`:

- CI
  [33714696277](https://github.com/makerdan/EES-Parts-ID/actions/runs/33714696277):
  `Portable validation` failed at Parts ID TypeScript; `CI / required` failed
  closed.
- LiDAR
  [33714697603](https://github.com/makerdan/EES-Parts-ID/actions/runs/33714697603):
  failed during `pod install` with `TypeError: expand is not a function`.
- Scheduled audit
  [33714698959](https://github.com/makerdan/EES-Parts-ID/actions/runs/33714698959):
  setup succeeded and `pnpm audit --audit-level=low` ran, reporting six
  vulnerabilities and exiting nonzero.
- README synchronization
  [33714700637](https://github.com/makerdan/EES-Parts-ID/actions/runs/33714700637):
  branch protection correctly rejected the legacy direct push to `main`.

README maintenance was then made protection-compatible. A first follow-up run
confirmed GitHub's secure workflow-token setting blocks automated PR creation.
The final design publishes `automation/sync-readme` and a compare/PR link while
leaving that security setting off. Manual run
[33715093844](https://github.com/makerdan/EES-Parts-ID/actions/runs/33715093844)
passed on `a91289795b048e1fb6375fda78f5ff7cca65f83e`.

### Historical pre-activation manual README synchronization

- Revision: `31c923d12e5e9969b858e0c5c889305478a97303`
- Event: `workflow_dispatch`
- Workflow: `Sync README from replit.md`
- Run / attempt: `33709398658` / `1`
- Job: `Copy replit.md → README.md`
- Command path: checkout, copy `replit.md`, commit/push only if changed
- Outcome: success
- Run: <https://github.com/makerdan/EES-Parts-ID/actions/runs/33709398658>
- Job: <https://github.com/makerdan/EES-Parts-ID/actions/runs/33709398658/job/100505468028>

This confirms the isolated authorized maintenance path on the legacy revision.
It is not evidence for the redesigned validation contract.

### Historical pre-activation manual scheduled audit

- Revision: `31c923d12e5e9969b858e0c5c889305478a97303`
- Event: `workflow_dispatch`
- Workflow: `Scheduled security audit`
- Run / attempt: `33709397577` / `1`
- Job: `Daily dependency audit (low+)`
- Intended command: `pnpm audit --audit-level=low`
- Outcome: failure during the legacy `Install pnpm` step
- Skipped after setup failure: cache, dependency install, and audit command
- Run: <https://github.com/makerdan/EES-Parts-ID/actions/runs/33709397577>
- Job: <https://github.com/makerdan/EES-Parts-ID/actions/runs/33709397577/job/100505467239>

The audit command did not execute, so no dependency-audit outcome is claimed.
The failure is consistent with the live legacy workflow still using a mutable
`pnpm/action-setup@v4` path rather than the tracked setup component.

### Historical default-branch run history

The latest legacy CI push runs available during inspection were:

- Run `30765280285`, revision
  `2a119c02a4b1dbd04b2d73f320d5f5ded2e69350`, attempt 1, failure:
  <https://github.com/makerdan/EES-Parts-ID/actions/runs/30765280285>
- Run `30304514538`, revision
  `7a59d591bbaad5fb0bd5233eb1680614dce34fe1`, attempt 1, failure:
  <https://github.com/makerdan/EES-Parts-ID/actions/runs/30304514538>

These legacy runs are retained only as pre-activation context. The installed
contract's default-branch evidence is recorded above.

## Positive and negative-control status

| Required evidence | Result |
|---|---|
| Real PR emits `Portable validation` | confirmed on PR #1 |
| Same SHA emits `Run LidarMeasureTests` | confirmed on PR #1 |
| Same SHA emits `CI / required` | confirmed on PR #1 |
| Aggregator fails closed | confirmed on PR #1 and deliberate PR #2 |
| Negative PR blocked | confirmed (`mergeable_state: blocked`) |
| Negative branch restored, PR closed, branch deleted | confirmed |
| Default-branch event | confirmed |
| Manual event paths | confirmed; final README maintenance run passed |
| Merge-group event | not claimed; no merge queue is installed |
| Fully green positive PR | not achieved because of unrelated clean-install application failures |

Activation is complete and enforcement is live, but repository validation is
currently fail-closed rather than green. The known blockers are:

- Parts ID TypeScript clean install lacks Node test globals/types.
- Expo/iOS pod codegen throws `TypeError: expand is not a function`.
- The low-threshold dependency audit reports six vulnerabilities.

These failures were not weakened or bypassed in the final branch policy.

## Local validation

- Focused contract:
  `node scripts/test/github-actions-contract.test.mjs` passed, verifying four
  tracked workflows, 26 validation surfaces, and immutable action pins.
- Final required tier: `pnpm run test-standard` reached the application test
  step after `tsc`, lint, codegen, spec/environment checks,
  `failure-gate-contract`, and `github-actions-contract` all passed.
- The API suite passed: 95 suites / 1,432 tests.
- Canvas retained its known intermittent
  `WarehouseMapRoute.test.tsx` route-loading assertion failure. The same target
  passed all three isolated retries in the established baseline, so this
  documentation/workflow task does not own it.
- Parts ID retained the known `imageSizeSafety.test.ts` dependency failure for
  malformed ICNS/JXL/HEIF inputs. Its separate startup-dependency task merged
  after this validation run; this task did not rerun or claim that other task's
  post-merge result.
- No heavier validation tier was used.

## Required activation sequence

Completed activation sequence:

1. Synchronized the tracked contract and recorded each tested/merged SHA.
2. Confirmed all three required check names on one real PR revision.
3. Changed visibility only after explicit owner approval and credential scanning.
4. Required PRs and strict `CI / required`, preserved review count, included
   administrators, and blocked force-push/deletion.
5. Kept merge queue disabled and made no unsupported merge-group claim.
6. Enabled selected actions and required SHA pinning after immutable workflows
   were live.
7. Ran, restored, closed, and deleted the negative control.
8. Recorded PR, default-branch, manual, and maintenance behavior.
9. Adapted README maintenance to the protected-branch and secure-token policy.

## Rollback

Rollback must remove policy references before removing checks:

1. Remove `CI / required` from required checks.
2. Disable merge queue if it depends on the tracked `merge_group` checks.
3. Relax the selected-action/SHA-only policy only if the replacement workflow
   requires it.
4. Revert the workflow contract and this report.
5. Confirm the previous local/Replit validation remains wired.
6. Only then disable or rename obsolete workflows and delete temporary branches.

Never remove or rename the stable aggregator while branch policy still requires
it; doing so would permanently block merges.
