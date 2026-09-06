#!/usr/bin/env node
/**
 * Deterministic repository contract for the GitHub Actions installation.
 *
 * This deliberately validates the tracked workflow text rather than querying
 * GitHub. Remote activation, required-check settings, and live run evidence
 * belong to the dependent activation task.
 */
import nodeAssert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTierSteps } from "../validation-steps.mjs";

const root = join(fileURLToPath(new URL("../..", import.meta.url)));
const canonicalSkillDir = join(root, ".agents", "skills", "install-github-actions");
const canonicalSkillPath = join(canonicalSkillDir, "SKILL.md");
const runtimeSkillDir = join(root, ".local", "custom_skills", "install-github-actions");
const runtimeSkillPath = join(runtimeSkillDir, "SKILL.md");
const runtimeFingerprintPath = join(runtimeSkillDir, ".fingerprint");
const workflowDir = join(root, ".github", "workflows");
const actionPath = join(root, ".github", "actions", "setup-node-pnpm", "action.yml");
const coveragePath = join(root, "docs", "validation", "github-actions-coverage.md");

const workflowNames = [
  "ci.yml",
  "lidar-measure-tests.yml",
  "scheduled-audit.yml",
  "sync-readme.yml",
];

function read(path) {
  return readFileSync(path, "utf8");
}

function assertRegularFile(path, description) {
  assert(statSync(path).isFile(), `${description} must be a regular file`);
}

