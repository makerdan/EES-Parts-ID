#!/usr/bin/env node
/**
 * check-failure-gate.mjs — Failure Gate v2 plan-file lint guard.
 *
 * Scans every *.md file under .local/tasks/ and enforces that each plan
 * contains the two required sections:
 *   1. ## Pre-existing failures to ignore  (any content; stub text is sufficient)
 *   2. ## Validation                        (must contain all three inner lines)
 *
 * Modes:
 *   (default / --strict)
 *       Checks: required sections present, required inner lines present,
 *               valid tier value in **Command:**.
 *       Does NOT flag unfilled placeholder text in **Why:** / **Do not escalate:**
 *       — that is --stubs-only's job.
 *       Exits 1 if any non-compliant files found.
 *
 *       Optional flag: --declared-tier <tier>
 *           When provided, also errors if any plan file's **Command:** tier is
 *           lighter than the declared tier. This enforces the ceiling rule:
 *           an agent must never run a heavier tier than the plan allows.
 *           Accepted values: test-fast, test-standard, test-standard-plus, test-heavy
 *           Example: node scripts/check-failure-gate.mjs --declared-tier test-standard
 *
 *   --fix-stub
 *       Appends missing sections / inserts missing required inner lines.
 *       Cannot fix invalid tier values — those require human intervention.
 *       Always exits 0.
 *
 *   --stubs-only
 *       Skips the required-headings check. Only reports existing ## Validation
 *       sections that have unfilled placeholder text or missing required inner
 *       lines. Exits 0 (warnings only).
 *
 * Usage:
 *   node scripts/check-failure-gate.mjs [--fix-stub | --stubs-only] [--declared-tier <tier>]
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TASKS_DIR = resolve(".local/tasks");
const VALID_TIERS = new Set([
  "test-fast",
  "test-standard",
  "test-standard-plus",
  "test-heavy",
]);

// Ordered lightest → heaviest. Used to detect ceiling violations.
const TIER_ORDER = ["test-fast", "test-standard", "test-standard-plus", "test-heavy"];

const STUB_PREEXISTING = `\n## Pre-existing failures to ignore\nNone known at plan time. Treat every failure as a potential regression.\n\n**Flaky-test rule:** If a test fails, retry it 3× in isolation before concluding\nit is a regression you caused. Only treat a consistent 3/3 failure as your\nresponsibility.\n`;

const STUB_VALIDATION = `\n## Validation\n**Command:** \`test-standard\`\n**Why:** <replace with one-line justification>\n**Do not escalate:** Run exactly this command. Pre-existing failures are\nhandled above — they are never a reason to run a heavier tier.\n`;

// Inner lines that must appear in a ## Validation section.
const REQUIRED_INNER = ["**Command:**", "**Why:**", "**Do not escalate:**"];

// Placeholder text patterns used by --stubs-only mode.
const PLACEHOLDER_PATTERNS = [
  /<replace with one-line justification>/,
  /<exact command to run>/,
  /<one-line justification/,
];

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const MODE =
  args.includes("--fix-stub")
    ? "fix-stub"
    : args.includes("--stubs-only")
    ? "stubs-only"
    : "strict";

// --declared-tier <tier>: when set in strict mode, any plan whose **Command:**
// tier is lighter than this value is flagged as a ceiling violation.
const declaredTierArgIdx = args.indexOf("--declared-tier");
const DECLARED_TIER =
  declaredTierArgIdx >= 0 ? (args[declaredTierArgIdx + 1] ?? null) : null;

if (DECLARED_TIER !== null && !VALID_TIERS.has(DECLARED_TIER)) {
  console.error(
    `[check-failure-gate] --declared-tier value "${DECLARED_TIER}" is not a valid tier. Must be one of: ${TIER_ORDER.join(", ")}`
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function collectMarkdownFiles(dir) {
  let files = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      files = files.concat(collectMarkdownFiles(full));
    } else if (entry.endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Section extraction — split-based to avoid multiline $ pitfall
// ---------------------------------------------------------------------------

/**
 * Split the document into a map of { headingText -> bodyText }.
 * Heading text is the text of the ## line (without the ## prefix).
 * Body text runs until the next ## (or # ) heading or EOF.
 */
