#!/usr/bin/env node
/**
 * Deterministic repository contract for the GitHub Actions installation.
 *
 * This deliberately validates the tracked workflow text rather than querying
 * GitHub. Remote activation, required-check settings, and live run evidence
 * belong to the dependent activation task.
 */
import nodeAssert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { getTierSteps } from "../validation-steps.mjs";
import {
  buildGitHubProtectionSnapshot,
  buildGitHubCapabilityReport,
  buildGitHubSecurityControlReport,
  buildGitHubValidationEvidenceBundle,
  collectGitHubValidationEvidence,
  evaluateGitHubProtectionFreshness,
  inspectOptionalRuntimeSkillMirror,
} from "../lib/github-validation-evidence.mjs";

const root = join(fileURLToPath(new URL("../..", import.meta.url)));
const canonicalSkillDir = join(root, ".agents", "skills", "install-github-actions");
const canonicalSkillPath = join(canonicalSkillDir, "SKILL.md");
const runtimeSkillDir = join(root, ".local", "custom_skills", "install-github-actions");
const workflowDir = join(root, ".github", "workflows");
const actionPath = join(root, ".github", "actions", "setup-node-pnpm", "action.yml");
const coveragePath = join(root, "docs", "validation", "github-actions-coverage.md");
const protectionStatusPath = join(root, "docs", "validation", "github-protection-status.md");
const installationPath = join(root, "docs", "validation", "github-actions-installation.md");
const fastContractChecks = new Map([
  ["api-suite-floor-contract", "node scripts/test/api-suite-floor-contract.test.mjs"],
  ["api-spec-typecheck-contract", "node scripts/test/api-spec-typecheck-contract.test.mjs"],
  ["github-actions-contract", "node scripts/test/github-actions-contract.test.mjs"],
  ["api-route-authorization-contract", "node scripts/test/api-route-authorization-contract.test.mjs"],
  ["ai-provider-startup-export-contract", "node scripts/test/ai-provider-startup-export-contract.test.mjs"],
  ["poe-setup-targeted-correction-contract", "node skill-previews/poe-setup/targeted-correction-contract.test.mjs"],
  ["skill-mirror-sync-contract", "node scripts/test/skill-mirror-sync-contract.test.mjs"],
  ["dependency-security-contract", "node scripts/test/dependency-security-contract.test.mjs"],
  ["patched-dependencies-contract", "node scripts/test/patched-dependencies.test.mjs"],
  ["port-authority-contract", "node scripts/test-port-authority.mjs"],
  ["replit-config-contract", "node scripts/test/replit-config-contract.test.mjs"],
  ["validation-runtime-contract", "node scripts/test/validation-runtime-contract.test.mjs"],
]);
const protectionReportBuilders = new Set([
  "buildGitHubCapabilityReport",
  "buildGitHubSecurityControlReport",
]);
const incompleteProtectionEvidenceMarker = "github-protection-freshness: allow-incomplete";

function read(path) {
  return readFileSync(path, "utf8");
}

function assertRegularFile(path, description) {
  assert(statSync(path).isFile(), `${description} must be a regular file`);
}

function workflow(name) {
  return read(join(workflowDir, name));
}