function workflow(name) {
  return read(join(workflowDir, name));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function jobBlocks(text) {
  const jobsStart = text.indexOf("\njobs:");
  assert(jobsStart >= 0, "workflow is missing jobs:");
  const body = text.slice(jobsStart).split("\n").slice(1);
  const blocks = [];
  let current = null;
  for (const line of body) {
    const match = line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (match) {
      current = { name: match[1], text: "" };
      blocks.push(current);
    }
    if (current) current.text += `${line}\n`;
  }
  return blocks;
}

function actionReferences(text) {
  return [...text.matchAll(/^\s+uses:\s+([^\s#]+)\s*$/gm)].map((match) => match[1]);
}

function validateWorkflowContract(files, coverage) {
  const errors = [];
  const ci = files["ci.yml"];
  const lidar = files["lidar-measure-tests.yml"];
  const audit = files["scheduled-audit.yml"];
  const readme = files["sync-readme.yml"];

  for (const [name, text] of Object.entries(files)) {
    if (!/^permissions:\s*$/m.test(text)) errors.push(`${name}: missing top-level permissions`);
    if (!/^concurrency:\s*$/m.test(text)) errors.push(`${name}: missing concurrency`);
    for (const block of jobBlocks(text)) {
      if (!/^\s+timeout-minutes:\s*[1-9]\d*\s*$/m.test(block.text)) {
        errors.push(`${name}/${block.name}: missing finite timeout-minutes`);
      }
    }
    for (const reference of actionReferences(text)) {
      if (reference.startsWith("./")) continue;
      if (!/@[0-9a-f]{40}$/.test(reference)) {
        errors.push(`${name}: mutable or malformed action reference ${reference}`);
      }
    }
  }

  const setupReferences = actionReferences(read(actionPath));
  for (const reference of setupReferences) {
    if (!/@[0-9a-f]{40}$/.test(reference)) {
      errors.push(`setup-node-pnpm: mutable or malformed action reference ${reference}`);
    }
  }
  if (setupReferences.some((reference) => reference.startsWith("actions/checkout@"))) {
    errors.push("setup-node-pnpm: local composite action cannot perform the initial checkout");
  }

  for (const [name, text] of Object.entries({ "ci.yml": ci, "lidar-measure-tests.yml": lidar, "scheduled-audit.yml": audit })) {
    const checkoutIndex = text.indexOf("uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683");
    const setupIndex = text.indexOf("uses: ./.github/actions/setup-node-pnpm");
    if (checkoutIndex < 0 || setupIndex < 0 || checkoutIndex > setupIndex) {
      errors.push(`${name}: pinned checkout must run before the local setup action`);
    }
  }

  for (const event of ["pull_request:", "merge_group:", "push:", "workflow_dispatch:"]) {
    if (!new RegExp(`^  ${event.replace(":", "\\:")}`, "m").test(ci)) {
      errors.push(`ci.yml: missing ${event.replace(":", "")} event`);
    }
  }
  if (!/^    branches:\s*\[main\]\s*$/m.test(ci)) errors.push("ci.yml: push is not limited to main");
  if (!/^  pull_request:/m.test(lidar) || !/^  merge_group:/m.test(lidar) || !/^  push:/m.test(lidar) || !/^  workflow_dispatch:/m.test(lidar)) {
    errors.push("lidar-measure-tests.yml: missing one or more revision/manual events");
  }
  if (/pull_request:/.test(audit) || /pull_request:/.test(readme)) {
    errors.push("maintenance workflows must not execute untrusted pull-request code");
  }
  if (!/^  schedule:/m.test(audit) || !/^  workflow_dispatch:/m.test(audit)) errors.push("scheduled-audit.yml: missing schedule/manual events");
  if (!/^  schedule:/m.test(readme) || !/^  workflow_dispatch:/m.test(readme)) errors.push("sync-readme.yml: missing schedule/manual events");
  if (!/branch="automation\/sync-readme"/.test(readme) || !/compare\/main\.\.\.\$\{branch\}\?expand=1/.test(readme)) {
    errors.push("sync-readme.yml: protected-branch maintenance must publish a reviewable automation branch");
  }
  if (/git push origin "HEAD:\$\{GITHUB_REF_NAME\}"/.test(readme)) {
    errors.push("sync-readme.yml: must not push maintenance changes directly to the protected default branch");
  }

  if (!/^permissions:\n\s+contents:\s+read\s*$/m.test(ci)) errors.push("ci.yml: must default to read-only contents");
  if (/contents:\s+write/.test(ci) || /contents:\s+write/.test(lidar) || /contents:\s+write/.test(audit)) {
    errors.push("validation workflows must not grant contents write");
  }
  if (/(^|\n)\s*(secrets|environment|production|DEPLOY|PUBLISH)/i.test(`${ci}\n${lidar}`)) {
    errors.push("pull-request validation contains a production/write credential boundary");
  }

  const ciJobs = jobBlocks(ci);
  const validate = ciJobs.find((block) => block.name === "validate");
  const required = ciJobs.find((block) => block.name === "required");
  if (!validate) errors.push("ci.yml: missing validate job");
  if (!required) errors.push("ci.yml: missing stable required job");
  if (validate && !/uses:\s+\.\.\/?\.github\/actions\/setup-node-pnpm|uses:\s+\.\/\.github\/actions\/setup-node-pnpm/.test(validate.text)) {
    errors.push("ci.yml/validate: does not use the repository setup component");
  }
  if (validate && !/run:\s+pnpm --filter @workspace\/db run push-force/.test(validate.text)) {
    errors.push("ci.yml/validate: missing explicit database schema preparation");
  }
  if (validate && !/run:\s+pnpm run test-standard-plus/.test(validate.text)) {
    errors.push("ci.yml/validate: canonical validation tier is not run exactly once");
  }
  if (validate && !/artifacts\/api-server\/coverage/.test(validate.text)) {
    errors.push("ci.yml/validate: coverage diagnostics are not retained");
  }
  if (validate && !/^\s+image:\s+postgres:\d+\.\d+\s*$/m.test(validate.text)) {
    errors.push("ci.yml/validate: PostgreSQL service is not pinned to a major and minor version");
  }
  if (required && !/if:\s+always\(\)/.test(required.text)) errors.push("ci.yml/required: aggregator is not unconditional");
  if (required && !/needs:\s+\[validate\]/.test(required.text)) errors.push("ci.yml/required: aggregator dependency is not explicit");
  if (required && !/VALIDATE_RESULT: \$\{\{ needs\.validate\.result \}\}/.test(required.text)) errors.push("ci.yml/required: aggregator does not inspect validate result");
  if (required && !/failure\|cancelled\|skipped\|""/.test(required.text)) errors.push("ci.yml/required: aggregator does not fail closed");
  if (!/retention-days:\s+7/.test(ci)) errors.push("ci.yml: diagnostic retention is not bounded");
  if (!/retention-days:\s+7/.test(lidar) || !/LidarMeasureTests\.xcresult/.test(lidar)) {
    errors.push("lidar-measure-tests.yml: Apple test results are not retained with bounded retention");
  }

  const coverageRows = [...coverage.matchAll(/^\|\s*`?([^|`]+?)`?\s*\|/gm)].map((match) => match[1].trim());
  const expected = [...new Set(getTierSteps("standard-plus").map(([name]) => name))];
  for (const name of expected) {
    const occurrences = coverageRows.filter((row) => row === name).length;
    if (occurrences !== 1) errors.push(`coverage: ${name} must have exactly one matrix row (found ${occurrences})`);
  }
  if (!/intentional gap|local-only|duplicate|not applicable/i.test(coverage)) {
    errors.push("coverage: table must document non-remote classifications");
  }
  if (!/pnpm run test-standard-plus/.test(coverage)) errors.push("coverage: portable owner command is undocumented");

  return errors;
}

function validateSkillContract() {
  nodeAssert.deepEqual(
    readdirSync(canonicalSkillDir).sort(),
    ["SKILL.md"],
    "canonical GitHub Actions package must contain only SKILL.md",
  );
  assertRegularFile(canonicalSkillPath, "canonical skill");

  const skill = read(canonicalSkillPath);
  const metadataEnd = skill.indexOf("\n---\n", 4);
  assert(metadataEnd > 0, "canonical skill is missing YAML frontmatter");
  const metadata = skill.slice(0, metadataEnd);
  nodeAssert.match(metadata, /^name:\s+Install GitHub Actions\s*$/m, "canonical skill metadata has the wrong name");
  nodeAssert.match(metadata, /^description:\s+>-\s*$/m, "canonical skill metadata is missing a folded description");
  nodeAssert.match(metadata, /^  \S.+$/m, "canonical skill metadata is missing its description text");
  nodeAssert.match(skill, /^# Install GitHub Actions\s*$/m, "canonical skill is missing its top-level heading");

  const visibilityGate = "## 0. Repository visibility gate — read-only and mandatory";
  const packageInventory = "### Selected package inventory";
  const inventoryHeading = "## 0. Inventory before proposing edits";
  const visibilityIndex = skill.indexOf(visibilityGate);
  const packageIndex = skill.indexOf(packageInventory);
  const inventoryIndex = skill.indexOf(inventoryHeading);
  assert(visibilityIndex >= 0, "canonical skill is missing the mandatory visibility gate");
  assert(packageIndex > visibilityIndex, "package inventory must follow the visibility gate");
  assert(inventoryIndex > packageIndex, "read-only inventory must follow the package inventory");
  const gate = skill.slice(visibilityIndex, packageIndex);
  nodeAssert.match(gate, /read-only and mandatory/i, "visibility gate must be explicitly read-only and mandatory");
  nodeAssert.match(gate, /cannot be inspected[\s\S]*unknown[\s\S]*stop/i, "visibility gate must stop when evidence is unavailable");
  nodeAssert.match(gate, /never[\s\S]*change repository visibility/i, "visibility gate must forbid visibility mutation");

  const requiredSections = [
    "## 0. Repository visibility gate — read-only and mandatory",
    "## 0. Inventory before proposing edits",
    "## 1. Establish the portable workflow contract",
    "## 2. Choose the setup path",
    "## 3. Security contract for pull requests",
    "## 4. Make jobs fail closed (fail-closed required checks)",
    "## 5. Runner reproducibility",
    "## 6. Human-facing setup and approval boundary",
    "## 7. Troubleshoot without weakening the contract",
    "## Three-pass quality gate",
    "## Completion report",
  ];
  for (const heading of requiredSections) {
    nodeAssert.match(skill, new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m"), `canonical skill is missing ${heading}`);
  }
  nodeAssert.match(skill, /contains only this `SKILL\.md`/i, "canonical skill must document the selected package inventory");
  nodeAssert.match(
    skill,
    /runtime mirror, when present, is platform-managed and is not a source file/i,
    "canonical skill must define the runtime mirror boundary",
  );

  const completionHeadings = [
    "# GitHub Actions installation",
    "## Scope and evidence",
    "## Changed files",
    "## Local-to-remote coverage",
    "## Event scopes and security",
    "## Exclusions, gaps, and duplicate decisions",
    "## Validation results",
    "## Remaining manual GitHub settings",
    "## Rollback and follow-up actions",
  ];
  const completionIndex = skill.indexOf("## Completion report");
  for (const heading of completionHeadings) {
    const headingIndex = skill.indexOf(`\n${heading}\n`, completionIndex);
    assert(headingIndex > completionIndex, `completion report is missing ${heading}`);
  }

  if (statSync(runtimeSkillDir, { throwIfNoEntry: false })) {
    assertRegularFile(runtimeSkillPath, "runtime mirror skill");
    assertRegularFile(runtimeFingerprintPath, "runtime mirror fingerprint");
    nodeAssert.deepEqual(
      readdirSync(runtimeSkillDir).sort(),
      [".fingerprint", "SKILL.md"],
      "runtime mirror must contain only the supported skill and fingerprint files",
    );
    nodeAssert.match(read(runtimeFingerprintPath).trim(), /^[0-9a-f]{32}$/i, "runtime mirror fingerprint must be a non-empty opaque hex value");
  }
}

validateSkillContract();

const files = Object.fromEntries(workflowNames.map((name) => [name, workflow(name)]));
const errors = validateWorkflowContract(files, read(coveragePath));
assert(errors.length === 0, errors.join("\n"));

const unsafe = { ...files, "ci.yml": ciWithUnsafeAction(files["ci.yml"]) };
const unsafeErrors = validateWorkflowContract(unsafe, read(coveragePath));
assert(unsafeErrors.some((error) => error.includes("mutable or malformed action reference")), "negative control did not reject a mutable action");

console.log(`GitHub Actions contract: ${workflowNames.length} workflows, ${getTierSteps("standard-plus").length} validation surfaces, and immutable action pins verified.`);

function ciWithUnsafeAction(text) {
  return text.replace("./.github/actions/setup-node-pnpm", "actions/checkout@v4");
}