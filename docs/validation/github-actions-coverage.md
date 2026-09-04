# GitHub Actions validation coverage

This matrix is the repository-owned routing contract. The Replit validation tiers
remain the local authority; GitHub runs the portable `standard-plus` tier once
through the `CI / required` aggregator. GitHub settings and live run status are
not inferred from this file.

| Canonical local check | Remote owner / exact command | Coverage and decision | Event scope | Evidence |
|---|---|---|---|---|
| gate-guard | `CI / required` → `pnpm run test-standard-plus` | direct portable coverage | PR, merge queue, main push, manual | inferred from tracked workflow |
| skill-mirror-sync-contract | `CI / required` → `pnpm run test-standard-plus` | direct portable account-skill projection contract | PR, merge queue, main push, manual | inferred from tier manifest |
| public-repository-boundary | `CI / required` → `pnpm run test-standard-plus` | direct portable boundary scan; historical findings require owner-led remediation | PR, merge queue, main push, manual | inferred from tier manifest |
| plan-gate-fix | none | local-only: task-plan archive and task provenance are not available in an untrusted PR checkout | local task validation | intentional local-only |
| plan-gate-check | none | local-only: task-plan tier ceiling is enforced by Replit task validation | local task validation | intentional local-only |
| plan-gate-stubs | none | local-only: task-plan archive inspection is intentionally excluded | local task validation | intentional local-only |
| regression-guard-fix | none | local-only: task-scoped plan declaration repair is not a remote merge check | local task validation | intentional local-only |
| regression-guard | none | local-only: task-scoped regression declaration ownership stays with Replit | local task validation | intentional local-only |
| patched-dependencies-contract | `CI / required` → `pnpm run test-standard-plus` | direct portable regression coverage for patch context and final-newline failures | PR, merge queue, main push, manual | inferred from tier manifest |
| patched-dependencies | `CI / required` → `pnpm run test-standard-plus` | exact published package extraction, lock hash verification, and patch applicability check | PR, merge queue, main push, manual | inferred from tier manifest |
| tsc | `CI / required` → `pnpm run test-standard-plus` | direct portable coverage via the fast tier | PR, merge queue, main push, manual | inferred from tier manifest |
| lint | `CI / required` → `pnpm run test-standard-plus` | direct portable coverage | PR, merge queue, main push, manual | inferred from tier manifest |
| lint-mocks | `CI / required` → `pnpm run test-standard-plus` | direct portable coverage | PR, merge queue, main push, manual | inferred from tier manifest |
| tsconfig-check | `CI / required` → `pnpm run test-standard-plus` | direct portable coverage | PR, merge queue, main push, manual | inferred from tier manifest |
| port-guard | `CI / required` → `pnpm run test-standard-plus` | direct portable one-shot scan | PR, merge queue, main push, manual | inferred from tier manifest |
| bundle-domain-check | `CI / required` → `pnpm run test-standard-plus` | direct portable coverage | PR, merge queue, main push, manual | inferred from tier manifest |
| light-mode-config | `CI / required` → `pnpm run test-standard-plus` | direct portable coverage | PR, merge queue, main push, manual | inferred from tier manifest |
| codegen-check | `CI / required` → `pnpm run test-standard-plus` | generated output and drift check; no separate codegen job | PR, merge queue, main push, manual | inferred from tier manifest |
| spec-check | `CI / required` → `pnpm run test-standard-plus` | covered by the canonical tier; not split into a duplicate job | PR, merge queue, main push, manual | inferred from tier manifest |
| env-check | `CI / required` → `pnpm run test-standard-plus` | direct portable coverage | PR, merge queue, main push, manual | inferred from tier manifest |
| spec-check-tests | `CI / required` → `pnpm run test-standard-plus` | direct portable coverage | PR, merge queue, main push, manual | inferred from tier manifest |
| failure-gate-contract | `CI / required` → `pnpm run test-standard-plus` | contract coverage; task archive remains local-only | PR, merge queue, main push, manual | inferred from tier manifest |
| github-actions-contract | `CI / required` → `pnpm run test-standard-plus` | deterministic workflow and mapping contract | PR, merge queue, main push, manual | tracked contract test |
| test | `CI / required` → `pnpm run test-standard-plus` | all canonical Jest/Vitest suites; no separate test job | PR, merge queue, main push, manual | inferred from tier manifest |
| serve-proxy-smoke | `CI / required` → `pnpm run test-standard-plus` | direct portable smoke coverage | PR, merge queue, main push, manual | inferred from tier manifest |
| schema-check | `CI / required` → `pnpm run test-standard-plus` | isolated PostgreSQL service plus schema preparation | PR, merge queue, main push, manual | inferred from workflow |
| verify-fts | `CI / required` → `pnpm run test-standard-plus` | isolated PostgreSQL service | PR, merge queue, main push, manual | inferred from workflow |
| api-server-coverage | `CI / required` → `pnpm run test-standard-plus` | coverage is produced by the same owning tier; upload is diagnostic-only | PR, merge queue, main push, manual | inferred from tier manifest |
| security-audit | `CI / required` → `pnpm run test-standard-plus` | low-and-above audit; no production credentials | PR, merge queue, main push, manual | inferred from tier manifest |
| post-merge-health-test | `CI / required` → `pnpm run test-standard-plus` | portable post-merge health contract | PR, merge queue, main push, manual | inferred from tier manifest |

The macOS `LidarMeasureTests` job is a supplemental platform-specific owner for
the native suite and is not hidden behind the Linux aggregator. The scheduled
audit is maintenance-only; README synchronization is the only write-capable
workflow and accepts no pull-request event.