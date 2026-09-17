#!/usr/bin/env node
/**
 * Single source of truth for validation-tier membership.
 */
const ALL_VALIDATION_TIERS = ["fast", "standard", "standard-plus", "heavy"];

/**
 * Host utilities used by validation commands.
 *
 * Keep the capability and setup source next to the tier contract so a missing
 * host dependency can be diagnosed before a validation process enters a
 * serialized queue. The probes are intentionally simple version/help calls:
 * they verify that the executable is both discoverable and runnable without
 * touching the repository or starting a validation step.
 */
export const VALIDATION_HOST_TOOLS = Object.freeze([
  {
    name: "node",
    probeArgs: ["--version"],
    capability: "Node-based validation scripts",
    setup: "the Replit Node.js 24 module and the pinned .node-version",
  },
  {
    name: "pnpm",
    probeArgs: ["--version"],
    capability: "workspace package scripts, typechecks, and test suites",
    setup: "the repository packageManager declaration (pnpm@10.26.1)",
  },
  {
    name: "bash",
    probeArgs: ["--version"],
    capability: "shell-based validation guards and test harnesses",
    setup: "the host bash package",
  },
  {
    name: "git",
    probeArgs: ["--version"],
    capability: "public repository boundary and history checks",
    setup: "the host Git package",
  },
  {
    name: "flock",
    probeArgs: ["--help"],
    capability: "serialized validation, codegen, test, and port-guard steps",
    setup: "the host util-linux package",
  },
]);

export const STANDARD_PLUS_HOST_TOOLS = Object.freeze([
  ...VALIDATION_HOST_TOOLS,
  {
    name: "curl",
    probeArgs: ["--version"],
    capability: "standard-plus post-merge health checks",
    setup: "the host curl package",
  },
  {
    name: "timeout",
    probeArgs: ["--version"],
    capability: "standard-plus post-merge command time limits",
    setup: "the host coreutils package",
  },
]);

export function getValidationHostTools(tier = "fast") {
  if (!ALL_VALIDATION_TIERS.includes(tier)) {
    throw new Error(
      `unknown validation tier "${tier}"; expected one of: ${ALL_VALIDATION_TIERS.join(", ")}`,
    );
  }
  return tier === "standard-plus" || tier === "heavy"
    ? STANDARD_PLUS_HOST_TOOLS
    : VALIDATION_HOST_TOOLS;
}

export const FAST = [
  ["node-runtime", "node scripts/check-node-runtime.mjs"],
  ["gate-guard", "bash scripts/check-gate-integrity.sh"],
  ["plan-gate-fix", "node scripts/check-failure-gate.mjs --fix-stub"],
  ["plan-gate-check", "node scripts/check-failure-gate.mjs"],
  ["plan-gate-stubs", "node scripts/check-failure-gate.mjs --stubs-only"],
  ["regression-guard-fix", "node scripts/check-regression-guard.mjs --fix-stub"],
  ["regression-guard", "node scripts/check-regression-guard.mjs"],
  ["api-suite-floor-contract", "node scripts/test/api-suite-floor-contract.test.mjs"],
  ["github-actions-contract", "node scripts/test/github-actions-contract.test.mjs"],
  ["validation-runtime-contract", "node scripts/test/validation-runtime-contract.test.mjs"],
  ["api-route-authorization-contract", "node scripts/test/api-route-authorization-contract.test.mjs"],
  ["ai-provider-startup-export-contract", "node scripts/test/ai-provider-startup-export-contract.test.mjs"],
  ["poe-setup-targeted-correction-contract", "node skill-previews/poe-setup/targeted-correction-contract.test.mjs"],
  ["skill-mirror-sync-contract", "node scripts/test/skill-mirror-sync-contract.test.mjs"],
  ["public-repository-boundary", "node scripts/test/public-repository-boundary.test.mjs"],
  ["dependency-security-contract", "node scripts/test/dependency-security-contract.test.mjs"],
  ["patched-dependencies-contract", "node scripts/test/patched-dependencies.test.mjs"],
  ["patched-dependencies", "node scripts/check-patched-dependencies.mjs"],
  ["replit-config-contract", "node scripts/test/replit-config-contract.test.mjs"],
  ["tsc", 'pnpm run typecheck:libs && pnpm -r --filter "./artifacts/**" --filter "./scripts" --if-present run typecheck'],
  ["api-spec-typecheck-contract", "node scripts/test/api-spec-typecheck-contract.test.mjs"],
  ["api-spec-typecheck", "pnpm --filter @workspace/api-spec run typecheck"],
  ["lint", "node scripts/check-db-reachability.mjs && pnpm --filter @workspace/parts-id run lint && pnpm --filter @workspace/api-server run lint && pnpm --filter @workspace/mockup-sandbox run lint && pnpm run lint:libs"],
  ["lint-mocks", "pnpm --filter @workspace/scripts run lint:mocks"],
  ["tsconfig-check", "pnpm --filter @workspace/scripts run tsconfig:check"],
  ["port-authority-contract", "node scripts/test-port-authority.mjs"],
  ["port-guard", "node scripts/serial-lock.mjs --resource ports --priority 1 -- bash scripts/check-hardcoded-ports.sh"],
  ["bundle-domain-check", "pnpm --filter @workspace/parts-id run check:bundle-domain"],
  ["light-mode-config", "bash scripts/check-light-mode-config.sh"],
];

export const STANDARD_EXTRA = [
  ["codegen-check", "node scripts/serial-lock.mjs --resource codegen --priority 2 -- pnpm --filter @workspace/api-spec run codegen:check"],
  ["spec-check", "pnpm --filter @workspace/api-spec run spec:check"],
  ["env-check", "pnpm --filter @workspace/scripts env:check"],
  ["privacy-check", "pnpm --filter @workspace/scripts privacy:check"],
  ["privacy-check-contract", "node scripts/test/production-privacy-check.test.mjs"],
  ["production-database-target", "DATABASE_ENV=production NODE_ENV=production pnpm --filter @workspace/api-server run check:production-database-target"],
  ["spec-check-tests", "pnpm --filter @workspace/api-spec test"],
  ["failure-gate-contract", "node scripts/test/failure-gate-contract.test.mjs"],
  ["test", "node scripts/serial-lock.mjs --resource shared-test-results --priority 2 -- pnpm test"],
  ["serve-proxy-smoke", "pnpm --filter @workspace/parts-id run test:serve-proxy"],
];

export const STANDARD_PLUS_EXTRA = [
  ["schema-check", "pnpm --filter @workspace/db run schema:check"],
  ["verify-fts", "pnpm --filter @workspace/db run verify-fts"],
  ["api-server-coverage", "node scripts/serial-lock.mjs --resource shared-test-results --priority 2 -- pnpm --filter @workspace/api-server run test:coverage"],
  ["security-audit", "pnpm audit --audit-level=low"],
  ["post-merge-health-test", "bash scripts/test-post-merge.sh"],
];

export const HEAVY_EXTRA = [
  [
    "protected-map-concurrency",
    "pnpm --filter @workspace/mockup-sandbox run test:protected-map-smoke",
  ],
];

export const TIERS = {
  fast: FAST,
  standard: [...FAST, ...STANDARD_EXTRA],
  "standard-plus": [...FAST, ...STANDARD_EXTRA, ...STANDARD_PLUS_EXTRA],
  heavy: [...FAST, ...STANDARD_EXTRA, ...STANDARD_PLUS_EXTRA, ...HEAVY_EXTRA],
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