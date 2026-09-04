# GitHub Actions Protected Snapshot Sync Design

## Goal

Apply the canonical Install GitHub Actions workflow to the current Parts ID
application by synchronizing the current tracked Replit workspace to
`makerdan/EES-Parts-ID`, validating it through the existing protected GitHub
pull-request path, and confirming the resulting default-branch workflows and
repository policy.

The synchronization must not publish Replit's local Git history, weaken the
existing fail-closed validation contract, or expose credentials or local-only
workspace state.

## Current evidence

- GitHub's authenticated repository API reports
  `makerdan/EES-Parts-ID` as public with default branch `main`.
- GitHub reports `main` as protected and strictly requiring the stable
  `CI / required` context.
- The tracked `CI` workflow runs `pnpm run test-standard-plus` with an isolated
  PostgreSQL service and a fail-closed aggregate job.
- The tracked LiDAR workflow runs the native test suite on macOS.
- The scheduled dependency audit and README synchronization workflows are
  maintenance workflows, not pre-merge validation owners.
- All third-party actions in the tracked workflows are pinned to immutable
  commits, pull-request validation has read-only permissions, and no
  `pull_request_target` event is used.
- The public repository is behind the current Replit workspace. Its latest
  recorded red runs belong to an older application snapshot and cannot prove
  the current workspace passes or fails.

## Chosen approach

Use a protected snapshot pull request.

Create the synchronization branch from GitHub's current `main`, then replace
its repository contents with the current `git ls-files` snapshot from Replit.
This transfers the intended current tree without transferring Replit's local
commits, reflogs, ignored files, task-local state, generated caches, or
historical Git objects.

Do not force-push `main`, bypass branch protection, temporarily remove required
checks, or rewrite the public repository's history.

## Preflight and safety boundary

Before any remote write:

1. Require a clean local workspace so the snapshot is reproducible.
2. Enumerate the upload from `git ls-files`; do not walk the filesystem as the
   source of truth.
3. Run the repository's tracked public-boundary and credential-pattern guards
   against the upload set.
4. Run the patched-dependency and GitHub Actions contract checks so a clean
   remote install cannot fail because of patch drift or malformed workflow
   configuration.
5. Record the exact local revision, remote base revision, file count, and tree
   fingerprint used for the synchronization.
6. Abort before upload if a guard reports a real credential, private artifact,
   unsafe symlink, unsupported file, or unreviewed public-boundary violation.

Secret values must never be read, printed, uploaded, embedded in workflow
configuration, or stored in diagnostics.

## Local validation contract

The Replit validation tiers remain canonical. Run:

```sh
pnpm run test-standard-plus
```

This is the validation ceiling and the remote `CI` workflow's exact owning
command. It covers the portable fast and standard surfaces plus schema drift,
full-text-search verification, API coverage, dependency audit, and post-merge
health checks.

Task-plan provenance checks that depend on Replit-local state remain
intentionally local-only. The GitHub coverage matrix must continue to state
that boundary explicitly.

If validation fails, apply the Failure Gate classification rules. Do not add
`continue-on-error`, skip a failing leg, lower the audit threshold, add a
secret, or change the required command to manufacture a green result.

## Remote synchronization flow

1. Read GitHub `main`, branch protection, Actions policy, workflow state, and
   required checks immediately before creating the branch.
2. Create a uniquely named synchronization branch from the observed `main`
   revision.
3. Build one remote snapshot commit whose tree matches the approved tracked
   Replit snapshot.
4. Re-read the remote commit tree and compare its paths and content
   fingerprints with the local upload manifest.
5. Open a pull request targeting `main`.
6. Do not mutate branch policy while checks run.

Any partial upload or tree mismatch is a hard failure. Delete only the
task-owned temporary branch after confirming it is not the target of an active
operation.

## Pull-request validation and merge policy

For one exact pull-request head revision, verify:

- the `CI` workflow emitted `Portable validation`;
- the same run emitted the stable `CI / required` aggregator;
- the aggregator fails on failure, cancellation, skip, empty dependency result,
  or an unexpected job result;
- the LiDAR workflow emitted `Run LidarMeasureTests`;
- every intended job completed and its conclusion is recorded;
- no pull-request job received write permission, repository secrets, production
  credentials, or deployment access.

Merge only through the protected pull-request path after all currently required
checks pass. Keep strict `CI / required`, administrator enforcement,
conversation resolution, and force-push/deletion blocks enabled.

LiDAR remains supplemental unless its same-revision run is successful and the
exact check context is confirmed. Requiring LiDAR is a separate policy mutation:
add it only after positive evidence shows that doing so will not permanently
block `main`.

## Post-merge activation

After the protected merge:

1. Record the merge revision returned by GitHub.
2. Confirm the `push` event emitted `CI`, `CI / required`, and LiDAR runs for
   that exact revision.
3. Confirm required jobs passed; record any supplemental or maintenance failure
   without weakening the merge contract.
4. Re-read branch protection, Actions allowlisting, immutable-action policy,
   default workflow token permissions, workflow-token pull-request approval,
   repository rulesets, and merge-queue state.
5. Dispatch the scheduled dependency audit and README synchronization workflows
   once on the merged revision.
6. Confirm README synchronization writes only its reviewable automation branch
   and does not write directly to protected `main`.

The scheduled audit and README synchronization results are maintenance evidence.
They must not be reported as pre-merge coverage.

## Error handling and recovery

- If local validation fails, stop remote synchronization until the failure is
  classified and resolved by its owner.
- If a remote job fails, capture the revision, event, workflow, job, attempt,
  exact command, and conclusion. Compare it with the local counterpart.
- If the snapshot branch is stale before merge, rebuild it from the new observed
  `main`; do not silently merge an outdated base.
- If the remote tree differs from the upload manifest, do not open or merge a
  pull request.
- If required policy cannot be read after a mutation, treat policy state as
  unknown and stop.
- Never solve a red check by bypassing protection, changing visibility,
  broadening permissions, using `pull_request_target`, or exposing credentials.

## Regression hardening

The deterministic GitHub Actions contract test is the recurrence guard. It must
continue to fail when:

- a third-party action uses a mutable tag or branch;
- checkout no longer precedes a repository-local action;
- pull-request permissions become writable;
- the stable `CI / required` aggregator is removed or no longer fails closed;
- the canonical remote command differs from `pnpm run test-standard-plus`;
- an intended event scope or local-to-remote coverage row disappears; or
- generated, schema, security, native, or local-only coverage is silently
  reclassified.

The snapshot process must also verify remote tree parity before opening the pull
request, preventing an incomplete transfer from masquerading as a validated
application snapshot.

## Completion criteria

The installation is complete only when:

- the local standard-plus tier passes or every remaining failure is classified
  without weakening coverage;
- the public remote tree matches the approved tracked snapshot;
- one exact pull-request revision emits all intended workflows;
- all required checks pass and the protected pull request merges normally;
- the exact merge revision receives successful required default-branch checks;
- branch policy and Actions security settings are independently re-read and
  confirmed;
- maintenance workflows are dispatched and their bounded outcomes recorded;
  and
- the final report distinguishes observed, inferred, and unavailable evidence.

## Rollback

Do not rename or remove `CI / required` while branch protection references it.
If rollback becomes necessary:

1. Identify every branch-policy reference to the affected stable check.
2. Revert the snapshot through a new protected pull request.
3. Keep the existing workflow contract active until the replacement has emitted
   and passed on the replacement revision.
4. Remove policy references before disabling or renaming an obsolete check.
5. Delete only task-owned synchronization branches after confirming they are no
   longer needed.
