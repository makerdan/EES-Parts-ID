#!/usr/bin/env node
/**
 * Failure Gate plan guard.
 *
 * A task run is intentionally single-file. Archive inspection and archive
 * repair require --archive explicitly, so an ordinary validation cannot
 * rewrite the ignored task archive.
 */
import { lstatSync, readFileSync, realpathSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  BASELINE_PATH,
  baselineErrorsForPlan,
  readCatalog,
} from "./lib/failure-baseline.mjs";

const TASKS_DIR = resolve(".local/tasks");
const VALID_TIERS = new Set(["test-fast", "test-standard", "test-standard-plus", "test-heavy"]);
const TIER_ORDER = ["test-fast", "test-standard", "test-standard-plus", "test-heavy"];
const REQUIRED_INNER = ["**Command:**", "**Why:**", "**Do not escalate:**"];
const PLACEHOLDER_PATTERNS = [
  /<replace with one-line justification>/i,
  /<exact command to run>/i,
  /<one-line justification/i,
  /<describe .* here>/i,
];
const STUB_PREEXISTING = `
## Pre-existing failures to ignore
None known at plan time. Treat every failure as a potential regression.

**Flaky-test rule:** A passing retry establishes intermittency, not pre-existing provenance. Use the execution evidence rules before assigning ownership.
`;
const STUB_VALIDATION = `
## Validation
**Command:** \`test-standard\`
**Why:** <replace with one-line justification>
**Do not escalate:** Run exactly this command. Pre-existing failures are not a reason to run a heavier tier.
`;

const args = process.argv.slice(2);
const MODE = args.includes("--fix-stub") ? "fix-stub" : args.includes("--stubs-only") ? "stubs-only" : "strict";
const ARCHIVE = args.includes("--archive");
const ALLOW_NO_PLAN = args.includes("--allow-no-plan");
const declaredIndex = args.indexOf("--declared-tier");
const DECLARED_TIER = declaredIndex >= 0 ? args[declaredIndex + 1] ?? null : null;
const planFromEnv = process.env.TASK_PLAN_FILE || null;

if (DECLARED_TIER && !VALID_TIERS.has(DECLARED_TIER)) {
  console.error(`[check-failure-gate] invalid --declared-tier "${DECLARED_TIER}"`);
  process.exit(2);
}

