#!/usr/bin/env node
/**
 * Single source of truth for validation-tier membership.
 */
export const FAST = [
  ["gate-guard", "bash scripts/check-gate-integrity.sh"],
  ["plan-gate-fix", "node scripts/check-failure-gate.mjs --fix-stub"],
  ["plan-gate-check", "node scripts/check-failure-gate.mjs"],
  ["plan-gate-stubs", "node scripts/check-failure-gate.mjs --stubs-only"],
  ["regression-guard-fix", "node scripts/check-regression-guard.mjs --fix-stub"],
  ["regression-guard", "node scripts/check-regression-guard.mjs"],
  ["skill-mirror-sync-contract", "node scripts/test/skill-mirror-sync-contract.test.mjs"],
  ["public-repository-boundary", "node scripts/test/public-repository-boundary.test.mjs"],
  ["patched-dependencies-contract", "node scripts/test/patched-dependencies.test.mjs"],
  ["patched-dependencies", "node scripts/check-patched-dependencies.mjs"],
  ["tsc", 'pnpm run typecheck:libs && pnpm -r --filter "./artifacts/**" --filter "./scripts" --if-present run typecheck'],
  ["lint", "node scripts/check-db-reachability.mjs && pnpm --filter @workspace/parts-id run lint && pnpm --filter @workspace/api-server run lint && pnpm --filter @workspace/mockup-sandbox run lint && pnpm run lint:libs"],
  ["lint-mocks", "pnpm --filter @workspace/scripts run lint:mocks"],
  ["tsconfig-check", "pnpm --filter @workspace/scripts run tsconfig:check"],
   ["port-guard", "node scripts/serial-lock.mjs --resource ports --priority 90 -- bash scripts/check-hardcoded-ports.sh"],
  ["bundle-domain-check", "pnpm --filter @workspace/parts-id run check:bundle-domain"],
  ["light-mode-config", "bash scripts/check-light-mode-config.sh"],
];

export const STANDARD_EXTRA = [
  ["codegen-check", "node scripts/serial-lock.mjs --resource codegen --priority 80 -- pnpm --filter @workspace/api-spec run codegen:check"],
  ["spec-check", "pnpm --filter @workspace/api-spec run spec:check"],
  ["env-check", "pnpm --filter @workspace/scripts env:check"],
  ["spec-check-tests", "pnpm --filter @workspace/api-spec test"],
  ["failure-gate-contract", "node scripts/test/failure-gate-contract.test.mjs"],
  ["github-actions-contract", "node scripts/test/github-actions-contract.test.mjs"],
  ["test", "node scripts/serial-lock.mjs --resource shared-test-results --priority 60 -- pnpm test"],
  ["serve-proxy-smoke", "pnpm --filter @workspace/parts-id run test:serve-proxy"],
];

export const STANDARD_PLUS_EXTRA = [
  ["schema-check", "pnpm --filter @workspace/db run schema:check"],
  ["verify-fts", "pnpm --filter @workspace/db run verify-fts"],
  ["api-server-coverage", "node scripts/serial-lock.mjs --resource shared-test-results --priority 60 -- pnpm --filter @workspace/api-server run test:coverage"],
  ["security-audit", "pnpm audit --audit-level=low"],
  ["post-merge-health-test", "bash scripts/test-post-merge.sh"],
];

export const TIERS = {
  fast: FAST,
  standard: [...FAST, ...STANDARD_EXTRA],
  "standard-plus": [...FAST, ...STANDARD_EXTRA, ...STANDARD_PLUS_EXTRA],
  heavy: [...FAST, ...STANDARD_EXTRA, ...STANDARD_PLUS_EXTRA],
};

export function getTierSteps(tier) {
  return TIERS[tier] ?? null;
}

export function assertTierSteps(tier, steps = getTierSteps(tier)) {
  if (!steps?.length) throw new Error(`tier "${tier}" resolved to an empty step array`);
  for (const entry of steps) {
    if (!Array.isArray(entry) || entry.length < 2 || typeof entry[0] !== "string" || !entry[0] || typeof entry[1] !== "string" || !entry[1]) {
      throw new Error(`malformed step entry in tier "${tier}": ${JSON.stringify(entry)}`);
    }
  }
  return steps;
}