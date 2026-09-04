# GitHub protection status

**Assessment date:** 2026-09-04  
**Repository:** `makerdan/EES-Parts-ID`  
**Evidence type:** read-only GitHub REST API snapshot through the authorized
GitHub connection. No repository settings were changed by this assessment.

This report distinguishes settings that GitHub positively returned as enabled
from settings that require owner action. `unverified` means the API did not
provide enough evidence to make a claim; it must never be read as enabled.

| Control | Status | Evidence and next action |
| --- | --- | --- |
| Repository visibility | `verified` | Repository API returned `visibility: public`. |
| Secret scanning | `owner-action-required` | Secret-scanning alerts endpoint reported that secret scanning is disabled. Enable it in the repository Security settings, then re-check. |
| Push protection | `owner-action-required` | Push-protection endpoint did not return an enabled setting while secret scanning was disabled. Enable push protection, then re-check. |
| Dependency alerts | `owner-action-required` | Vulnerability-alerts endpoint reported alerts disabled; the Dependabot alerts endpoint also reported alerts disabled. Enable dependency graph/Dependabot alerts, then re-check. |
| Pull requests on `main` | `verified` | Branch protection returned a required pull-request review rule. The existing zero-approval requirement is recorded without inventing a new review policy. |
| Required validation | `verified` | `main` requires strict status context `CI / required`. |
| Conversation resolution | `verified` | Branch protection returned `required_conversation_resolution.enabled: true`. |
| Administrator enforcement | `verified` | Branch protection returned `enforce_admins.enabled: true`. |
| Force-push block | `verified` | Branch protection returned `allow_force_pushes.enabled: false`. |
| Branch-deletion block | `verified` | Branch protection returned `allow_deletions.enabled: false`. |
| Default workflow token | `verified` | Actions workflow permissions returned `default_workflow_permissions: read`. |
| Workflow-token PR approval | `verified` | Actions workflow permissions returned `can_approve_pull_request_reviews: false`. |
| Actions SHA pinning | `verified` | Actions permissions returned `sha_pinning_required: true`. |

## Owner action before public launch

The repository is public, but the three security controls marked
`owner-action-required` are not enabled in this snapshot. An owner must enable
and re-check them before calling the repository release-ready. Until then,
keep the release blocked and do not replace these statuses with a claim of
completion.

The branch-protection and Actions evidence is also summarized in
[GitHub Actions installation](github-actions-installation.md). This report
does not replace GitHub's live settings or a provider secret scan.