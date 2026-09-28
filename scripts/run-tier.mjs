#!/usr/bin/env node
/**
 * Run one registered validation tier sequentially.
 *
 * Task runs must provide TASK_PLAN_FILE. The only no-plan path is the explicit
 * --allow-no-plan ad-hoc mode, which also makes plan checks no-ops rather than
 * scanning or modifying the ignored archive.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const setupReportDir = resolvedSteps.some(([name]) => name === "test")
  ? mkdtempSync(join(tmpdir(), "validation-tier-setup-"))
  : null;
const setupReportPath = setupReportDir ? join(setupReportDir, "preflight-report") : null;

function readSetupReport(path) {
  if (!path) return null;
  let content;
  try {
    content = readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
  const match =
    /^\[test-all\] PREFLIGHT_REPORT phase="([^"]+)" status=(FAILED|TIMED_OUT) exit-status=(-?\d+) timeout=(true|false) suite-started=(true|false) child-status=(-?\d+)$/.exec(
      content,
    );
  if (!match) return null;
  return {
    phase: match[1],
    status: match[2],
    exitStatus: Number(match[3]),
    timeout: match[4],
    suiteStarted: match[5],
    childStatus: Number(match[6]),
  };
}

const report = [];
let failed = null;
const executionStart = Date.now();
try {
  for (const [name, command] of resolvedSteps) {
    console.log(`\n━━━ [run-tier] step: ${name} ━━━`);
    const start = Date.now();
    const env = name === "test" ? { ...process.env, DATABASE_ENV: "test" } : process.env;
    if (name === "test") env.VALIDATION_SETUP_REPORT_FILE = setupReportPath;
    const result = spawnSync("bash", ["-c", command], { stdio: "inherit", env });
    const seconds = ((Date.now() - start) / 1000).toFixed(1);
    const ok = result.status === 0;
    const setup = name === "test" && !ok ? readSetupReport(setupReportPath) : null;
    report.push({ name, seconds, ok, setup });
    if (!ok) {
      failed = { name, code: result.status ?? `signal ${result.signal}` };
      break;
    }
  }
} finally {
  if (setupReportDir) rmSync(setupReportDir, { recursive: true, force: true });
}

const ran = new Set(report.map((entry) => entry.name));
const executionSecs = ((Date.now() - executionStart) / 1000).toFixed(1);
const executionBudgetMs = Number(process.env.SERIAL_LOCK_BUDGET_MS);
console.log(`\n━━━ [run-tier] ${lock.tier} tier report ━━━`);
for (const entry of report) {
  console.log(`  ${entry.ok ? "PASSED " : "FAILED "} ${entry.name}  (${entry.seconds}s)`);
  if (entry.setup) {
    console.log("  Validation Setup Summary");
    console.log(`    SETUP_${entry.setup.status}  ${entry.setup.phase}`);
    console.log(
      `      exit-status=${entry.setup.exitStatus}  child-status=${entry.setup.childStatus} ` +
      `timeout=${entry.setup.timeout}  suite-started=${entry.setup.suiteStarted}`,
    );
  }
}
for (const [name] of resolvedSteps) if (!ran.has(name)) console.log(`  SKIPPED ${name}  (fail-fast: not run)`);
console.log(`  queue-wait before start: ${waitSecs}s (${underLoad ? "concurrent load" : "solo"})`);
console.log(`  tier execution after lock: ${executionSecs}s`);
if (Number.isSafeInteger(executionBudgetMs) && executionBudgetMs > 0) {
  const headroomSecs = Math.max(0, executionBudgetMs - Number(executionSecs) * 1000) / 1000;
  console.log(
    `  execution budget after lock: ${(executionBudgetMs / 1000).toFixed(1)}s ` +
    `(headroom at report: ${headroomSecs.toFixed(1)}s)`,
  );
}

if (failed) {
  console.error(`\n[run-tier] FAILED at step "${failed.name}" (exit ${failed.code}) — tier ${lock.tier} did not pass.`);
  process.exit(1);
}
console.log(`\n[run-tier] tier ${lock.tier} PASSED (${report.length}/${resolvedSteps.length} steps).`);