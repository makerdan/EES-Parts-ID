#!/usr/bin/env node
/**
 * Select and run the tier declared by a task plan.
 */
import { spawnSync } from "node:child_process";
import { resolveTaskCompletionSelection } from "./lib/tier-lock-check.mjs";

const [planFile, ...rest] = process.argv.slice(2);
if (!planFile) {
  console.error("Usage: node scripts/run-locked-tier.mjs <.local/tasks/plan.md>");
  process.exit(2);
}
const plan = resolveTaskCompletionSelection(planFile);
if (!plan.ok) {
  console.error(`[run-locked-tier] TIER-LOCK VIOLATION: ${plan.error}`);
  process.exit(2);
}
console.log(`[run-locked-tier] selected exactly one registered command: ${plan.command}`);
const result = spawnSync(process.execPath, ["scripts/run-tier.mjs", plan.tier, ...rest], {
  stdio: "inherit",
  env: { ...process.env, TASK_PLAN_FILE: plan.path },
});
process.exit(result.status ?? 1);