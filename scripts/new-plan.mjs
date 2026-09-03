#!/usr/bin/env node
/**
 * Create a Failure-Gate-compliant task plan.
 *
 * Options:
 *   --why <text>                         required reason
 *   --tier <fast|standard|standard-plus|heavy>
 *   --pre-existing <task-local observation>
 *   --environment-observation <text>
 *   --baseline-id <ID>                   ignored catalog record (repeatable)
 *   --owned-baseline-id <ID>             repair-owned catalog record (repeatable)
 *
 * Baseline IDs can also be supplied as ID|suite|test|signature to produce an
 * exact declaration without making the scaffold invent provenance.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { dirname, fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const valueFor = (flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : null;
};
const repeated = (flag) => argv.flatMap((item, index) => item === flag && argv[index + 1] ? [argv[index + 1]] : []);
const slug = argv.find((item, index) => !item.startsWith("-") && (index === 0 || !["--why", "--tier", "--pre-existing", "--environment-observation", "--baseline-id", "--owned-baseline-id"].includes(argv[index - 1]))) ?? null;
const why = valueFor("--why");
const tier = valueFor("--tier") ?? "standard";
const validTiers = new Set(["fast", "standard", "standard-plus", "heavy"]);

if (!slug || !/^[a-zA-Z0-9_-]+$/.test(slug)) {
  console.error("Usage: node scripts/new-plan.mjs <slug> --why \"why this task exists\" [--tier standard]");
  process.exit(1);
}
if (!why || why.trim().length < 3 || /^<.*>$/.test(why.trim())) {
  console.error("[new-plan] ERROR: --why is required and must be a real explanation.");
  process.exit(1);
}
if (!validTiers.has(tier)) {
  console.error(`[new-plan] ERROR: invalid --tier "${tier}". Use fast, standard, standard-plus, or heavy.`);
  process.exit(1);
}

function declaration(flag, ownership) {
  return repeated(flag).map((raw) => {
    const parts = raw.split("|");
    const id = parts[0];
    const suite = parts[1] ?? "<suite>";
    const test = parts[2] ?? "<test>";
    const signature = parts.slice(3).join("|") || "<exact failure signature>";
    return `- **${ownership}:** \`${id}\` — ${suite} › ${test}; match only this signature: ${signature}.`;
  });
}

const ignored = declaration("--baseline-id", "Ignored baseline");
const owned = declaration("--owned-baseline-id", "Owned baseline repair");
const observation = valueFor("--environment-observation");
const preExisting = valueFor("--pre-existing");
const baselineLines = [...ignored, ...owned];
if (preExisting) baselineLines.push(`- Task-local observation (not durable provenance): ${preExisting}`);
if (baselineLines.length === 0) baselineLines.push("None known at plan time. Treat every failure as a potential regression.");
if (observation) baselineLines.push(`\n## Task-local environment observations\n${observation}\n`);

const output = `# <title: replace this line>

## What & Why
${why}

## Steps
1. <step 1>
2. <step 2>

## Pre-existing failures to ignore
${baselineLines.join("\n")}

**Flaky-test rule:** A passing retry establishes intermittency, not pre-existing provenance. Use the execution evidence rules before assigning ownership.

## Validation
**Command:** \`test-${tier}\`
**Why:** ${why}
**Do not escalate:** Run exactly this command. Pre-existing failures are not a reason to run a heavier tier.

## Validation tier
${tier}

## Regression Guard
**Covers:** <describe the regression contract this task protects>
**Test location:** scripts/test/failure-gate-contract.test.mjs
**What it checks:** <describe the deterministic assertions that should fail if this task regresses>
`;

const tasksDir = resolve(".local/tasks");
const outPath = join(tasksDir, `${slug}.md`);
if (existsSync(outPath)) {
  console.error(`[new-plan] ERROR: file already exists: ${outPath}`);
  process.exit(1);
}
mkdirSync(tasksDir, { recursive: true });
writeFileSync(outPath, output, "utf8");
console.log(`[new-plan] Created: ${outPath}`);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const fix = spawnSync(process.execPath, [join(scriptDir, "check-failure-gate.mjs"), "--fix-stub"], {
  cwd: resolve("."),
  env: { ...process.env, TASK_PLAN_FILE: outPath },
  encoding: "utf8",
});
if (fix.stdout) process.stdout.write(fix.stdout);
if (fix.stderr) process.stderr.write(fix.stderr);
if (fix.status !== 0) process.exit(fix.status ?? 1);