#!/usr/bin/env node
/**
 * new-task-plan.mjs — Scaffold a new Failure-Gate-compliant plan file.
 *
 * Usage:
 *   node scripts/new-task-plan.mjs <slug>
 *
 * Creates .local/tasks/<slug>.md pre-filled with all required sections so
 * check-failure-gate.mjs --fix-stub immediately reports "already compliant".
 * Then runs that check as a post-write hook to confirm.
 */

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const slug = process.argv[2];

if (!slug) {
  console.error("Usage: node scripts/new-task-plan.mjs <slug>");
  console.error("Example: node scripts/new-task-plan.mjs fix-widget-crash");
  process.exit(1);
}

if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
  console.error(
    `[new-task-plan] ERROR: slug must contain only letters, numbers, hyphens, and underscores. Got: "${slug}"`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

const TEMPLATE = `# <title: replace this line>

## What & Why
<describe the goal and motivation here>

## Steps
1. <step 1>
2. <step 2>

## Pre-existing failures to ignore
None known at plan time. Treat every failure as a potential regression.

**Flaky-test rule:** If a test fails, retry it 3× in isolation before concluding
it is a regression you caused. Only treat a consistent 3/3 failure as your
responsibility.

## Validation
**Command:** \`test-standard\`
**Why:** <replace with one-line justification>
**Do not escalate:** Run exactly this command. Pre-existing failures are
handled above — they are never a reason to run a heavier tier.
`;

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

const tasksDir = resolve(".local/tasks");
const outPath = join(tasksDir, `${slug}.md`);

if (existsSync(outPath)) {
  console.error(`[new-task-plan] ERROR: file already exists: ${outPath}`);
  process.exit(1);
}

if (!existsSync(tasksDir)) {
  mkdirSync(tasksDir, { recursive: true });
}

writeFileSync(outPath, TEMPLATE, "utf8");
console.log(`[new-task-plan] Created: ${outPath}`);

// ---------------------------------------------------------------------------
// Post-write hook: confirm compliance
// ---------------------------------------------------------------------------

const checkScript = resolve(__dirname, "check-failure-gate.mjs");
const result = spawnSync(
  process.execPath,
  [checkScript, "--fix-stub"],
  { encoding: "utf8", cwd: resolve(".") }
);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

if (result.status !== 0) {
  console.error(
    "[new-task-plan] WARNING: check-failure-gate --fix-stub exited non-zero after scaffolding."
  );
  process.exit(result.status ?? 1);
}
