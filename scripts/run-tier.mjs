#!/usr/bin/env node
/**
 * Run one registered validation tier sequentially.
 *
 * Task runs must provide TASK_PLAN_FILE. The only no-plan path is the explicit
 * --allow-no-plan ad-hoc mode, which also makes plan checks no-ops rather than
 * scanning or modifying the ignored archive.
 */
import { spawnSync } from "node:child_process";
import { assertTierLock } from "./lib/tier-lock-check.mjs";
import { assertTierSteps, getTierSteps } from "./validation-steps.mjs";

const args = process.argv.slice(2);
const tier = args.find((arg) => !arg.startsWith("-"));
const allowNoPlan = args.includes("--allow-no-plan");
const lock = assertTierLock({ requestedTier: tier, allowNoPlan });
if (!lock.ok) {
  console.error(`[run-tier] ${lock.error}`);
  process.exit(2);
}

let steps;
try {
  steps = assertTierSteps(lock.tier, getTierSteps(lock.tier));
} catch (error) {
  console.error(`[run-tier] FATAL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const planFlag = allowNoPlan ? " --allow-no-plan" : "";
const declaredTier = `test-${lock.tier}`;
const resolvedSteps = steps.map(([name, command]) => {
  if (name === "plan-gate-check") return [name, `${command} --declared-tier ${declaredTier}${planFlag}`];
  if (name === "plan-gate-fix" || name === "plan-gate-stubs" || name === "regression-guard-fix" || name === "regression-guard") {
    return [name, `${command}${planFlag}`];
  }
  return [name, command];
});

const waitSecs = process.env.SERIAL_LOCK_WAIT_SECS ?? "0";
const underLoad = Number(waitSecs) > 0;
console.log(`[run-tier] tier=${lock.tier} (${resolvedSteps.length} steps). Queue wait: ${waitSecs}s${underLoad ? " — ran under concurrent load" : " — ran solo"}.`);
if (lock.bypassed) console.log("[run-tier] explicit ad-hoc no-plan bypass enabled; task archive is isolated.");

const report = [];
let failed = null;
for (const [name, command] of resolvedSteps) {
  console.log(`\n━━━ [run-tier] step: ${name} ━━━`);
  const start = Date.now();
  const result = spawnSync("bash", ["-c", command], { stdio: "inherit", env: process.env });
  const seconds = ((Date.now() - start) / 1000).toFixed(1);
  const ok = result.status === 0;
  report.push({ name, seconds, ok });
  if (!ok) {
    failed = { name, code: result.status ?? `signal ${result.signal}` };
    break;
  }
}

const ran = new Set(report.map((entry) => entry.name));
console.log(`\n━━━ [run-tier] ${lock.tier} tier report ━━━`);
for (const entry of report) console.log(`  ${entry.ok ? "PASSED " : "FAILED "} ${entry.name}  (${entry.seconds}s)`);
for (const [name] of resolvedSteps) if (!ran.has(name)) console.log(`  SKIPPED ${name}  (fail-fast: not run)`);
console.log(`  queue-wait before start: ${waitSecs}s (${underLoad ? "concurrent load" : "solo"})`);

if (failed) {
  console.error(`\n[run-tier] FAILED at step "${failed.name}" (exit ${failed.code}) — tier ${lock.tier} did not pass.`);
  process.exit(1);
}
console.log(`\n[run-tier] tier ${lock.tier} PASSED (${report.length}/${resolvedSteps.length} steps).`);