function parseSections(content) {
  const sections = new Map();
  const parts = content.split(/(?=^## |^# )/m);
  for (const part of parts) {
    const heading = part.match(/^#{1,2} (.+)/);
    if (!heading) continue;
    sections.set(heading[1].trim(), part.slice(part.indexOf("\n") + 1));
  }
  return sections;
}

function validationBody(sections) {
  for (const [heading, body] of sections) {
    if (heading === "Validation" || heading.startsWith("Validation ")) return body;
  }
  return null;
}

function analyseValidation(body) {
  const missingLines = REQUIRED_INNER.filter((line) => !body.includes(line));
  const match = body.match(/\*\*Command:\*\*\s*`?([^`\n]+)`?/);
  const tier = match?.[1]?.trim() ?? null;
  return {
    missingLines,
    invalidTier: !tier || !VALID_TIERS.has(tier),
    tier,
    hasPlaceholder: PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(body)),
  };
}

function validatePlanPath(planFile) {
  if (!planFile) return { ok: false, error: "TASK_PLAN_FILE is not set" };
  const path = resolve(planFile);
  const rel = relative(TASKS_DIR, path);
  if (!rel || rel.startsWith("..") || rel.includes("/..") || !path.endsWith(".md")) {
    return { ok: false, error: `TASK_PLAN_FILE must point to a .md file inside ${TASKS_DIR}` };
  }
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) return { ok: false, error: `plan cannot be a symbolic link: ${path}` };
    if (!stats.isFile()) return { ok: false, error: `plan is not a file: ${path}` };
    const realRel = relative(realpathSync(TASKS_DIR), realpathSync(path));
    if (!realRel || realRel.startsWith("..")) return { ok: false, error: `plan resolves outside ${TASKS_DIR}` };
  } catch {
    return { ok: false, error: `plan cannot be read: ${path}` };
  }
  return { ok: true, path };
}

function collectMarkdownFiles(dir) {
  let files = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    let stats;
    try {
      stats = lstatSync(path);
    } catch {
      continue;
    }
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) files = files.concat(collectMarkdownFiles(path));
    else if (entry.endsWith(".md")) files.push(path);
  }
  return files;
}

function targetFiles() {
  if (ARCHIVE) return { files: collectMarkdownFiles(TASKS_DIR), scoped: false };
  if (planFromEnv) {
    const checked = validatePlanPath(planFromEnv);
    if (!checked.ok) return { error: checked.error };
    return { files: [checked.path], scoped: true };
  }
  if (ALLOW_NO_PLAN) return { files: [], scoped: true, bypassed: true };
  return { error: "TIER-LOCK VIOLATION: TASK_PLAN_FILE is required; use --allow-no-plan only for explicit ad-hoc validation" };
}

function ensurePreexisting(content) {
  const sections = parseSections(content);
  if ([...sections.keys()].some((key) => key.startsWith("Pre-existing failures to ignore"))) return content;
  return content.trimEnd() + "\n" + STUB_PREEXISTING;
}

function ensureValidation(content) {
  const sections = parseSections(content);
  if (!validationBody(sections)) return content.trimEnd() + "\n" + STUB_VALIDATION;
  const body = validationBody(sections);
  const analysis = analyseValidation(body);
  if (analysis.missingLines.length === 0) return content;
  const lines = [];
  if (analysis.missingLines.includes("**Command:**")) lines.push("**Command:** `test-standard`");
  if (analysis.missingLines.includes("**Why:**")) lines.push("**Why:** <replace with one-line justification>");
  if (analysis.missingLines.includes("**Do not escalate:**")) lines.push("**Do not escalate:** Run exactly this command. Pre-existing failures are not a reason to run a heavier tier.");
  return content.replace(/^(## Validation\b[^\n]*\n)/m, `$1${lines.join("\n")}\n`);
}

function analyseFile(filePath, mode) {
  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return ["cannot read file"];
  }
  const sections = parseSections(content);
  const issues = [];
  const hasPreexisting = [...sections.keys()].some((key) => key.startsWith("Pre-existing failures to ignore"));
  const body = validationBody(sections);

  if (mode === "strict") {
    if (!hasPreexisting) issues.push("missing ## Pre-existing failures to ignore section");
    if (!body) return [...issues, "missing ## Validation section"];
    const result = analyseValidation(body);
    for (const line of result.missingLines) issues.push(`## Validation missing required inner line: ${line}`);
    if (result.invalidTier) issues.push(`## Validation has invalid tier value "${result.tier ?? "(not found)"}" — must be one of: ${TIER_ORDER.join(", ")}`);
    if (result.hasPlaceholder) issues.push("## Validation contains unfilled placeholder text — requires human intervention");
    if (DECLARED_TIER && !result.invalidTier && TIER_ORDER.indexOf(result.tier) < TIER_ORDER.indexOf(DECLARED_TIER)) {
      issues.push(`ceiling violation: plan declares "${result.tier}" but agent is running "${DECLARED_TIER}"`);
    }
    const legacyTier = content.match(/^## Validation tier\s*\n\s*(fast|standard|standard-plus|heavy)\s*$/m)?.[1] ?? null;
    if (!legacyTier) issues.push("missing or invalid ## Validation tier section");
    else if (result.tier && result.tier !== `test-${legacyTier}`) {
      issues.push(`tier declarations conflict: ## Validation says "${result.tier}", ## Validation tier says "${legacyTier}"`);
    }
    const catalog = readCatalog(BASELINE_PATH);
    if (!catalog.ok) {
      issues.push(`baseline catalog is invalid: ${catalog.errors.join("; ")}`);
    } else {
      for (const error of baselineErrorsForPlan(content, catalog.catalog).errors) issues.push(`baseline: ${error}`);
    }
    return issues;
  }

  if (!body) return [];
  const result = analyseValidation(body);
  for (const line of result.missingLines) issues.push(`## Validation missing required inner line: ${line}`);
  if (result.hasPlaceholder) issues.push("## Validation contains unfilled placeholder text — requires human intervention");
  return issues;
}

const targets = targetFiles();
if (targets.error) {
  console.error(`[check-failure-gate] ${targets.error}`);
  process.exit(2);
}
if (targets.bypassed) {
  console.log("[check-failure-gate] explicit ad-hoc no-plan mode: no task archive scanned or modified.");
  process.exit(0);
}
const files = targets.files;
if (files.length === 0) {
  console.log(`[check-failure-gate] No plan files found under ${TASKS_DIR}. Nothing to check.`);
  process.exit(0);
}

let fixedCount = 0;
let warnings = 0;
const failures = [];
for (const file of files) {
  if (MODE === "fix-stub") {
    const original = readFileSync(file, "utf8");
    const fixed = ensureValidation(ensurePreexisting(original));
    if (fixed !== original) {
      writeFileSync(file, fixed, "utf8");
      fixedCount++;
    }
    continue;
  }
  const issues = analyseFile(file, MODE);
  if (issues.length === 0) continue;
  if (MODE === "stubs-only") {
    warnings++;
    console.warn(`[check-failure-gate] WARN ${file}`);
    issues.forEach((issue) => console.warn(`  • ${issue}`));
  } else {
    failures.push({ file, issues });
  }
}

if (MODE === "fix-stub") {
  console.log(`[check-failure-gate] --fix-stub: ${fixedCount ? `repaired ${fixedCount} file(s)` : "no changes made"}${targets.scoped ? " (task-scoped)" : " (explicit archive scope)"}.`);
  process.exit(0);
}
if (MODE === "stubs-only") {
  console.log(`[check-failure-gate] --stubs-only: ${warnings} file(s) have incomplete ## Validation sections (warnings only).`);
  process.exit(0);
}
if (failures.length > 0) {
  console.error(`[check-failure-gate] FAILED: ${failures.length} plan file(s) are non-compliant:`);
  for (const failure of failures) {
    console.error(`  ${failure.file}`);
    failure.issues.forEach((issue) => console.error(`    • ${issue}`));
  }
  process.exit(1);
}
console.log(`[check-failure-gate] All ${files.length} task-scoped plan file(s) pass the Failure Gate compliance check.`);