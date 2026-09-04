# Implementation Plan: GitHub Actions Protected Snapshot Sync

## Source Spec

- Spec file:
  `docs/superpowers/specs/2026-09-03-github-actions-protected-snapshot-sync-design.md`
- Approved by user: 2026-09-03

## Pre-plan checklist

- [x] The approved source spec exists and is committed.
- [x] The spec contains no unresolved marker or placeholder sections.
- [x] The work is one implementable unit: safely synchronize the current tracked
      application snapshot and verify the existing GitHub Actions installation.
- [x] External services, packages, environment boundaries, and remote policy
      dependencies are listed below.
- [x] Tasks are ordered so each remote mutation follows its required local and
      read-only safety evidence.
- [x] T005 explicitly hardens the recurrence checks for workflow drift and
      incomplete snapshot synchronization.

## Dependencies

- **Authorized GitHub connection:** authenticated access to
  `makerdan/EES-Parts-ID`, including repository contents, Git data, pull
  requests, Actions runs, workflow dispatch, Actions settings, and branch
  protection.
- **Explicit mutation authorization:** the user approved repository-file
  synchronization, verification runs, and necessary branch-protection changes.
- **Repository visibility:** GitHub's authenticated API reports the repository
  as public. The implementation must re-read this before remote mutation and
  must not change visibility.
- **Default branch:** GitHub reports `main`. The implementation must re-read the
  current branch SHA immediately before creating the synchronization branch.
- **Toolchain:** Node.js `24.13.0`, pnpm `10.26.1`, and the committed
  `pnpm-lock.yaml`.
- **Canonical validation:** `pnpm run test-standard-plus`, backed by
  `scripts/validation-steps.mjs`.
- **Database:** an isolated PostgreSQL 16.4 service with test-only credentials
  for remote standard-plus validation. No development or production database
  may be used.
- **GitHub-hosted runners:** Ubuntu 24.04 for portable validation and macOS 15
  for LiDAR native tests.
- **No new packages or migrations:** none are expected. Any evidence-backed
  workflow repair must use the existing toolchain and validation structure.
- **No production secrets:** pull-request workflows must remain read-only and
  secret-free. Test database values remain non-sensitive job-local values.
- **Local-only state:** ignored files, Replit task plans/provenance, caches,
  object-storage state, environment secrets, and local Git history are excluded
  from synchronization.

## Tasks

### T001: Reconfirm local and remote safety baselines

- **Blocked by**: []
- **Files**:
  - `scripts/validation-steps.mjs`
  - `scripts/test/github-actions-contract.test.mjs`
  - `scripts/check-public-repository-boundary.mjs`
  - `scripts/check-patched-dependencies.mjs`
  - `.github/workflows/ci.yml`
  - `.github/workflows/lidar-measure-tests.yml`
  - `.github/workflows/scheduled-audit.yml`
  - `.github/workflows/sync-readme.yml`
  - `.github/actions/setup-node-pnpm/action.yml`
- **Details**:
  1. Require `git status --short` to be clean before deriving an upload
     manifest.
  2. Read the canonical tier manifest and workflow contract to confirm the
     remote owner remains `pnpm run test-standard-plus`.
  3. Run the public-repository boundary, credential-pattern, patched-dependency,
     and GitHub Actions contract checks that protect the upload set and clean
     install.
  4. Run `pnpm run test-standard-plus` exactly once as the local validation
     baseline.
  5. Read GitHub repository metadata, visibility, default branch, current
     default-branch SHA, workflow states, Actions policy, branch protection,
     rulesets, merge-queue evidence, and recent revision-aware runs.
  6. Stop before remote writes if visibility is no longer public, required
     evidence is unavailable, the tracked upload boundary is unsafe, or local
     validation has an unclassified failure.
- **Done when**:
  - the tracked upload set passes all safety guards;
  - `test-standard-plus` passes, or each remaining failure has a valid Failure
    Gate classification without changing coverage; and
  - the exact remote base SHA and existing policy are recorded from successful
    read-only API responses.

### T002: Build and verify the tracked snapshot manifest

- **Blocked by**: [T001]
- **Files**:
  - no tracked file is expected to change
