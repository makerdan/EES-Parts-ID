# Bug & Error Audit Report: Public Release Validation

**Scope:** Public-repository boundary scanning, public-data classification,
reachable-history checks, GitHub synchronization policy, security guidance, and
release-readiness evidence.

**Mode:** Report-only. No repository history, remote branch, tracked source,
workflow, or release configuration was changed.

**Assessment date:** 2026-09-16

## Executive summary

The current tracked-tree boundary check passes, but the repository is not ready
for a public-release claim:

- The current checkout reports **100 historical private paths** requiring an
  owner-led purge. This is an existing release blocker, not a finding that this
  audit attempted to remediate.
- The GitHub CI checkout does not request full history, while the boundary
  script describes `git rev-list --objects --all` as a reachable-history scan.
  On a normal shallow Actions checkout, the release gate can miss older private
  paths.
- Several scanner exclusions allow private data to pass: the scanner skips its
  own source, skips generic credential assignments and email addresses in
  tracked static builds, and does not inspect historical blob contents.
- A boundary finding includes up to 80 characters of the matched value in its
  message. A real secret detected by the guard could therefore be copied into a
  public CI log.
- Dated GitHub protection evidence is not checked against the current
  repository revision by the public-boundary documentation contract. The
  evidence records a different revision from the current checkout.
- The synchronization helper exits successfully while intentionally doing
  nothing. The protected snapshot process is documented, but the helper itself
  cannot establish that synchronization happened.

These findings are sufficient to keep release readiness blocked until the
history scan, data scanner, evidence freshness, logging, and synchronization
contracts are strengthened. This report does not fix them.

## Evidence and limitations

Evidence was gathered read-only from:

- `scripts/test/public-repository-boundary.test.mjs`
- `scripts/sync-github.sh`
- `.github/workflows/ci.yml`
- `docs/public-repository-readiness.md`
- `docs/public-release-checklist.md`
- `docs/public-data-classification.md`
- `SECURITY.md`
- `scripts/validation-steps.mjs`
- `docs/validation/github-protection-status.md`
- `docs/validation/github-actions-coverage.md`
- `scripts/lib/github-validation-evidence.mjs`

The specified validation command, `pnpm run test-fast`, passed all 27 steps.
Its public-boundary step reported 1,182 tracked paths and 100 historical
private paths requiring owner-led remediation.

The audit did not inspect or reproduce secret values, private object bytes,
historical file contents, provider credentials, or remote mutable state. The
behavior checks used synthetic redacted strings only. The GitHub protection
document is a dated snapshot; this audit did not query GitHub or change any
provider setting. Local branch and revision identity were read only to test
whether the checked-in evidence is revision-bound.

## Boundary inventory

| Boundary | Current implementation | Audit result |
| --- | --- | --- |
| Tracked source and assets | `git ls-files -z`, then existing files are scanned | Present, but path/content exclusions create gaps described below |
| Generated outputs | `static-build` and `node_modules` are identified as generated | Tracked static builds exist; generic credential and email checks are skipped there |
| Public layout data | `data/public/` is described as geometry and stable labels only | Policy is documented, but no CSV/schema assertion enforces the restriction |
| Reachable history | `git rev-list --objects --all` and path-name classification | Finds path classes only; CI checkout depth is not full |
| Historical contents | No historical blob read or secret scan | Not covered by this guard |
| Negative controls | Synthetic layout, export, upload, account-projection, credential, and user-data cases | Controls exercise the intended cases but do not protect the scanner source or generated-output exclusions |
| Release documentation | Security, classification, checklist, readiness, and GitHub evidence documents | Required phrases are checked; freshness and semantic consistency are incomplete |
| GitHub synchronization | Direct push helper is a successful no-op; protected snapshot flow is documented | No executable success signal proves a snapshot PR or matching revision |
| Validation registration | Boundary step is registered in `FAST` and inherited by higher tiers | Registered and covered by the requested fast run |

## Ten-category audit matrix

| Category | Result | Verified concern |
| --- | --- | --- |
| Security and secret handling | Finding | Detected values are included in scanner output; generated assignments are excluded |
| Private data and classification | Finding | Public-layout policy has no content/schema guard |
| Current tracked-tree coverage | Partial | Existing tracked files are scanned, except deliberate exclusions |
| Generated bundles | Finding | Tracked static builds bypass generic credential/email checks |
| Self-test and negative controls | Finding | The scanner's own live source is excluded from content scanning |
| History path coverage | Finding | CI's default shallow checkout can make `--all` incomplete |
| History content coverage | Finding | Historical blobs are never scanned for secrets or private data |
| Large-output handling | Finding | Path output is bounded only by the child-process buffer, then logged in full; finding values are truncated but not redacted |
| Revision identity and evidence freshness | Finding | Checked-in protection evidence is not bound by the boundary contract to current `HEAD` |
| Synchronization and fail-closed behavior | Finding | The sync helper succeeds without performing or verifying synchronization |

## Verified findings

### Finding 1 — CI history scan can run against a shallow checkout

