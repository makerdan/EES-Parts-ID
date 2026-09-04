---
name: GitHub Actions token PR creation policy
description: Why protected-branch maintenance publishes an automation branch instead of opening its own pull request.
---

When repository settings disallow GitHub Actions from creating or approving pull
requests, `GITHUB_TOKEN` cannot create a pull request even if the workflow grants
`pull-requests: write`. GitHub returns `createPullRequest` as not permitted.

**Why:** The repository intentionally keeps workflow-token PR creation/approval
disabled. Granting the YAML permission alone does not override that repository
policy.

**How to apply:** Maintenance workflows that need to update a protected default
branch should push a reviewable automation branch and publish a compare/PR link,
unless the repository owner explicitly chooses to enable workflow-token PR
creation.