function trackedWorkflowNames() {
  const prefix = ".github/workflows/";
  const paths = execFileSync("git", ["ls-files", "-z", "--", ".github/workflows"], {
    cwd: root,
    encoding: "utf8",
  }).split("\0").filter(Boolean);
  assert(paths.length > 0, "tracked workflow inventory is empty");
  for (const path of paths) {
    assert(path.startsWith(prefix), `tracked workflow path escaped ${prefix}: ${path}`);
  }
  return paths.map((path) => path.slice(prefix.length));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function protectionReportCallSites(files) {
  const callSites = [];
  for (const [path, source] of Object.entries(files)) {
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const lines = source.split(/\r?\n/);
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const builderName = ts.isIdentifier(node.expression)
          ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : undefined;
        if (protectionReportBuilders.has(builderName)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          const options = node.arguments[1];
          const propertyNames = new Set(
            options && ts.isObjectLiteralExpression(options)
              ? options.properties
                .filter((property) => ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
                .map((property) => property.name.getText(sourceFile).replace(/^['"]|['"]$/g, ""))
              : [],
          );
          callSites.push({
            path,
            line: line + 1,
            builderName,
            hasSnapshot: propertyNames.has("snapshot"),
            hasCurrentContext: propertyNames.has("currentContext"),
            allowIncomplete: lines.slice(Math.max(0, line - 2), line + 1)
              .some((text) => text.includes(incompleteProtectionEvidenceMarker)),
          });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
  return callSites;
}

function validateProtectionReportCallSites(files) {
  return protectionReportCallSites(files).filter(
    (call) => !call.allowIncomplete && (!call.hasSnapshot || !call.hasCurrentContext),
  );
}

function trackedProtectionReportSources() {
  const paths = execFileSync(
    "git",
    ["ls-files", "-z", "--", "*.js", "*.jsx", "*.mjs", "*.cjs", "*.ts", "*.tsx"],
    { cwd: root, encoding: "utf8" },
  ).split("\0").filter(Boolean);
  return Object.fromEntries(
    paths
      // A tracked source file may be intentionally deleted in the working
      // tree while a generated contract is being migrated. Do not make this
      // read-only inventory fail before it can inspect the remaining sources.
      .filter((path) => existsSync(join(root, path)))
      .filter((path) => path !== "scripts/lib/github-validation-evidence.mjs")
      .map((path) => [path, read(join(root, path))]),
  );
}

function validateProtectionReportFreshnessContract() {
  const callSites = protectionReportCallSites(trackedProtectionReportSources());
  nodeAssert.equal(callSites.length, 6, "tracked protection-report builder call-site inventory drifted");
  nodeAssert.deepEqual(
    callSites.filter((call) => call.allowIncomplete).map(({ path, builderName }) => ({ path, builderName })),
    [{
      path: "scripts/test/github-actions-contract.test.mjs",
      builderName: "buildGitHubCapabilityReport",
    }],
    "only the intentional stale-result fixture may omit freshness evidence",
  );
  nodeAssert.deepEqual(
    validateProtectionReportCallSites(trackedProtectionReportSources()),
    [],
    "protection-report builder calls must pass both snapshot and currentContext",
  );

  const unsafe = {
    "future-consumer.mjs": [
      "buildGitHubSecurityControlReport(evidence);",
      "buildGitHubCapabilityReport(evidence, { snapshot });",
      "buildGitHubSecurityControlReport(evidence, { currentContext });",
    ].join("\n"),
  };
  const unsafeCalls = validateProtectionReportCallSites(unsafe);
  nodeAssert.equal(unsafeCalls.length, 3, "negative control must detect every incomplete freshness call");
  nodeAssert.equal(unsafeCalls[0].hasSnapshot, false);
  nodeAssert.equal(unsafeCalls[0].hasCurrentContext, false);
  nodeAssert.equal(unsafeCalls[1].hasSnapshot, true);
  nodeAssert.equal(unsafeCalls[1].hasCurrentContext, false);
  nodeAssert.equal(unsafeCalls[2].hasSnapshot, false);
  nodeAssert.equal(unsafeCalls[2].hasCurrentContext, true);
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
    const hasWritePermission = /^permissions:\s+write-all\s*$/m.test(text)
      || /^\s+[A-Za-z0-9_-]+:\s+write\s*$/m.test(text);
    if (hasWritePermission && name !== "sync-readme.yml") {
      errors.push(`${name}: write permissions are restricted to the README maintenance workflow`);
    }
    if (/^  pull_request_target:/m.test(text)) {
      errors.push(`${name}: untrusted pull-request target trigger is not allowed`);
    }
    if (/^  pull_request:/m.test(text) && hasWritePermission) {
      errors.push(`${name}: pull-request workflows must not grant contents write`);
    }
    for (const block of jobBlocks(text)) {
      const callsReusableWorkflow = /^\s+uses:\s+\.\/\.github\/workflows\//m.test(block.text);
      if (!callsReusableWorkflow && !/^\s+timeout-minutes:\s*[1-9]\d*\s*$/m.test(block.text)) {
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
  const setupAction = read(actionPath);
  assert(/node-version-file:\s*\.node-version/.test(setupAction), "setup-node-pnpm: Node must come from .node-version");
  assert(/same exact runtime contract/.test(setupAction), "setup-node-pnpm: exact runtime contract must be documented");
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
  if (!/^  workflow_call:/m.test(lidar)) {
    errors.push("lidar-measure-tests.yml: native workflow must be reusable by CI");
  }
  if (/^\s{2}(pull_request|merge_group|push|workflow_dispatch):/m.test(lidar)) {
    errors.push("lidar-measure-tests.yml: native workflow must not bypass the CI required aggregator");
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
  const native = ciJobs.find((block) => block.name === "native");
  const required = ciJobs.find((block) => block.name === "required");
  if (!validate) errors.push("ci.yml: missing validate job");
  if (!native) errors.push("ci.yml: missing native job");
  if (!required) errors.push("ci.yml: missing stable required job");
  if (validate && !/uses:\s+\.\.\/?\.github\/actions\/setup-node-pnpm|uses:\s+\.\/\.github\/actions\/setup-node-pnpm/.test(validate.text)) {
    errors.push("ci.yml/validate: does not use the repository setup component");
  }
  if (validate && !/run:\s+pnpm --filter @workspace\/db run push-force/.test(validate.text)) {
    errors.push("ci.yml/validate: missing explicit database schema preparation");
  }
  if (validate) {
    const readinessIndex = validate.text.indexOf("name: Wait for PostgreSQL readiness");
    const trigramIndex = validate.text.indexOf("name: Enable PostgreSQL trigram extension");
    const schemaPreparationIndex = validate.text.indexOf("name: Prepare isolated PostgreSQL schema");
    const trigramCommands = validate.text.match(
      /run:\s+psql "\$DATABASE_URL" --set=ON_ERROR_STOP=1 --command="CREATE EXTENSION IF NOT EXISTS pg_trgm;"/g,
    ) ?? [];

    if (trigramCommands.length !== 1) {
      errors.push("ci.yml/validate: must enable pg_trgm exactly once with fail-closed psql");
    }
    if (
      readinessIndex < 0
      || trigramIndex < 0
      || schemaPreparationIndex < 0
      || readinessIndex > trigramIndex
      || trigramIndex > schemaPreparationIndex
    ) {
      errors.push("ci.yml/validate: pg_trgm initialization must run after readiness and before schema preparation");
    }
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
  if (native && !/name:\s+Native LiDAR validation/.test(native.text)) {
    errors.push("ci.yml/native: stable native validation job name is missing");
  }
  if (native && !/uses:\s+\.\/\.github\/workflows\/lidar-measure-tests\.yml/.test(native.text)) {
    errors.push("ci.yml/native: does not call the reusable native workflow");
  }
  if (required && !/if:\s+always\(\)/.test(required.text)) errors.push("ci.yml/required: aggregator is not unconditional");
  if (required && !/needs:\s+\[validate,\s*native\]/.test(required.text)) errors.push("ci.yml/required: aggregator dependencies are not explicit");
  if (required && !/VALIDATE_RESULT: \$\{\{ needs\.validate\.result \}\}/.test(required.text)) errors.push("ci.yml/required: aggregator does not inspect validate result");
  if (required && !/NATIVE_RESULT: \$\{\{ needs\.native\.result \}\}/.test(required.text)) errors.push("ci.yml/required: aggregator does not inspect native result");
  if (required && !/failure\|cancelled\|skipped\|""/.test(required.text)) errors.push("ci.yml/required: aggregator does not fail closed");
  if (!/retention-days:\s+7/.test(ci)) errors.push("ci.yml: diagnostic retention is not bounded");
  if (!/retention-days:\s+7/.test(lidar) || !/LidarMeasureTests\.xcresult/.test(lidar)) {
    errors.push("lidar-measure-tests.yml: Apple test results are not retained with bounded retention");
  }
  if (!/-workspace\s+ios\/EESPartsID\.xcworkspace/.test(lidar)) {
    errors.push("lidar-measure-tests.yml: xcodebuild does not use the workspace generated from the Expo app name");
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

function evaluateRequiredGateResults({ validate, native }) {
  return [validate, native].every((result) => result === "success") ? "success" : "failure";
}

function validateNativeRequiredGateContract(files) {
  const ci = files["ci.yml"];
  const required = jobBlocks(ci).find((block) => block.name === "required");
  nodeAssert.ok(required, "native required-gate fixtures need the stable required job");
  nodeAssert.match(ci, /^  pull_request:/m, "CI must run native validation for pull requests");
  nodeAssert.match(ci, /^  merge_group:/m, "CI must run native validation for merge groups");
  nodeAssert.match(required.text, /CI \/ required/, "native validation must be represented by the stable required context");

  nodeAssert.equal(
    evaluateRequiredGateResults({ validate: "success", native: "success" }),
    "success",
    "the required gate should pass only when portable and native validation pass",
  );
  for (const native of ["failure", "cancelled", "skipped", "", undefined, "queued"]) {
    nodeAssert.equal(
      evaluateRequiredGateResults({ validate: "success", native }),
      "failure",
      `native result '${native ?? "missing"}' must fail the required gate`,
    );
  }
  nodeAssert.equal(
    evaluateRequiredGateResults({ validate: "failure", native: "success" }),
    "failure",
    "portable failure must still fail the required gate",
  );
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

  const runtimeMirror = inspectOptionalRuntimeSkillMirror(runtimeSkillDir);
  assert(
    runtimeMirror.outcome === "absent" || runtimeMirror.outcome === "valid",
    `runtime mirror is invalid: ${runtimeMirror.reason}`,
  );
}

function validateFastContractRegistration() {
  const steps = getTierSteps("fast");
  const registeredContractNames = steps
    .filter(([name]) => name.endsWith("-contract"))
    .map(([name]) => name)
    .sort();
  nodeAssert.deepEqual(
    registeredContractNames,
    [...fastContractChecks.keys()].sort(),
    "fast validation contract inventory drifted",
  );
  for (const [name, command] of fastContractChecks) {
    const matches = steps.filter(([stepName]) => stepName === name);
    assert(matches.length === 1, `fast validation must register ${name} exactly once (found ${matches.length})`);
    assert(matches[0][1] === command, `fast validation command drifted for ${name}`);
  }
}

function validateCapabilityAndSecurityEvidence() {
  const unavailableEvidence = {
    actions: { statusCode: 403, secret: "secret-value", token: "token-value", password: "password-value" },
    branchProtection: { supported: false },
    rulesets: {},
    selectedActions: { policy: "all" },
    shaPinning: { required: false },
  };
  const capabilityInput = structuredClone(unavailableEvidence);
  const reportContext = {
    repository: "makerdan/EES-Parts-ID",
    revisionSha: "abcdef0123456789abcdef0123456789abcdef01",
    policy: { requiredChecks: ["CI / required"], strict: true },
    permissions: { actions: "read", contents: "read" },
  };
  const reportSnapshot = buildGitHubProtectionSnapshot({
    ...reportContext,
    capabilities: unavailableEvidence,
    controls: {},
  });
  const capabilityReport = buildGitHubCapabilityReport(unavailableEvidence, {
    snapshot: reportSnapshot,
    currentContext: reportContext,
  });
  nodeAssert.equal(capabilityReport.mode, "read-only");
  nodeAssert.equal(capabilityReport.activationAttempted, false);
  nodeAssert.equal(capabilityReport.current, true);
  nodeAssert.equal(capabilityReport.freshness.status, "current");
  nodeAssert.equal(capabilityReport.status, "blocked");
  nodeAssert.equal(capabilityReport.capabilities.actions.status, "blocked");
  nodeAssert.equal(capabilityReport.capabilities.branchProtection.status, "unavailable");
  nodeAssert.equal(capabilityReport.capabilities.rulesets.status, "unknown");
  nodeAssert.equal(capabilityReport.capabilities.selectedActions.status, "unknown");
  nodeAssert.equal(capabilityReport.capabilities.shaPinning.status, "unavailable");
  nodeAssert.deepEqual(unavailableEvidence, capabilityInput, "capability reporting must not mutate evidence");
  nodeAssert.doesNotMatch(JSON.stringify(capabilityReport), /secret-value|token-value|password-value/i);

  const securityEvidence = {
    secretScanning: { enabled: true },
    pushProtection: { status: "available" },
    dependencyGraph: { vulnerabilityAlertsStatusCode: 204 },
    dependabot: { alertsStatusCode: 200 },
  };
  const securityReport = buildGitHubSecurityControlReport(securityEvidence, {
    snapshot: reportSnapshot,
    currentContext: reportContext,
  });
  nodeAssert.equal(securityReport.mode, "read-only");
  nodeAssert.equal(securityReport.mutationAttempted, false);
  nodeAssert.equal(securityReport.current, true);
  nodeAssert.equal(securityReport.freshness.status, "current");
  nodeAssert.equal(securityReport.status, "verified");
  for (const control of Object.values(securityReport.controls)) nodeAssert.equal(control.status, "verified");

  const blockedSecurityReport = buildGitHubSecurityControlReport({
    secretScanning: { statusCode: 403 },
    pushProtection: {},
    dependencyGraph: { vulnerabilityAlertsStatusCode: 404 },
    dependabot: { alertsStatusCode: 403 },
  }, { snapshot: reportSnapshot, currentContext: reportContext });
  nodeAssert.equal(blockedSecurityReport.status, "blocked");
  nodeAssert.equal(blockedSecurityReport.controls.secretScanning.status, "blocked");
  nodeAssert.equal(blockedSecurityReport.controls.pushProtection.status, "unknown");
  nodeAssert.equal(blockedSecurityReport.controls.dependencyGraph.status, "unavailable");
  nodeAssert.equal(blockedSecurityReport.controls.dependabot.status, "blocked");
  nodeAssert.match(blockedSecurityReport.controls.secretScanning.nextAction, /read-only/i);
  // github-protection-freshness: allow-incomplete — this fixture must prove omission stays stale.
  const incompleteCapabilityReport = buildGitHubCapabilityReport(unavailableEvidence);
  nodeAssert.equal(incompleteCapabilityReport.status, "stale");
  nodeAssert.equal(incompleteCapabilityReport.current, false);
  nodeAssert.match(incompleteCapabilityReport.freshness.reasons.join(" "), /evidence context is missing/);
  nodeAssert.equal(incompleteCapabilityReport.capabilities.actions.status, "stale");
  nodeAssert.doesNotMatch(JSON.stringify(incompleteCapabilityReport), /Read-only evidence confirms/i);
  const coverage = read(coveragePath);
  nodeAssert.match(coverage, /^\| github-provider-capability-preflight \|/m);
  nodeAssert.match(coverage, /^\| github-security-controls \|/m);

  const fixtureRoot = mkdtempSync(join(tmpdir(), "github-actions-mirror-"));
  try {
    nodeAssert.deepEqual(inspectOptionalRuntimeSkillMirror(join(fixtureRoot, "absent")), { outcome: "absent" });

    const missing = join(fixtureRoot, "missing");
    mkdirSync(missing);
    writeFileSync(join(missing, "SKILL.md"), "# fixture\n");
    nodeAssert.deepEqual(inspectOptionalRuntimeSkillMirror(missing), {
      outcome: "invalid",
      reason: "missing-or-extra-entry",
    });

    const extra = join(fixtureRoot, "extra");
    mkdirSync(extra);
    writeFileSync(join(extra, "SKILL.md"), "# fixture\n");
    writeFileSync(join(extra, ".fingerprint"), "0123456789abcdef0123456789abcdef\n");
    writeFileSync(join(extra, "unexpected.txt"), "must be rejected\n");
    nodeAssert.deepEqual(inspectOptionalRuntimeSkillMirror(extra), {
      outcome: "invalid",
      reason: "missing-or-extra-entry",
    });

    const malformed = join(fixtureRoot, "malformed");
    mkdirSync(malformed);
    writeFileSync(join(malformed, "SKILL.md"), "# fixture\n");
    writeFileSync(join(malformed, ".fingerprint"), "not-a-fingerprint\n");
    nodeAssert.deepEqual(inspectOptionalRuntimeSkillMirror(malformed), {
      outcome: "invalid",
      reason: "malformed-fingerprint",
    });

    const valid = join(fixtureRoot, "valid");
    mkdirSync(valid);
    writeFileSync(join(valid, "SKILL.md"), "# fixture\n");
    writeFileSync(join(valid, ".fingerprint"), "0123456789abcdef0123456789abcdef\n");
    nodeAssert.deepEqual(inspectOptionalRuntimeSkillMirror(valid), { outcome: "valid" });
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

async function validateRevisionEvidenceAndFreshness() {
  const revision = "ABCDEF0123456789ABCDEF0123456789ABCDEF01".toLowerCase();
  const otherRevision = "0123456789ABCDEF0123456789ABCDEF01234567".toLowerCase();
  const bundle = buildGitHubValidationEvidenceBundle({
    repository: "makerdan/EES-Parts-ID",
    revisionSha: revision,
    collectedAt: "2026-09-10T10:00:00Z",
    policy: { requiredChecks: ["CI / required"], strict: true },
    permissions: { actions: "read", contents: "read" },
    maxFailureDetailChars: 12,
    runs: [
      {
        id: 101,
        workflow_id: 10,
        workflow_name: "CI",
        head_sha: revision,
        event: "push",
        status: "completed",
        conclusion: "failure",
        created_at: "2026-09-10T09:00:00Z",
        run_attempt: 2,
        jobs: [
          {
            id: 1001,
            name: "Portable validation",
            status: "completed",
            conclusion: "failure",
            started_at: "2026-09-10T09:01:00Z",
            completed_at: "2026-09-10T09:02:00Z",
            failureDetail: "long failure detail with secret=do-not-retain",
          },
          {
            id: 1002,
            name: "CI / required",
            status: "completed",
            conclusion: "failure",
            logStatusCode: 403,
          },
        ],
      },
      {
        id: 102,
        workflow_id: 10,
        workflow_name: "CI",
        head_sha: otherRevision,
        conclusion: "success",
        jobs: [],
      },
    ],
  });
  nodeAssert.equal(bundle.exactRevision, true);
  nodeAssert.equal(bundle.revisionSha, revision);
  nodeAssert.equal(bundle.runCount, 1);
  nodeAssert.equal(bundle.excludedRevisionCount, 1);
  nodeAssert.equal(bundle.runs[0].run.attempt, 2);
  nodeAssert.equal(bundle.runs[0].jobs[0].failureEvidence.status, "available");
  nodeAssert.equal(bundle.runs[0].jobs[0].failureEvidence.truncated, true);
  nodeAssert.equal(bundle.runs[0].jobs[0].failureEvidence.detail, "long failure");
  nodeAssert.equal(bundle.runs[0].jobs[1].failureEvidence.status, "withheld");
  nodeAssert.match(bundle.runs[0].jobs[1].failureEvidence.reason, /403/);
  nodeAssert.doesNotMatch(JSON.stringify(bundle), /do-not-retain/);

  const calls = [];
  const collected = await collectGitHubValidationEvidence({
    repository: "makerdan/EES-Parts-ID",
    revisionSha: revision,
    listWorkflowRuns: async (request) => {
      calls.push(["runs", request]);
      return [{ id: 201, head_sha: revision, workflow_name: "CI", run_attempt: 1 }];
    },
    listJobs: async (request) => {
      calls.push(["jobs", request]);
      return [{ id: 2001, name: "Portable validation", conclusion: "failure" }];
    },
    getFailureDetail: async (request) => {
      calls.push(["detail", request]);
      return "line 1\nline 2";
    },
  });
  nodeAssert.equal(collected.runs[0].jobs[0].failureEvidence.detail, "line 1\nline 2");
  nodeAssert.deepEqual(calls.map(([kind]) => kind), ["runs", "jobs", "detail"]);
  nodeAssert.equal(calls[0][1].headSha, revision);
  nodeAssert.equal(calls[0][1].perPage, 100);
  nodeAssert.equal(calls[2][1].maxChars, 2000);
  nodeAssert.doesNotMatch(JSON.stringify(collected), /dispatch|cancel|rerun|workflow_mutation/i);

  const context = {
    repository: "makerdan/EES-Parts-ID",
    revisionSha: revision,
    policy: { requiredChecks: ["CI / required"], strict: true },
    permissions: { actions: "read", contents: "read" },
  };
  const snapshot = buildGitHubProtectionSnapshot({
    ...context,
    capabilities: { actions: "available" },
    controls: { secretScanning: "verified" },
    capturedAt: "2026-09-10T10:00:00Z",
  });
  nodeAssert.deepEqual(evaluateGitHubProtectionFreshness(snapshot, context), {
    status: "current",
    current: true,
    reasons: [],
    repository: context.repository,
    revisionSha: revision,
  });
  const stale = evaluateGitHubProtectionFreshness(snapshot, {
    ...context,
    revisionSha: otherRevision,
    permissions: { actions: "read", contents: "write" },
  });
  nodeAssert.equal(stale.status, "stale");
  nodeAssert.equal(stale.current, false);
  nodeAssert.deepEqual(stale.reasons, ["revisionSha evidence changed", "permissions evidence changed"]);
  const incomplete = evaluateGitHubProtectionFreshness(snapshot, {
    repository: context.repository,
    revisionSha: revision,
    policy: context.policy,
  });
  nodeAssert.equal(incomplete.status, "stale");
  nodeAssert.match(incomplete.reasons.join(" "), /permissions evidence is incomplete/);

  const reportEvidence = {
    actions: { enabled: true },
    branchProtection: { supported: true },
    rulesets: { supported: true },
    selectedActions: { policy: "selected" },
    shaPinning: { required: true },
  };
  const reportControls = {
    secretScanning: { enabled: true },
    pushProtection: { status: "enabled" },
    dependencyGraph: { vulnerabilityAlertsStatusCode: 204 },
    dependabot: { alertsStatusCode: 200 },
  };
  const reportSnapshot = buildGitHubProtectionSnapshot({
    ...context,
    capabilities: reportEvidence,
    controls: reportControls,
  });
  const contextChanges = [
    ["repository", { repository: "another-owner/EES-Parts-ID" }, "repository evidence changed"],
    ["policy", { policy: { requiredChecks: ["other-check"], strict: true } }, "policy evidence changed"],
    ["permissions", { permissions: { actions: "read", contents: "write" } }, "permissions evidence changed"],
    ["revisionSha", { revisionSha: otherRevision }, "revisionSha evidence changed"],
  ];
  for (const [label, change, reason] of contextChanges) {
    const changedContext = { ...context, ...change };
    const capabilityReport = buildGitHubCapabilityReport(reportEvidence, {
      snapshot: reportSnapshot,
      currentContext: changedContext,
    });
    const securityReport = buildGitHubSecurityControlReport(reportControls, {
      snapshot: reportSnapshot,
      currentContext: changedContext,
    });
    for (const report of [capabilityReport, securityReport]) {
      nodeAssert.equal(report.status, "stale", `${label} must stale the report`);
      nodeAssert.equal(report.current, false, `${label} must clear current`);
      nodeAssert.match(report.freshness.reasons.join(" "), new RegExp(reason));
      const items = report.capabilities ?? report.controls;
      for (const item of Object.values(items)) nodeAssert.equal(item.status, "stale", `${label} must clear item status`);
      nodeAssert.doesNotMatch(JSON.stringify(report), /verified|evidence confirms/i);
    }
  }

  nodeAssert.throws(
    () => buildGitHubValidationEvidenceBundle({ repository: "owner/repo", revisionSha: "not-a-sha" }),
    /exact 40-character hexadecimal SHA/,
  );
}

validateSkillContract();
validateFastContractRegistration();
validateProtectionReportFreshnessContract();
validateCapabilityAndSecurityEvidence();
await validateRevisionEvidenceAndFreshness();

const protectionStatus = read(protectionStatusPath);
const installation = read(installationPath);
nodeAssert.match(protectionStatus, /Every protection report must include the freshness result/i);
nodeAssert.match(protectionStatus, /stale[\s\S]*cannot support a current or[\s\S]*verified claim/i);
nodeAssert.match(installation, /report consumers must pass both the snapshot and current read-only context/i);

const workflowNames = trackedWorkflowNames();
const files = Object.fromEntries(workflowNames.map((name) => [name, workflow(name)]));
validateNativeRequiredGateContract(files);
const errors = validateWorkflowContract(files, read(coveragePath));
assert(errors.length === 0, errors.join("\n"));

const unsafe = { ...files, "newly-added-unsafe.yml": unsafeNewWorkflow() };
const unsafeErrors = validateWorkflowContract(unsafe, read(coveragePath));
assert(
  unsafeErrors.some((error) => error.includes("newly-added-unsafe.yml: mutable or malformed action reference")),
  "negative control did not inspect a newly added workflow for mutable actions",
);
assert(
  unsafeErrors.some((error) => error.includes("newly-added-unsafe.yml: untrusted pull-request target trigger")),
  "negative control did not inspect a newly added workflow for unsafe pull-request triggers",
);
assert(
  unsafeErrors.some((error) => error.includes("newly-added-unsafe.yml: write permissions")),
  "negative control did not inspect a newly added workflow for unsafe permissions",
);

console.log(`GitHub Actions contract: ${workflowNames.length} workflows, ${getTierSteps("standard-plus").length} validation surfaces, and immutable action pins verified.`);

function unsafeNewWorkflow() {
  return `name: Newly added unsafe workflow

on:
  pull_request_target:

permissions:
  contents: write

concurrency:
  group: unsafe-new-workflow
  cancel-in-progress: true

jobs:
  unsafe:
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
`;
}