function parseSections(content) {
  const sections = new Map();
  // Split on lines starting with ## or #
  const parts = content.split(/(?=^## |^# )/m);
  for (const part of parts) {
    const headingMatch = part.match(/^#{1,2} (.+)/);
    if (!headingMatch) continue;
    const heading = headingMatch[1].trim();
    // Body is everything after the first line
    const body = part.slice(part.indexOf("\n") + 1);
    sections.set(heading, body);
  }
  return sections;
}

function hasPreexistingSection(sections) {
  for (const key of sections.keys()) {
    if (key.startsWith("Pre-existing failures to ignore")) return true;
  }
  return false;
}

function hasValidationSection(sections) {
  for (const key of sections.keys()) {
    if (key === "Validation" || key.startsWith("Validation ")) return true;
  }
  return false;
}

function getValidationBody(sections) {
  for (const [key, body] of sections.entries()) {
    if (key === "Validation" || key.startsWith("Validation ")) return body;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Validation section analysis
// ---------------------------------------------------------------------------

/**
 * Analyse a ## Validation section body.
 * Returns { missingLines, invalidTier, hasPlaceholder }
 */
function analyseValidation(sectionBody) {
  const missingLines = REQUIRED_INNER.filter(
    (line) => !sectionBody.includes(line)
  );

  let invalidTier = false;
  const tierMatch = sectionBody.match(/\*\*Command:\*\*\s*`?([^`\n]+)`?/);
  if (tierMatch) {
    const tier = tierMatch[1].trim();
    if (!VALID_TIERS.has(tier)) {
      invalidTier = true;
    }
  }

  const hasPlaceholder = PLACEHOLDER_PATTERNS.some((re) => re.test(sectionBody));

  return { missingLines, invalidTier, hasPlaceholder };
}

// ---------------------------------------------------------------------------
// Fix-stub helpers
// ---------------------------------------------------------------------------

function ensurePreexistingSection(content) {
  const sections = parseSections(content);
  if (hasPreexistingSection(sections)) return content;
  return content.trimEnd() + "\n" + STUB_PREEXISTING;
}

/**
 * Append or repair the ## Validation section.
 * - If absent: append the full stub.
 * - If present but missing required inner lines: insert them after the heading.
 * Cannot fix invalid tier values or unfilled placeholder text.
 */
function ensureValidationSection(content) {
  const sections = parseSections(content);
  if (!hasValidationSection(sections)) {
    return content.trimEnd() + "\n" + STUB_VALIDATION;
  }

  const sectionBody = getValidationBody(sections) ?? "";
  const { missingLines } = analyseValidation(sectionBody);
  if (missingLines.length === 0) return content;

  const insertLines = [];
  if (missingLines.includes("**Command:**")) {
    insertLines.push("**Command:** `test-standard`");
  }
  if (missingLines.includes("**Why:**")) {
    insertLines.push("**Why:** <replace with one-line justification>");
  }
  if (missingLines.includes("**Do not escalate:**")) {
    insertLines.push(
      "**Do not escalate:** Run exactly this command. Pre-existing failures are\nhandled above — they are never a reason to run a heavier tier."
    );
  }

  // Insert missing lines immediately after the ## Validation heading.
  return content.replace(
    /^(## Validation\b[^\n]*\n)/m,
    `$1${insertLines.join("\n")}\n`
  );
}

// ---------------------------------------------------------------------------
// Per-file analysis
// ---------------------------------------------------------------------------

/**
 * Returns an array of issue strings for a given file path.
 *
 * strict:     missing sections, missing inner lines, invalid tier value.
 *             Does NOT flag unfilled placeholder text — that is stubs-only.
 * stubs-only: only reports existing ## Validation sections with unfilled
 *             placeholder text or missing required inner lines.
 */
function analyseFile(filePath, mode) {
  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return [`[READ ERROR] cannot read file`];
  }

  const sections = parseSections(content);
  const issues = [];

  if (mode === "strict") {
    if (!hasPreexistingSection(sections)) {
      issues.push(`missing ## Pre-existing failures to ignore section`);
    }
    if (!hasValidationSection(sections)) {
      issues.push(`missing ## Validation section`);
      return issues;
    }

    const sectionBody = getValidationBody(sections) ?? "";
    const { missingLines, invalidTier } = analyseValidation(sectionBody);

    for (const line of missingLines) {
      issues.push(`## Validation missing required inner line: ${line}`);
    }
    if (invalidTier) {
      const tierMatch = sectionBody.match(/\*\*Command:\*\*\s*`?([^`\n]+)`?/);
      const found = tierMatch ? tierMatch[1].trim() : "(not found)";
      issues.push(
        `## Validation has invalid tier value "${found}" — must be one of: ${[...VALID_TIERS].join(", ")}`
      );
    }

    // Ceiling check: if --declared-tier was given, the plan's **Command:** must
    // not be lighter than the tier being run. A lighter plan tier means the
    // agent escalated beyond what the plan allows.
    if (DECLARED_TIER && !invalidTier) {
      const tierMatch = sectionBody.match(/\*\*Command:\*\*\s*`?([^`\n]+)`?/);
      const planTier = tierMatch ? tierMatch[1].trim() : null;
      if (planTier && VALID_TIERS.has(planTier)) {
        const planIdx = TIER_ORDER.indexOf(planTier);
        const declaredIdx = TIER_ORDER.indexOf(DECLARED_TIER);
        if (planIdx < declaredIdx) {
          issues.push(
            `ceiling violation: plan declares "${planTier}" but agent is running "${DECLARED_TIER}" (heavier) — never escalate beyond the plan's **Command:** ceiling`
          );
        }
      }
    }

    return issues;
  }

  // stubs-only mode
  if (!hasValidationSection(sections)) return issues; // skip files without the section

  const sectionBody = getValidationBody(sections) ?? "";
  const { missingLines, hasPlaceholder } = analyseValidation(sectionBody);

  for (const line of missingLines) {
    issues.push(`## Validation missing required inner line: ${line}`);
  }
  if (hasPlaceholder) {
    issues.push(
      `## Validation contains unfilled placeholder text — requires human intervention`
    );
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const files = collectMarkdownFiles(TASKS_DIR);

if (files.length === 0) {
  console.log(`[check-failure-gate] No plan files found under ${TASKS_DIR}. Nothing to check.`);
  process.exit(0);
}

let fixedCount = 0;
let warnCount = 0;
const strictFailures = [];

for (const filePath of files) {
  if (MODE === "fix-stub") {
    let content;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      console.warn(`[check-failure-gate] WARN: cannot read ${filePath} — skipping`);
      continue;
    }
    const original = content;
    content = ensurePreexistingSection(content);
    content = ensureValidationSection(content);
    if (content !== original) {
      writeFileSync(filePath, content, "utf8");
      fixedCount++;
    }
    continue;
  }

  const issues = analyseFile(filePath, MODE);
  if (issues.length > 0) {
    if (MODE === "stubs-only") {
      console.warn(`[check-failure-gate] WARN ${filePath}`);
      for (const issue of issues) {
        console.warn(`  • ${issue}`);
      }
      warnCount++;
    } else {
      strictFailures.push({ file: filePath, issues });
    }
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

if (MODE === "fix-stub") {
  if (fixedCount > 0) {
    console.log(
      `[check-failure-gate] --fix-stub: repaired ${fixedCount} file(s). ${files.length - fixedCount} already compliant.`
    );
  } else {
    console.log(
      `[check-failure-gate] --fix-stub: all ${files.length} plan file(s) already compliant. No changes made.`
    );
  }
  process.exit(0);
}

if (MODE === "stubs-only") {
  if (warnCount > 0) {
    console.log(
      `[check-failure-gate] --stubs-only: ${warnCount} file(s) have incomplete ## Validation sections (warnings only).`
    );
  } else {
    console.log(
      `[check-failure-gate] --stubs-only: all ${files.length} plan file(s) with ## Validation sections look compliant.`
    );
  }
  process.exit(0);
}

// strict
if (strictFailures.length > 0) {
  console.error(
    `[check-failure-gate] FAILED: ${strictFailures.length} plan file(s) are non-compliant:\n`
  );
  for (const { file, issues } of strictFailures) {
    console.error(`  ${file}`);
    for (const issue of issues) {
      console.error(`    • ${issue}`);
    }
  }
  console.error(
    `\nRun with --fix-stub to auto-repair missing sections and inner lines. Invalid tier values require human intervention.`
  );
  process.exit(1);
}

console.log(
  `[check-failure-gate] All ${files.length} plan file(s) pass the Failure Gate v2 compliance check.`
);
process.exit(0);
