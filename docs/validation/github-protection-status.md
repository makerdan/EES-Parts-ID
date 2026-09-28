# GitHub protection status

**Assessment date:** 2026-09-22
**Repository:** `makerdan/EES-Parts-ID`  
**Evidence type:** GitHub REST API activation and read-only verification through
the authorized GitHub connection. The requested repository security settings were
enabled, then each control was re-read through GitHub.

## Release-readiness evidence

This is a historical snapshot, not approval of the repository revision under
review. Its machine-readable context must be evaluated against the current
checkout; a stale result cannot support a current release claim.

**Target repository:** `makerdan/EES-Parts-ID`
**Target revision SHA:** `8d82e3953a756074325b9332665a3063686cd572`
**Policy context:** `{"actions":{"canApprovePullRequestReviews":false,"defaultWorkflowPermissions":"read","shaPinningRequired":true},"branchProtection":{"allowDeletions":false,"allowForcePushes":false,"enforceAdmins":true,"requiredConversationResolution":true,"requiredPullRequestReviews":true},"selectedActions":{"githubOwnedAllowed":true,"patterns":["pnpm/action-setup@*"],"policy":"selected","verifiedAllowed":false},"requiredChecks":["CI / required"],"strict":true}`
**Permission context:** `{"actions":"read","contents":"read"}`
**Freshness result:** `stale`

The captured revision differs from the checkout under review. The historical
provider responses below remain useful as dated evidence, but **none of these
controls is verified for the current checkout**. A release decision needs a
new read-only, revision- and permission-bound provider check.

This report distinguishes settings that GitHub positively returned as enabled
from settings that require owner action. `unverified` means the API did not
provide enough evidence to make a claim; it must never be read as enabled.

The security-control check is read-only. A missing, disabled, or permission-
blocked response produces an actionable `unavailable`, `blocked`, or `unknown`
result; it does not enable a control, rewrite evidence, or print secret values.

| Control | Status | Evidence and next action |
| --- | --- | --- |
| Repository visibility | `stale` | Historical repository API returned `visibility: public`; re-check before a release claim. |
| Secret scanning | `stale` | Historical security settings returned `secret_scanning.status: enabled`; alerts endpoint returned HTTP 200. Re-check. |
| Push protection | `stale` | Historical security settings returned `secret_scanning_push_protection.status: enabled`; re-check. |
| Dependency alerts | `stale` | Historical vulnerability-alerts endpoint returned HTTP 204 and Dependabot alerts endpoint returned HTTP 200; re-check. |
| Pull requests on `main` | `stale` | Historical branch protection returned a required pull-request review rule; re-check. |
| Required validation | `stale` | Historical `main` protection required strict `CI / required`; no current-revision pass is claimed. |
| Conversation resolution | `stale` | Historical branch protection returned `required_conversation_resolution.enabled: true`; re-check. |
| Administrator enforcement | `stale` | Historical branch protection returned `enforce_admins.enabled: true`; re-check. |
| Force-push block | `stale` | Historical branch protection returned `allow_force_pushes.enabled: false`; re-check. |
| Branch-deletion block | `stale` | Historical branch protection returned `allow_deletions.enabled: false`; re-check. |
| Default workflow token | `stale` | Historical Actions permissions returned `default_workflow_permissions: read`; re-check. |
| Workflow-token PR approval | `stale` | Historical Actions permissions returned `can_approve_pull_request_reviews: false`; re-check. |
| Actions SHA pinning | `stale` | Historical Actions permissions returned `sha_pinning_required: true`; re-check. |

## Security-control evidence contract

The four controls below are the required provider-side security evidence. The
dependency graph is verified by the vulnerability-alerts endpoint, while
Dependabot is verified by its alerts endpoint. HTTP responses that cannot be
read are explicitly unavailable or unknown rather than a pass.

| Control | Read-only evidence | Bounded failure action |
| --- | --- | --- |
| Secret scanning | security settings enabled state plus alerts endpoint | ask an administrator to enable it, then re-check |
| Push protection | security settings enabled state | ask an administrator to enable it, then re-check |
| Dependency graph | vulnerability-alerts endpoint returns success | ask an administrator to enable it, then re-check |
| Dependabot alerts | Dependabot alerts endpoint returns success | ask an administrator to enable it, then re-check |

## Provider-side security status before public launch

On 2026-09-22, GitHub returned public visibility and enabled settings for
the requested controls. Those responses do not verify the current checkout
or authorize a public-release claim. Re-run read-only checks with matching
repository, revision, policy, and permission context before approval.

The branch-protection and Actions evidence is also summarized in
[GitHub Actions installation](github-actions-installation.md). This report
does not replace GitHub's live settings or a provider secret scan.

### Read-only re-check on 2026-09-23

The authorized GitHub connection made GET requests for the repository, the
checkout commit, `main`, branch protection, repository Actions permissions,
selected Actions, workflow-token permissions, vulnerability alerts, Dependabot
alerts, and secret-scanning alerts. No setting was changed. The repository
returned public visibility, enabled secret scanning and push protection,
HTTP 200 for both alert endpoints, and HTTP 204 for vulnerability alerts.
`main` protection returned strict `CI / required`, pull-request review
requirements, conversation resolution and administrator enforcement, with
force pushes and deletion disabled. Actions returned a read-only default
workflow token, disabled workflow-token PR approval, required SHA pinning,
and the selected Actions policy (`pnpm/action-setup@*`, GitHub-owned allowed,
verified marketplace actions disallowed).

This re-check used read-only API methods through a connection with repository
access; it does **not** establish that the connection has only read scopes or
that any validation job passed. At collection time GitHub reported `main` at
`79865dba26bcb283726fcd46e364830c07f2e151`, while a GET for checkout
revision `555fea2326604e4e1e2a2d2d41cb5312e98e8425` returned HTTP 422
(`No commit found for SHA`). These observed settings are therefore **not a
revision-bound protection snapshot for this checkout**. The machine-readable
snapshot above remains tied to its original revision and `stale`; none of its
control rows may be promoted to `verified` for this checkout. Before a release
claim, re-check the exact published revision and its policy and permission
context, and verify the required run separately.

The protection freshness contract was checked with the policy returned by
these GET requests and the connection/method context: a snapshot bound to
GitHub's reported `main` revision evaluated `current`, while evaluating that
same snapshot against the local checkout revision evaluated `stale`. The
`current` result applies only to the remote revision and is not a release
approval or a substitute for the checked-in report's stale result.

## Snapshot freshness

Any retained protection snapshot must be bound to all four values below:

1. repository owner/name;
2. exact 40-character revision SHA;
3. the policy context read from GitHub; and
4. the permission context used to read that policy.

The read-only evidence contract marks a snapshot `stale` when one of these
values is missing or differs from the current re-check. A historical
`verified` control is not a current claim after context changes, and a failed
or provider-withheld log response is never converted into a passing check.

Every protection report must include the freshness result from the same
read-only re-check. If the snapshot or current context is missing, or if the
repository, revision, policy, or permission context differs, the report is
`stale`; its controls are also marked `stale` and cannot support a current or
verified claim. Consumers must not display the historical child status as
current until a new snapshot has been collected and evaluated.

## Required validation contract

The single branch-protection context is `CI / required`. On `pull_request` and
`merge_group` events, the `CI` workflow runs the portable validation job, then
the required job inspects its result. Only a `success` result produces a
passing required context. `failure`, `cancelled`, `skipped`, missing, and
unexpected results all fail closed.