- **File and line:** `.github/workflows/ci.yml:45-48`;
  `scripts/test/public-repository-boundary.test.mjs:248-253`
- **Category:** History coverage and release gating
- **Severity:** High
- **Evidence:** The CI checkout sets `persist-credentials: false` but does not
  set `fetch-depth: 0`. The scanner then runs
  `git rev-list --objects --all`. `--all` only covers refs and commit history
  present in the checkout; it does not fetch omitted ancestors.
- **Exposure scenario:** A pull request or main push runs in the default
  shallow Actions checkout. A private file removed before the fetched commit is
  absent from the local object graph, so the boundary step reports no
  historical path even though the public repository still has a reachable
  private object.
- **Recommended fix:** Make the release/history job explicitly fetch the
  complete set of refs and history before scanning, or make the job use a
  provider-side full-history snapshot. Assert the repository is not shallow
  and fail closed before reporting historical cleanliness.

### Finding 2 — Historical content is never inspected

- **File and line:** `scripts/test/public-repository-boundary.test.mjs:248-253`
- **Category:** History secret and private-data coverage
- **Severity:** High
- **Evidence:** `scanHistoryMetadata()` extracts only the path portion of
  `git rev-list --objects --all` output and applies `pathFinding()`. It never
  reads historical blobs or calls `contentFindings()`.
- **Exposure scenario:** A historical commit contains a secret, customer
  record, or private document under an ordinary filename such as a source file
  or configuration file. The path scan returns no finding, and a readiness
  process that treats “no historical private paths” as sufficient can claim a
  clean history without a content scan.
- **Recommended fix:** Add a separate bounded full-history blob/content scan
  using a provider secret scanner or an equivalent reviewed scanner. Keep it
  separate from path classification, redact findings, and require a complete
  ref set before a release claim.

### Finding 3 — Scanner findings can print secret material into CI logs

- **File and line:** `scripts/test/public-repository-boundary.test.mjs:125-126`,
  `:295-298`
- **Category:** Unsafe logging and incident handling
- **Severity:** High
- **Evidence:** `add()` appends `value.slice(0, 80)` to every finding. The
  main failure message prints every finding. Credential-shaped assignments,
  connection URLs, and known token formats therefore place a prefix of the
  matched value in process output.
- **Exposure scenario:** A real credential is accidentally committed. The
  guard correctly fails, but the first portion of the credential is copied to
  GitHub Actions logs, local validation output, or an issue transcript. Anyone
  with access to the log receives additional credential material, and the
  log may be retained after the source file is removed.
- **Recommended fix:** Report only path, line/column if available, and a
  category. Never include matched values. Add a negative control asserting
  that scanner output cannot contain the synthetic secret used to trigger a
  finding.

### Finding 4 — Tracked static builds bypass generic credential and email checks

- **File and line:** `scripts/test/public-repository-boundary.test.mjs:127`,
  `:153-181`
- **Category:** Generated output and distribution boundary
- **Severity:** High
- **Evidence:** Any path containing `static-build` or `node_modules` sets
  `generatedOutput`. That flag skips the generic credential-assignment loop
  and the non-synthetic-email loop. The current repository contains tracked
  files below `artifacts/parts-id/static-build/`.
- **Exposure scenario:** A generated web bundle contains a serialized
  `API_KEY`, database URL, customer email, or other private value that does not
  match one of the narrower token regexes. Because the bundle is tracked and
  distributable, it can be published while the boundary guard returns no
  finding.
- **Recommended fix:** Scan generated outputs with a parser/secret scanner
  designed for minified bundles, or fail closed whenever a tracked generated
  output is present until it is independently scanned. Do not use the
  generated flag to disable security checks; use targeted false-positive
  handling instead. Add generated-output negative controls.

### Finding 5 — The boundary scanner excludes its own live source

- **File and line:** `scripts/test/public-repository-boundary.test.mjs:118-121`
- **Category:** Self-test and exclusion safety
- **Severity:** High
- **Evidence:** When the scanner reads its own tracked path without an explicit
  contents override, `contentFindings()` returns an empty list before reading
  the file. The path itself is also not a prohibited path, so the main scan
  does not inspect the scanner source.
- **Exposure scenario:** A future edit adds a real credential, private example,
  or unsafe fixture to the scanner source. The guard's own tracked source is
  silently exempted, allowing the value to ship and also allowing a future
  negative-control change to weaken the guard without the boundary check
  detecting it.
- **Recommended fix:** Move unsafe negative-control strings into a separate
  ignored fixture or construct them from safe fragments, then scan the scanner
  source normally. If an exclusion is unavoidable, add a dedicated
  self-integrity test that checks the exclusion is limited to known synthetic
  controls and that no credential-shaped assignment or private-data fixture
  was added.

### Finding 6 — Public layout classification is not enforced by content checks

- **File and line:** `docs/public-data-classification.md:9-11`,
  `:36-37`; `scripts/test/public-repository-boundary.test.mjs:72-109`,
  `:118-188`