- **Details**:
  1. Enumerate files with `git ls-files`; do not use an unrestricted filesystem
     walk.
  2. Reject symlinks, unsupported file types, ignored outputs, local task state,
     environment files, caches, secrets, and historical Git objects.
  3. Record every repository-relative path, byte length, Git blob identifier,
     and a deterministic aggregate fingerprint.
  4. Compare the manifest against public-boundary allow/deny rules.
  5. Keep scratch manifests outside tracked deliverables and never include file
     bodies or credential-like values in logs.
- **Done when**:
  - a deterministic manifest exists for exactly the tracked snapshot;
  - repeated generation produces the same path set and fingerprint; and
  - no excluded local or sensitive path is present.

### T003: Create a protected synchronization pull request

- **Blocked by**: [T002]
- **Files**:
  - remote GitHub branch and pull request only
- **Details**:
  1. Re-read GitHub `main` and abort if it differs from the base recorded in
     T001.
  2. Create a uniquely named task-owned branch from that exact remote SHA.
  3. Create Git blobs and one tree/commit representing the T002 snapshot; do not
     upload local commits or push local Git history.
  4. Update only the task-owned branch ref.
  5. Re-read the remote commit tree recursively and compare every path and blob
     identifier to the local manifest.
  6. Open a pull request targeting `main` only after exact tree parity passes.
  7. Record the pull-request number, head SHA, base SHA, and URL.
- **Done when**:
  - GitHub returns a pull request whose head tree exactly matches the approved
    local manifest;
  - the base is the observed protected `main`; and
  - branch protection remained unchanged during upload.

### T004: Resolve same-revision pull-request validation

- **Blocked by**: [T003]
- **Files**:
  - evidence-dependent application, test, or workflow files only if the current
    PR exposes a reproducible defect
  - `docs/validation/github-actions-coverage.md` only if routing evidence
    changes
- **Details**:
  1. Observe the exact PR head revision until GitHub reports terminal results
     for `Portable validation`, `CI / required`, and `Run LidarMeasureTests`.
  2. Record workflow, run, job, attempt, event, exact command, status,
     conclusion, skip/cancellation state, and diagnostic artifact availability.
  3. Confirm PR code ran under `pull_request`, read-only permissions, and without
     repository or production secrets.
  4. If a job fails, reproduce its exact local counterpart where possible.
     Apply Failure Gate ownership rules and make only evidence-backed fixes.
  5. Do not weaken the canonical tier, audit severity, action pinning,
     permissions, event safety, timeouts, or fail-closed aggregation.
  6. For any repair, add a new snapshot commit to the same task-owned branch,
     verify tree parity, and restart evidence collection for the new head SHA.
- **Done when**:
  - one exact PR head SHA has successful `Portable validation` and
    `CI / required`;
  - the exact LiDAR result is recorded for that same SHA;
  - no required job is skipped, cancelled, retried into a hidden pass, or
    allowed to fail; and
  - any remaining supplemental failure has explicit evidence and ownership.

### T005: Regression hardening — reject workflow or snapshot false-greens

- **Blocked by**: [T004]
- **Files**:
  - `scripts/test/github-actions-contract.test.mjs`
  - `docs/validation/github-actions-coverage.md`
  - snapshot-parity test or assertion in the synchronization execution path
  - `.github/workflows/ci.yml` only if the contract exposes a real omission
- **Details**:
  1. Run the existing deterministic GitHub Actions contract test against the
     final PR tree.
  2. Confirm it rejects mutable third-party action references, checkout after a
     local action, writable PR permissions, removal or weakening of
     `CI / required`, drift from `pnpm run test-standard-plus`, and missing
     coverage rows or intended event scopes.
  3. Confirm the snapshot upload path compares the full remote tree with the
     local manifest before pull-request creation and after every repair commit.
  4. Add or tighten the smallest assertion only if one of these specific
     recurrence signals is absent; do not create a duplicate CI workflow.
  5. Re-run the focused contract and affected canonical tier after any test or
     workflow change.
- **Done when**:
  - a deterministic check fails for each specified workflow false-green;
  - remote tree mismatch blocks pull-request creation or update; and
  - the focused contract and owning canonical tier pass on the final PR SHA.

