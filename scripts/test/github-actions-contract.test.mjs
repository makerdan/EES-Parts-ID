#!/usr/bin/env node
/**
 * Deterministic repository contract for the GitHub Actions installation.
 *
 * This deliberately validates the tracked workflow text rather than querying
 * GitHub. Remote activation, required-check settings, and live run evidence
 * belong to the dependent activation task.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTierSteps } from "../validation-steps.mjs";

const root = join(fileURLToPath(new URL("../..", import.meta.url)));
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
  if (!/pull-requests:\s+write/.test(readme) || !/gh pr create/.test(readme)) {
    errors.push("sync-readme.yml: protected-branch maintenance must open a pull request");
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