- **Category:** Data classification and source boundary
- **Severity:** High
- **Evidence:** The policy says public layout files must contain geometry and
  stable labels only, with no row IDs, timestamps, inventory, or user data.
  The executable scanner has path rules for prohibited directories and broad
  credential/email patterns, but no content/schema rule for files under
  `data/public/`.
- **Exposure scenario:** A contributor adds inventory quantities, database row
  IDs, timestamps, or user-related columns to the public warehouse CSV while
  keeping the allowed public path. Unless the added values happen to match
  another generic regex, the boundary guard passes and the data is included
  in the public repository and map distribution.
- **Recommended fix:** Add a fail-closed schema/content contract for every
  public layout source: allowlist columns and value types, reject identifiers,
  timestamps, inventory values, and user fields, and include negative controls
  for each prohibited class.

### Finding 7 — Protection evidence is not bound to the current revision

- **File and line:** `scripts/test/public-repository-boundary.test.mjs:191-235`;
  `docs/validation/github-protection-status.md:58-77`
- **Category:** Revision identity and release evidence
- **Severity:** High
- **Evidence:** The boundary documentation assertion checks that the
  protection document contains status words and control rows, but does not
  compare its recorded evidence revision to `git rev-parse HEAD` or to the
  target release revision. The checked-in protection document is dated
  2026-09-05 and records an earlier revision beginning `a9128979`; the current
  checkout is `a82c0356`. The document itself describes freshness rules, but
  those rules are not enforced by this boundary contract.
- **Exposure scenario:** Workflow, branch-protection, or security settings
  change after a snapshot is recorded. A later validation run still sees
  `verified` rows and a checked-in checklist, even though those rows describe
  a different revision or provider context.
- **Recommended fix:** Require a machine-readable evidence bundle containing
  repository identity, exact target SHA, policy context, permission context,
  and freshness result. Make release validation fail closed when the snapshot
  is missing, stale, or mismatched; do not rely on prose markers alone.

### Finding 8 — The synchronization helper reports success without synchronizing

- **File and line:** `scripts/sync-github.sh:4-13`
- **Category:** Synchronization policy and state integrity
- **Severity:** Medium
- **Evidence:** The script uses `set -euo pipefail` but only prints that direct
  pushing is disabled. It exits zero without checking a snapshot branch,
  pull request, target revision, or remote state. The protected snapshot flow
  is referenced in comments, but this helper does not invoke or verify it.
- **Exposure scenario:** A post-merge caller or operator invokes the helper and
  interprets exit code zero as synchronization success. The public GitHub
  repository can remain stale or contain a different revision while local
  release bookkeeping records no error.
- **Recommended fix:** Make the helper fail with a distinct non-success status
  when direct synchronization is requested, or replace it with a read-only
  verification that confirms the approved snapshot PR and exact tree identity.
  The protected snapshot process should expose an explicit success artifact
  rather than treating a no-op as success.

### Finding 9 — Historical private path names are emitted without redaction

- **File and line:** `scripts/test/public-repository-boundary.test.mjs:301-307`
- **Category:** Large output handling and privacy-safe diagnostics
- **Severity:** Medium
- **Evidence:** When historical path findings exist, the guard prints the
  complete comma-separated path list. The current run emits 100 historical
  paths. Path names can contain customer, catalog, report, timestamp, or
  diagnostic context even when file contents are not printed.
- **Exposure scenario:** Public CI logs, copied validation output, or retained
  artifacts disclose private document names and operational details. A large
  history listing also makes it harder for a reviewer to distinguish a
  bounded summary from complete evidence.
- **Recommended fix:** Print counts and coarse categories by default. Store
  redacted owner-only evidence separately when permitted, and cap diagnostic
  output by count and byte size. Never print a raw private filename unless the
  output destination is explicitly private.

## Controls that passed

- `pnpm run test-fast` passed all 27 registered steps.
- The current tracked-tree scan rejected synthetic negative controls for an
  export path, upload path, account-skill projection path, credential-shaped
  assignment, and non-synthetic user email.
- The current scan accepted the synthetic public layout and migration examples.
- `scripts/validation-steps.mjs:91` registers the boundary check exactly once
  in `FAST`, so it is inherited by the higher validation tiers.
- `scripts/sync-github.sh` does not perform a direct push or expose a command
  line credential. This is a safety property, but it does not make the
  no-op a successful synchronization.
- `SECURITY.md` and the classification/checklist documents consistently state
  that secrets, uploads, exports, user data, logs, and private objects must
  remain outside the public repository.

## Release decision

**Not ready for public release.** The existing historical private-path
findings alone require owner-led history purge and verification. Even after
that purge, the shallow-history, historical-content, generated-output,
self-exclusion, layout-schema, unsafe-logging, revision-freshness, and
synchronization findings must be addressed or explicitly accepted by the
release owner with evidence that does not claim stronger coverage than the
implemented checks provide.

No fix, history rewrite, remote push, repository visibility change, provider
setting change, or secret rotation was performed by this audit.