### T006: Merge through protection and verify default-branch activation

- **Blocked by**: [T005]
- **Files**:
  - remote GitHub pull request, branch protection, and Actions settings only
- **Details**:
  1. Re-read required status checks immediately before merge.
  2. Merge through the protected pull request only after all currently required
     checks pass.
  3. Never temporarily remove `CI / required`, disable administrator
     enforcement, permit force-push/deletion, or bypass the protected path.
  4. Add LiDAR as a required context only if the same-revision successful run
     exposes a stable check context and a policy read confirms the change will
     not strand `main`; otherwise preserve it as supplemental.
  5. Record the exact merge SHA.
  6. Confirm that exact SHA emits default-branch `CI`, `CI / required`, and
     LiDAR runs and record every result.
  7. Re-read and verify visibility, strict required checks, administrator
     enforcement, conversation resolution, force-push/deletion blocks, Actions
     allowlisting, immutable-SHA policy, default token permissions,
     workflow-token PR approval, rulesets, and merge-queue state.
- **Done when**:
  - the protected pull request is merged without a policy bypass;
  - required push checks pass on the exact merge SHA;
  - LiDAR's required or supplemental status is evidence-backed; and
  - every security/policy setting is confirmed by a successful post-merge API
    read.

### T007: Verify maintenance workflows and update the installation record

- **Blocked by**: [T006]
- **Files**:
  - `docs/validation/github-actions-installation.md`
  - `docs/validation/github-actions-coverage.md` if observed routing changed
- **Details**:
  1. Dispatch `Scheduled security audit` on the exact merged revision and record
     its run, job, command, and result.
  2. Dispatch `Sync README from replit.md` on the exact merged revision.
  3. Confirm README synchronization writes only
     `automation/sync-readme`, leaves protected `main` untouched, and presents a
     reviewable comparison when content changes.
  4. Update the installation report with the local revision, remote PR and
     merge revisions, exact run/job evidence, policy reads, exclusions,
     failures, retries, and unavailable evidence.
  5. Keep maintenance outcomes separate from pre-merge coverage and do not
     claim merge-queue coverage without an enabled queue and a real
     `merge_group` run.
  6. Run the final validation command named below after documentation updates.
- **Done when**:
  - both maintenance workflows have bounded, revision-aware outcomes;
  - the installation report uses observed/inferred/unknown labels correctly;
  - the coverage matrix matches the final executable workflow contract; and
  - final validation passes under the Failure Gate rules.

## Pre-existing failures to ignore

None known at plan time. The latest `test-fast` baseline passed all 15 steps.
Treat every test failure as a potential regression.

The artifact workflow port-handoff failures observed during planning are
runtime reconciliation status, not test failures, and are outside this
GitHub Actions synchronization task.

**Flaky-test rule:** If a test fails, retry it 3× in isolation before concluding
it is a regression caused by this work. Only treat a consistent 3/3 failure as
task-owned unless the Failure Gate's evidence-based self-classification rule is
satisfied.

## Validation

**Command:** `test-standard-plus`

**Why:** This is the exact canonical portable tier owned by `CI / required`; it
covers workflow contracts, type checking, lint, generated-output drift, all
test suites, schema/FTS checks, API coverage, dependency audit, and post-merge
health.

**Do not escalate:** Run exactly this command. Pre-existing failures are handled
above and are never a reason to run the heavier tier.

## Relevant files

- `docs/superpowers/specs/2026-09-03-github-actions-protected-snapshot-sync-design.md`
- `.github/actions/setup-node-pnpm/action.yml`
- `.github/workflows/ci.yml`
- `.github/workflows/lidar-measure-tests.yml`
- `.github/workflows/scheduled-audit.yml`
- `.github/workflows/sync-readme.yml`
- `scripts/validation-steps.mjs`
- `scripts/run-tier.mjs`
- `scripts/test/github-actions-contract.test.mjs`
- `scripts/check-public-repository-boundary.mjs`
- `scripts/check-patched-dependencies.mjs`
- `docs/validation/github-actions-coverage.md`
- `docs/validation/github-actions-installation.md`
