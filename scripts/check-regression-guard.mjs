#!/usr/bin/env node
/**
 * Regression Guard declaration checker.
 *
 * A guard declaration is intentionally metadata, not an executable test
 * substitute. It records what the task's focused contract test protects.
 * Legacy archive plans remain readable; new/task-scoped declarations are
 * checked strictly when present.
 */
import { lstatSync, readFileSync, realpathSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const TASKS_DIR = resolve(".local/tasks");
const REQUIRED = ["**Covers:**", "**Test location:**", "**What it checks:**"];
const PLACEHOLDER = /<[^>]+>|replace this|describe .* here/i;
const args = process.argv.slice(2);
const mode = args.includes("--fix-stub") ? "fix-stub" : args.includes("--stubs-only") ? "stubs-only" : "strict";
const archive = args.includes("--archive");
const allowNoPlan = args.includes("--allow-no-plan");
const planFile = process.env.TASK_PLAN_FILE || null;

const STUB = `
## Regression Guard
**Covers:** <describe the regression contract this task protects>
**Test location:** scripts/test/failure-gate-contract.test.mjs
**What it checks:** <describe the deterministic assertions that should fail if this task regresses>
`;

function sections(content) {
  const result = new Map();
  for (const part of content.split(/(?=^## |^# )/m)) {
    const heading = part.match(/^#{1,2} (.+)/);
    if (heading) result.set(heading[1].trim(), part.slice(part.indexOf("\n") + 1));
  }
  return result;
}
function guardBody(content) {
  for (const [heading, body] of sections(content)) {
    if (heading === "Regression Guard" || heading.startsWith("Regression Guard ")) return body;
  }
  return null;
}
function collect(dir) {
  let result = [];
  let entries = [];
  try { entries = readdirSync(dir); } catch { return result; }
  for (const entry of entries) {
    const path = join(dir, entry);
    let stats;
    try { stats = lstatSync(path); } catch { continue; }
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) result = result.concat(collect(path));
    else if (entry.endsWith(".md")) result.push(path);
  }
  return result;
}
function targets() {
  if (archive) return collect(TASKS_DIR);
  if (!planFile) return allowNoPlan ? [] : null;
  const path = resolve(planFile);
  const rel = relative(TASKS_DIR, path);
  if (!rel || rel.startsWith("..") || rel.includes("/..") || !path.endsWith(".md")) return null;
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isFile()) return null;
    const realRel = relative(realpathSync(TASKS_DIR), realpathSync(path));
    if (!realRel || realRel.startsWith("..")) return null;
  } catch { return null; }
  return [path];
}
function issuesFor(path) {
  const body = guardBody(readFileSync(path, "utf8"));
  if (!body) return ["missing ## Regression Guard section"];
  return REQUIRED.filter((line) => !body.includes(line) || PLACEHOLDER.test(body))
    .map((line) => line === "**Covers:**" ? "Regression Guard contains missing or placeholder metadata" : `Regression Guard missing ${line}`);
}

const files = targets();
if (files === null) {
  console.error("[check-regression-guard] TIER-LOCK VIOLATION: TASK_PLAN_FILE must point to a readable .md file inside .local/tasks");
  process.exit(2);
}
if (files.length === 0) {
  console.log("[check-regression-guard] explicit ad-hoc no-plan mode: no task archive scanned or modified.");
  process.exit(0);
}

let fixed = 0;
const failures = [];
for (const path of files) {
  const original = readFileSync(path, "utf8");
  if (mode === "fix-stub") {
    if (!guardBody(original)) {
      writeFileSync(path, original.trimEnd() + "\n" + STUB, "utf8");
      fixed++;
    }
    continue;
  }
  const issues = issuesFor(path);
  if (issues.length) {
    if (mode === "stubs-only") {
      console.warn(`[check-regression-guard] WARN ${path}`);
      issues.forEach((issue) => console.warn(`  • ${issue}`));
    } else failures.push({ path, issues });
  }
}
if (mode === "fix-stub") {
  console.log(`[check-regression-guard] --fix-stub: ${fixed ? `repaired ${fixed} file(s)` : "no changes made"}${archive ? " (explicit archive scope)" : " (task-scoped)"}.`);
  process.exit(0);
}
if (mode === "stubs-only") {
  console.log("[check-regression-guard] --stubs-only: warnings only.");
  process.exit(0);
}
if (failures.length) {
  console.error(`[check-regression-guard] FAILED: ${failures.length} declaration(s) are incomplete.`);
  failures.forEach(({ path, issues }) => {
    console.error(`  ${path}`);
    issues.forEach((issue) => console.error(`    • ${issue}`));
  });
  process.exit(1);
}
console.log(`[check-regression-guard] ${files.length} task-scoped declaration(s) pass.`);