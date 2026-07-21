#!/usr/bin/env node
/**
 * run-tier.mjs — consolidated validation tier runner (Port-Authority-Heavy Step 3).
 *
 * Usage: node scripts/serial-lock.mjs -- node scripts/run-tier.mjs <fast|standard|heavy>
 *
 * Runs the member checks of the requested tier sequentially, fails fast on
 * the first non-zero exit, and prints a per-step timing report. Tiers are
 * cumulative: standard includes fast, heavy includes standard.
 *
 * Serialization: the registered validation commands wrap this script in
 * scripts/serial-lock.mjs, so per-step timings below are measured AFTER lock
 * acquisition — queue-wait time is never counted against a step. Steps that
 * internally re-wrap the lock (e.g. scripts/test-all.sh) run reentrantly via
 * SERIAL_LOCK_HELD_PID and do not deadlock.
 *
 * NOTE: tier membership is documented in replit.md ("Checks: validation
 * commands"). Keep the two in sync when adding/removing checks.
 */
import { spawnSync } from "node:child_process";

// [name, shell command] — mirrors the individually registered validation
// commands, which remain available for targeted runs.
const FAST = [
  ["tsc", 'pnpm run typecheck:libs && pnpm -r --filter "./artifacts/**" --filter "./scripts" --if-present run typecheck'],
  ["lint", "node scripts/check-db-reachability.mjs && pnpm --filter @workspace/parts-id run lint && pnpm --filter @workspace/api-server run lint && pnpm --filter @workspace/mockup-sandbox run lint && pnpm run lint:libs"],
  ["lint-mocks", "pnpm --filter @workspace/scripts run lint:mocks"],
  ["tsconfig-check", "pnpm --filter @workspace/scripts run tsconfig:check"],
  ["port-guard", "bash scripts/check-hardcoded-ports.sh"],
  ["bundle-domain-check", "pnpm --filter @workspace/parts-id run check:bundle-domain"],
];

const STANDARD_EXTRA = [
  ["codegen-check", "pnpm --filter @workspace/api-spec run codegen:check"],
  ["spec-check", "pnpm --filter @workspace/api-spec run spec:check"],
  ["env-check", "pnpm --filter @workspace/scripts env:check"],
  ["spec-check-tests", "pnpm --filter @workspace/api-spec test"],
  ["test", "pnpm test"],
];

const HEAVY_EXTRA = [
  ["schema-check", "pnpm --filter @workspace/db run schema:check"],
  ["verify-fts", "pnpm --filter @workspace/db run verify-fts"],
  ["api-server-coverage", "pnpm --filter @workspace/api-server run test:coverage"],
  ["security-audit", "pnpm audit --audit-level=low"],
  ["post-merge-health-test", "bash scripts/test-post-merge.sh"],
];

const TIERS = {
  fast: FAST,
  standard: [...FAST, ...STANDARD_EXTRA],
  heavy: [...FAST, ...STANDARD_EXTRA, ...HEAVY_EXTRA],
};

const tier = process.argv[2];
const steps = TIERS[tier];
if (!steps) {
  console.error(`Usage: run-tier.mjs <fast|standard|heavy> (got: ${tier ?? "nothing"})`);
  process.exit(2);
}

const waitSecs = process.env.SERIAL_LOCK_WAIT_SECS ?? "0";
const underLoad = Number(waitSecs) > 0;
console.log(`[run-tier] tier=${tier} (${steps.length} steps). Queue wait: ${waitSecs}s${underLoad ? " — ran under concurrent load" : " — ran solo"}. Step timers start now (post lock acquisition).`);

const report = [];
let failed = null;

for (const [name, cmd] of steps) {
  console.log(`\n━━━ [run-tier] step: ${name} ━━━`);
  const start = Date.now();
  const res = spawnSync("bash", ["-c", cmd], { stdio: "inherit" });
  const secs = ((Date.now() - start) / 1000).toFixed(1);
  const ok = res.status === 0;
  report.push({ name, secs, ok, skipped: false });
  if (!ok) {
    failed = { name, code: res.status ?? `signal ${res.signal}` };
    break;
  }
}

const ranNames = new Set(report.map((r) => r.name));
console.log(`\n━━━ [run-tier] ${tier} tier report ━━━`);
for (const r of report) {
  console.log(`  ${r.ok ? "PASSED " : "FAILED "} ${r.name}  (${r.secs}s)`);
}
for (const [name] of steps) {
  if (!ranNames.has(name)) console.log(`  SKIPPED ${name}  (fail-fast: not run)`);
}
console.log(`  queue-wait before start: ${waitSecs}s (${underLoad ? "concurrent load" : "solo"})`);

if (failed) {
  console.error(`\n[run-tier] FAILED at step "${failed.name}" (exit ${failed.code}) — tier ${tier} did not pass.`);
  process.exit(1);
}
console.log(`\n[run-tier] tier ${tier} PASSED (${report.length}/${steps.length} steps).`);
