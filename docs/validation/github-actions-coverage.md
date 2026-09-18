# GitHub Actions validation coverage

This matrix is the repository-owned routing contract. The Replit validation tiers
remain the local authority; GitHub runs the portable `standard-plus` tier through
the fail-closed `CI / required` aggregator. Native LiDAR validation is intentionally
not run in CI. GitHub settings and live run status are not inferred from this file.

The workflow contract discovers its inventory with `git ls-files` under
`.github/workflows` and validates every tracked path with the shared permission,
concurrency, timeout, immutable-action, and pull-request safety rules. Workflow-
specific checks remain explicit for the named CI, audit, and README
maintenance roles. Adding a tracked workflow therefore cannot bypass the shared
checks; the contract also includes a negative fixture for an unsafe newly added
workflow.

| Canonical local check | Remote owner / exact command | Coverage and decision | Event scope | Evidence |
|---|---|---|---|---|
| node-runtime | `CI / required` → `pnpm run test-standard-plus` | direct portable check that active Node matches the exact `.node-version` pin and satisfies the bounded Node 24 range in `package.json` `engines.node` | PR, merge queue, main push, manual | inferred from tier manifest |
| gate-guard | `CI / required` → `pnpm run test-standard-plus` | direct portable coverage | PR, merge queue, main push, manual | inferred from tracked workflow |
| ai-provider-startup-export-contract | `CI / required` → `pnpm run test-standard-plus` | direct portable contract preventing startup-named live-probe exports | PR, merge queue, main push, manual | inferred from tier manifest |
| api-route-authorization-contract | `CI / required` → `pnpm run test-standard-plus` | direct portable privileged-route middleware contract | PR, merge queue, main push, manual | inferred from tier manifest |
| api-spec-typecheck-contract | `CI / required` → `pnpm run test-standard-plus` | focused contract proving API-spec typechecking remains in the fast validation graph | PR, merge queue, main push, manual | tracked contract test |
| api-spec-typecheck | `CI / required` → `pnpm run test-standard-plus` | direct portable API-spec source and test-helper typecheck | PR, merge queue, main push, manual | inferred from tier manifest |
| api-suite-floor-contract | `CI / required` → `pnpm run test-standard-plus` | direct portable floor-plan fixture-isolation contract | PR, merge queue, main push, manual | inferred from tier manifest |
| poe-setup-targeted-correction-contract | `CI / required` → `pnpm run test-standard-plus` | direct portable contract preventing unsafe Poe secret names, import-time setup, and `/bot/` OpenAI SDK composition | PR, merge queue, main push, manual | inferred from tier manifest |
| validation-runtime-contract | `CI / required` → `pnpm run test-standard-plus` | direct portable contract for test-step database mode and aligned Node runtime declarations | PR, merge queue, main push, manual | tracked contract test |
| skill-mirror-sync-contract | `CI / required` → `pnpm run test-standard-plus` | direct portable account-skill projection contract | PR, merge queue, main push, manual | inferred from tier manifest |
| public-repository-boundary | `CI / required` → `pnpm run test-standard-plus` | direct portable boundary scan; historical findings require owner-led remediation | PR, merge queue, main push, manual | inferred from tier manifest |
| plan-gate-fix | none | local-only: task-plan archive and task provenance are not available in an untrusted PR checkout | local task validation | intentional local-only |
| plan-gate-check | none | local-only: task-plan tier ceiling is enforced by Replit task validation | local task validation | intentional local-only |
| plan-gate-stubs | none | local-only: task-plan archive inspection is intentionally excluded | local task validation | intentional local-only |
| regression-guard-fix | none | local-only: task-scoped plan declaration repair is not a remote merge check | local task validation | intentional local-only |
| regression-guard | none | local-only: task-scoped regression declaration ownership stays with Replit | local task validation | intentional local-only |
| patched-dependencies-contract | `CI / required` → `pnpm run test-standard-plus` | direct portable regression coverage for patch context and final-newline failures | PR, merge queue, main push, manual | inferred from tier manifest |
| patched-dependencies | `CI / required` → `pnpm run test-standard-plus` | exact published package extraction, lock hash verification, and patch applicability check | PR, merge queue, main push, manual | inferred from tier manifest |
| replit-config-contract | `CI / required` → `pnpm run test-standard-plus` | real-parser coverage for the complete Replit configuration and malformed TOML rejection | PR, merge queue, main push, manual | tracked contract test |
| tsc | `CI / required` → `pnpm run test-standard-plus` | direct portable coverage via the fast tier | PR, merge queue, main push, manual | inferred from tier manifest |
| lint | `CI / required` → `pnpm run test-standard-plus` | direct portable coverage | PR, merge queue, main push, manual | inferred from tier manifest |
| lint-mocks | `CI / required` → `pnpm run test-standard-plus` | direct portable coverage | PR, merge queue, main push, manual | inferred from tier manifest |
| tsconfig-check | `CI / required` → `pnpm run test-standard-plus` | direct portable coverage | PR, merge queue, main push, manual | inferred from tier manifest |
| static-validation-boundaries | `CI / required` → `pnpm run test-standard-plus` | focused fixtures prove nested TypeScript projects and server-package environment reads cannot be omitted silently | PR, merge queue, main push, manual | tracked contract test |
| port-authority-contract | `CI / required` → `pnpm run test-standard-plus` | isolated cleanup and serialization contract coverage | PR, merge queue, main push, manual | tracked contract test |
| port-guard | `CI / required` → `pnpm run test-standard-plus` | direct portable one-shot scan | PR, merge queue, main push, manual | inferred from tier manifest |
| bundle-domain-check | `CI / required` → `pnpm run test-standard-plus` | direct portable coverage | PR, merge queue, main push, manual | inferred from tier manifest |
| light-mode-config | `CI / required` → `pnpm run test-standard-plus` | direct portable coverage | PR, merge queue, main push, manual | inferred from tier manifest |
| codegen-check | `CI / required` → `pnpm run test-standard-plus` | generated output and drift check; no separate codegen job | PR, merge queue, main push, manual | inferred from tier manifest |
| spec-check | `CI / required` → `pnpm run test-standard-plus` | covered by the canonical tier; not split into a duplicate job | PR, merge queue, main push, manual | inferred from tier manifest |
| env-check | `CI / required` → `pnpm run test-standard-plus` | direct portable coverage | PR, merge queue, main push, manual | inferred from tier manifest |
| privacy-check | `CI / required` → `pnpm run test-standard-plus` | direct portable deployment-configuration status check; secret values are never printed | PR, merge queue, main push, manual | inferred from tier manifest |
| privacy-check-contract | `CI / required` → `pnpm run test-standard-plus` | regression coverage for fail-closed CORS and disabled unique visitors without privacy key material | PR, merge queue, main push, manual | tracked contract test |
| production-database-target | `CI / required` → `pnpm run test-standard-plus` | target-safety assertion only; rejects non-production `DATABASE_ENV` before API bundling and does not claim database reachability | PR, merge queue, main push, manual | tracked runtime-boundary contract |
| spec-check-tests | `CI / required` → `pnpm run test-standard-plus` | direct portable coverage | PR, merge queue, main push, manual | inferred from tier manifest |
| failure-gate-package-sync | `CI / required` → `pnpm run test-standard-plus` | refreshes the tracked Failure Gate archive from canonical `.agents` sources only when packaged bytes drift | PR, merge queue, main push, manual | inferred from tier manifest |
| failure-gate-contract | `CI / required` → `pnpm run test-standard-plus` | contract coverage; task archive remains local-only | PR, merge queue, main push, manual | inferred from tier manifest |
| github-actions-contract | `CI / required` → `pnpm run test-standard-plus` | deterministic workflow and mapping contract | PR, merge queue, main push, manual | tracked contract test |
| validation-parser-tests | `CI / required` → `pnpm run test-standard-plus` | syntax-aware fixtures for JSONC parsing, Jest mock call detection, comment-like strings, regex literals, template literals, and workspace subpaths | PR, merge queue, main push, manual | tracked parser fixture test |
| native-lidar | `CI / required` → reusable `LiDAR Measure Tests` workflow → `xcodebuild test` | required native platform validation; any failure, cancellation, skip, missing result, or unexpected conclusion fails the stable aggregator | PR, merge queue, main push, manual | tracked workflow contract |
| dependency-security-contract | `CI / required` → `pnpm run test-standard-plus` | safe lockfile floors for audited packages and exact `image-size` patch/exception linkage | PR, merge queue, main push, manual | tracked contract test |
| parts-id-dependency-contract | `CI / required` → `pnpm run test-standard-plus` | prevents Parts ID runtime packages from also being declared as development dependencies | PR, merge queue, main push, manual | tracked contract test |
| test | `CI / required` → `pnpm run test-standard-plus` | all canonical Jest/Vitest suites; no separate test job | PR, merge queue, main push, manual | inferred from tier manifest |
| serve-proxy-smoke | `CI / required` → `pnpm run test-standard-plus` | direct portable smoke coverage | PR, merge queue, main push, manual | inferred from tier manifest |
| schema-check | `CI / required` → `pnpm run test-standard-plus` | isolated PostgreSQL service plus schema preparation | PR, merge queue, main push, manual | inferred from workflow |
| verify-fts | `CI / required` → `pnpm run test-standard-plus` | isolated PostgreSQL service | PR, merge queue, main push, manual | inferred from workflow |
| api-server-coverage | `CI / required` → `pnpm run test-standard-plus` | coverage is produced by the same owning tier; upload is diagnostic-only | PR, merge queue, main push, manual | inferred from tier manifest |
| security-audit | `CI / required` → `pnpm run test-standard-plus` | low-and-above audit; no production credentials | PR, merge queue, main push, manual | inferred from tier manifest |
| post-merge-health-test | `CI / required` → `pnpm run test-standard-plus` | portable post-merge health contract | PR, merge queue, main push, manual | inferred from tier manifest |
| github-provider-capability-preflight | none | provider-side read-only evidence for Actions, branch protection, rulesets, selected actions, and SHA pinning; unavailable evidence is blocked or unknown and never activatable | owner-approved read-only inspection only | provider evidence contract |
| github-security-controls | none | provider-side read-only evidence for secret scanning, push protection, dependency graph, and Dependabot; disabled or unavailable controls remain actionable failures | owner-approved read-only inspection only | provider evidence contract |

The macOS `LidarMeasureTests` job is the platform-specific native owner called
by `CI`. Its result is a dependency of the stable `CI / required` aggregator, so
the required context cannot pass unless both portable and native validation
succeed. The scheduled audit is maintenance-only; README synchronization is the
only write-capable workflow and accepts no pull-request event.

The two provider evidence rows are not local validation commands and do not
authorize remote changes. They document the evidence boundary that must be
resolved separately from the portable `standard-plus` tier.
