# GitHub protection status

**Assessment date:** 2026-09-05
**Repository:** `makerdan/EES-Parts-ID`  
**Evidence type:** GitHub REST API activation and read-only verification through
the authorized GitHub connection. The requested repository security settings were
enabled, then each control was re-read through GitHub.

This report distinguishes settings that GitHub positively returned as enabled
from settings that require owner action. `unverified` means the API did not
provide enough evidence to make a claim; it must never be read as enabled.

The security-control check is read-only. A missing, disabled, or permission-
blocked response produces an actionable `unavailable`, `blocked`, or `unknown`
result; it does not enable a control, rewrite evidence, or print secret values.

| Control | Status | Evidence and next action |
| --- | --- | --- |
| Repository visibility | `verified` | Repository API returned `visibility: public`. |
| Secret scanning | `verified` | Repository security settings returned `secret_scanning.status: enabled`; the secret-scanning alerts endpoint returned HTTP 200 on re-check. |
| Push protection | `verified` | Repository security settings returned `secret_scanning_push_protection.status: enabled` on re-check. |
| Dependency alerts | `verified` | The vulnerability-alerts endpoint returned HTTP 204 after activation, and the Dependabot alerts endpoint returned HTTP 200 on re-check; these endpoints verify the dependency graph/Dependabot alert surface is enabled. |
| Pull requests on `main` | `verified` | Branch protection returned a required pull-request review rule. The existing zero-approval requirement is recorded without inventing a new review policy. |
| Required validation | `verified` | `main` requires strict status context `CI / required`. |
| Conversation resolution | `verified` | Branch protection returned `required_conversation_resolution.enabled: true`. |
| Administrator enforcement | `verified` | Branch protection returned `enforce_admins.enabled: true`. |
| Force-push block | `verified` | Branch protection returned `allow_force_pushes.enabled: false`. |
| Branch-deletion block | `verified` | Branch protection returned `allow_deletions.enabled: false`. |
| Default workflow token | `verified` | Actions workflow permissions returned `default_workflow_permissions: read`. |
| Workflow-token PR approval | `verified` | Actions workflow permissions returned `can_approve_pull_request_reviews: false`. |
| Actions SHA pinning | `verified` | Actions permissions returned `sha_pinning_required: true`. |

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

The repository is public, and the three requested provider-side security
controls are now enabled and verified through GitHub. This report records the
live state as of 2026-09-05; re-run the checks after any repository visibility,
security-policy, or GitHub-account permission change.

The branch-protection and Actions evidence is also summarized in
[GitHub Actions installation](github-actions-installation.md). This report
does not replace GitHub's live settings or a provider secret scan.

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