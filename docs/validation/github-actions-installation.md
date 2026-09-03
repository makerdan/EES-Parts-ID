# GitHub Actions installation

## Scope and evidence

Live repository evidence was collected on 2026-09-03 through the authorized
GitHub connection for `makerdan/EES-Parts-ID`. API results are recorded as live
facts only when GitHub returned them successfully. Settings blocked by the
repository plan remain explicitly unavailable rather than being inferred from
tracked workflow files.

The tracked contract commit in this workspace is
`c9caeae834b0198405f8547bd6a944e6e1fd5d17`. GitHub's live `main` was still at
`31c923d12e5e9969b858e0c5c889305478a97303` during inspection. Because those
revisions differ, this report does not claim that the redesigned contract has
landed or that a legacy remote run validates the tracked workflows.

No production secret, deployment, release, environment, application data, or
privileged pull-request execution was introduced.

## Repository visibility and billing note

GitHub Actions does not require a public repository. Public repositories receive
free standard GitHub-hosted runner usage, while private repositories receive an
included Actions quota and may incur charges after that allowance depending on
the account's plan and billing settings. The blocker for this activation is
different: GitHub's current plan for this private repository does not provide
the branch-protection and ruleset controls needed to require `CI / required`.
GitHub's API explicitly offered upgrading to GitHub Pro or making the repository
public; no visibility or billing change was made.

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
| Repository | `makerdan/EES-Parts-ID`, private; authenticated connection has admin access | confirmed |
| Default branch | repository API returned `main` | confirmed |
| Default-branch revision | `31c923d12e5e9969b858e0c5c889305478a97303` | confirmed; does not match tracked contract |
| Branch protection | branch API returned `protected: false` | not configured |
| Branch-protection details | API returned 403: “Upgrade to GitHub Pro or make this repository public to enable this feature.” | unavailable on current private-repository plan |
| Repository rulesets / branch rules | both APIs returned the same GitHub plan restriction | unavailable on current private-repository plan |
| Required checks and reviews | no branch protection is active; protected-check details are plan-blocked | not configured / unavailable |
| Force-push and deletion blocks | no branch protection is active; protected-branch settings are plan-blocked | not configured |
| Merge queue | cannot be enabled/aligned without an available protected-branch/ruleset policy | not applicable on the current private-repository plan |
| Actions enablement | enabled | confirmed |
| Allowed actions | `all` | confirmed; not yet narrowed |
| SHA pinning policy | `false` | confirmed; not yet required by GitHub |
| Default workflow token | `read` | confirmed |
| Workflow token PR approval | `can_approve_pull_request_reviews: false` | confirmed |
| Fork contributor approval | API returned 422: fork PR approval is not allowed for private repositories | not applicable |

All four tracked workflow paths are enabled remotely, but the live files are the
legacy versions at the old `main` revision. Git object evidence confirmed
mutable references such as `actions/checkout@v4`, `actions/setup-node@v4`,
`pnpm/action-setup@v4`, and `actions/cache@v4`. The live CI workflow also lacks
the tracked `merge_group` event and stable `CI / required` aggregator.

## Policy activation decision

No branch/ruleset policy could be applied. GitHub rejected the relevant read
endpoints for this private repository because the account/repository plan does
not provide the feature; the branch itself reports `protected: false`.

The Actions allowlist and SHA-pinning setting were intentionally left unchanged.
Enabling selected/SHA-only actions while the live default branch still contains
mutable action tags would make the currently installed workflows fail before
the tracked immutable workflow revision lands. That would violate the task's
requirement not to weaken or knowingly break validation.

The already-safe defaults were preserved:

- Actions remain enabled.
- The default workflow token remains read-only.
- Workflow tokens cannot approve pull-request reviews.
- No workflow or repository secret was read or changed.

## Live run evidence

### Safe manual README synchronization

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

### Safe manual scheduled audit

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

### Existing default-branch run history

The latest legacy CI push runs available during inspection were:

- Run `30765280285`, revision
  `2a119c02a4b1dbd04b2d73f320d5f5ded2e69350`, attempt 1, failure:
  <https://github.com/makerdan/EES-Parts-ID/actions/runs/30765280285>
- Run `30304514538`, revision
  `7a59d591bbaad5fb0bd5233eb1680614dce34fe1`, attempt 1, failure:
  <https://github.com/makerdan/EES-Parts-ID/actions/runs/30304514538>

No default-branch run exists for the tracked contract revision. No push was
manufactured merely to claim coverage.

## Positive and negative-control status

The required remote acceptance proof remains blocked:

- No pull-request revision contains the tracked redesigned workflows.
- The live workflow does not emit `CI / required`.
- No required-check policy can be configured on the current private-repository
  plan.
- Therefore no honest positive PR run, `merge_group` run, required aggregator
  result, or branch-policy block can be recorded.
- A temporary negative-control PR was not created because the remote base lacks
  the contract under test and cannot require the aggregator. A red legacy run
  would not prove fail-closed behavior.

The repository's deterministic local contract test still owns the tracked
mutable-action negative control. It must not be presented as a substitute for
the required live branch-policy regression guard.

## Local validation

- Focused contract:
  `node scripts/test/github-actions-contract.test.mjs` passed, verifying four
  tracked workflows, 26 validation surfaces, and immutable action pins.
- Required tier: registered `test-standard` run
  `BVZxfmpBSBXKOa-DgPftS` completed with a failed `test` step after all preceding
  standard checks, including `github-actions-contract`, passed.
- Intermittent Canvas target:
  `WarehouseMapRoute.test.tsx` passed all three isolated retries.
- Intermittent API target: the inventory integration
  `bin preservation on conflict` scenario passed all three isolated retries.
- Under the task's explicit flaky-test rule, those passing isolated retries are
  not assigned to this report-only change. The full tier was not rerun and no
  heavier tier was used.

## Required activation sequence

To complete remote activation without creating a validation outage:

1. Land or synchronize the tracked contract revision on GitHub and confirm the
   exact GitHub commit SHA.
2. Run a real PR revision and confirm `Portable validation`,
   `Run LidarMeasureTests`, and `CI / required` are emitted for that SHA.
3. Move the private repository to a GitHub plan that supports branch
   protection/rulesets, or make it public only if the repository owner separately
   approves that visibility change.
4. Preserve or strengthen existing review requirements, require pull requests,
   require `CI / required`, block force-pushes/deletion, and include
   administrators unless an explicitly documented emergency bypass is required.
5. Enable merge queue only with the tracked `merge_group` coverage present, then
   capture a real merge-group run; otherwise keep merge queue disabled and record
   it as not applicable.
6. Change Actions policy to selected immutable action references and require SHA
   pinning only after the pinned workflow revision is live.
7. Re-run the PR revision, then introduce and revert a safe temporary contract
   violation to prove the required aggregator blocks the PR when a dependency
   fails.
8. Exercise the redesigned default-branch and manual paths and record every
   revision, event, workflow, job/matrix leg, command, attempt, skip, retry, and
   outcome.
9. Close the temporary PR and delete its branch after evidence is captured.

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
