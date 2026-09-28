#!/usr/bin/env node
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  assertTierLock,
  parsePlanTier,
  resolveTaskCompletionSelection,
  selectExplicitValidation,
  validateTaskCompletionEvidence,
} from "../lib/tier-lock-check.mjs";
import { baselineErrorsForPlan, validateCatalog } from "../lib/failure-baseline.mjs";
import { DISTRIBUTION_FILES, sync as syncDistribution, verify as verifyDistribution } from "../publish-failure-gate.mjs";
import { getTierSteps } from "../validation-steps.mjs";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}
function run(script, args = [], env = {}) {
  const childEnv = { ...process.env, ...env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
  }
  return spawnSync(process.execPath, [script, ...args], {
    cwd: resolve("."),
    env: childEnv,
    encoding: "utf8",
  });
}
const BASELINE_FINDING_KINDS = new Set(["expired", "review-due", "stale-evidence"]);
const BASELINE_RECORD_FIELDS = [
  "authority",
  "evidenceDate",
  "id",
  "owner",
  "reviewDeadline",
  "signature",
  "status",
  "suite",
  "test",
];
function assertBaselineFindingContract(finding) {
  assert.ok(finding && typeof finding === "object" && !Array.isArray(finding));
  assert.deepEqual(Object.keys(finding).sort(), ["kind", "message", "record"]);
  assert.ok(BASELINE_FINDING_KINDS.has(finding.kind));
  assert.equal(typeof finding.message, "string");
  assert.ok(finding.message.trim().length > 0);
  assert.ok(finding.record && typeof finding.record === "object" && !Array.isArray(finding.record));
  for (const field of BASELINE_RECORD_FIELDS) {
    assert.equal(typeof finding.record[field], "string", `finding.record.${field} must be a string`);
    assert.ok(finding.record[field].trim().length > 0, `finding.record.${field} must be non-empty`);
  }
  for (const field of ["evidenceDate", "reviewDeadline"]) {
    assert.match(finding.record[field], /^\d{4}-\d{2}-\d{2}$/, `finding.record.${field} must be a date`);
  }
  if (finding.record.verificationDate !== undefined) {
    assert.match(finding.record.verificationDate, /^\d{4}-\d{2}-\d{2}$/, "finding.record.verificationDate must be a date");
  }
}
function assertBaselineReportContract(report) {
  assert.deepEqual(Object.keys(report).sort(), ["catalog", "findings", "generated", "thresholds"]);
  assert.equal(typeof report.catalog, "string");
  assert.match(report.generated, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(Object.keys(report.thresholds).sort(), ["maxEvidenceDays", "warningDays"]);
  assert.ok(Number.isInteger(report.thresholds.warningDays));
  assert.ok(report.thresholds.warningDays >= 0);
  assert.ok(Number.isInteger(report.thresholds.maxEvidenceDays));
  assert.ok(report.thresholds.maxEvidenceDays >= 0);
  assert.ok(Array.isArray(report.findings));
  report.findings.forEach(assertBaselineFindingContract);
}
function assertConfigurationErrorContract(error) {
  assert.deepEqual(Object.keys(error).sort(), ["code", "error", "errors", "message"]);
  assert.equal(error.error, "invalid_configuration");
  assert.equal(error.code, "INVALID_CONFIGURATION");
  assert.equal(typeof error.message, "string");
  assert.ok(Array.isArray(error.errors));
  assert.ok(error.errors.length > 0);
  assert.ok(error.errors.every((entry) => typeof entry === "string"));
}

const temp = mkdtempSync(join(tmpdir(), "failure-gate-contract-"));
const taskDir = resolve(".local/tasks");
mkdirSync(taskDir, { recursive: true });
const nonce = `${process.pid}-${Date.now()}`;
const planPath = join(taskDir, `failure-gate-contract-${nonce}.md`);
const siblingPath = join(taskDir, `failure-gate-contract-sibling-${nonce}.md`);
const stubPath = join(taskDir, `failure-gate-contract-stub-${nonce}.md`);
const stubsOnlyPath = join(taskDir, `failure-gate-contract-stubs-only-${nonce}.md`);
const scaffoldSlug = `failure-gate-contract-scaffold-${nonce}`;
const scaffoldPath = join(taskDir, `${scaffoldSlug}.md`);
const catalogPath = join(temp, "catalog.json");
const record = {
  id: "BASE-CONTRACT-1",
  suite: "contract-suite",
  test: "exact test",
  signature: "expected signature",
  status: "active",
  authority: "authoritative",
  evidenceDate: "2026-08-01",
  owner: "validation-maintainers",
  reviewDeadline: "2099-12-31",
};
const catalog = { version: 1, records: [record] };
writeFileSync(catalogPath, JSON.stringify(catalog));

function dateOffset(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function plan(declaration = "- **Ignored baseline:** `BASE-CONTRACT-1` — contract-suite › exact test; match only this signature: expected signature.") {
  return `# Contract

## Pre-existing failures to ignore
${declaration}

## Validation
**Command:** \`test-standard\`
**Why:** Contract coverage requires the standard tier.
**Do not escalate:** Run exactly this command.

## Validation tier
standard

## Regression Guard
**Covers:** Failure Gate contract behavior.
**Test location:** scripts/test/failure-gate-contract.test.mjs
**What it checks:** Exact baseline and tier-lock decisions.
`;
}
function planWithoutBaseline() {
  return plan("None known at plan time. Treat every failure as a potential regression.");
}
function planForTier(tier) {
  return planWithoutBaseline()
    .replace("`test-standard`", `\`test-${tier}\``)
    .replace("## Validation tier\nstandard", `## Validation tier\n${tier}`);
}

try {
  test("catalog accepts authoritative lifecycle records", () => assert.deepEqual(validateCatalog(catalog), []));
  test("catalog rejects impossible calendar dates", () => {
    assert.match(validateCatalog({ version: 1, records: [{ ...record, evidenceDate: "2026-02-30" }] }).join("\n"), /YYYY-MM-DD/);
  });
  test("exact ignored baseline matches", () => assert.deepEqual(baselineErrorsForPlan(plan(), catalog, "2026-08-31").errors, []));
  test("owned repair is a distinct valid ownership", () => {
    const content = plan("- **Owned baseline repair:** `BASE-CONTRACT-1` — contract-suite › exact test; match only this signature: expected signature.");
    assert.deepEqual(baselineErrorsForPlan(content, catalog, "2026-08-31").errors, []);
  });
  test("signature mismatch fails closed", () => {
    assert.match(baselineErrorsForPlan(plan().replace("expected signature.", "different signature."), catalog).errors.join("\n"), /exactly match/);
  });
  test("expired active record fails closed", () => {
    const expired = { version: 1, records: [{ ...record, reviewDeadline: "2026-08-01" }] };
    assert.match(baselineErrorsForPlan(plan(), expired, "2026-08-31").errors.join("\n"), /expired/);
  });
  test("non-active records cannot authorize an ignore", () => {
    const review = { version: 1, records: [{ ...record, status: "needs-review" }] };
    assert.match(baselineErrorsForPlan(plan(), review).errors.join("\n"), /not referenceable/);
  });
  test("missing ownership fails closed", () => {
    const content = plan("- **Baseline:** `BASE-CONTRACT-1` — contract-suite › exact test; expected signature.");
    assert.match(baselineErrorsForPlan(content, catalog).errors.join("\n"), /without a valid/);
  });

  writeFileSync(planPath, planWithoutBaseline());
  writeFileSync(siblingPath, "# untouched sibling\n");
  const env = { TASK_PLAN_FILE: planPath };
  test("task-scoped Failure Gate accepts a valid plan", () => assert.equal(run("scripts/check-failure-gate.mjs", [], env).status, 0));
  test("task-scoped Regression Guard accepts a valid declaration", () => assert.equal(run("scripts/check-regression-guard.mjs", [], env).status, 0));
  test("fix-stub never mutates sibling archive plans", () => {
    const before = readFileSync(siblingPath, "utf8");
    assert.equal(run("scripts/check-failure-gate.mjs", ["--fix-stub"], env).status, 0);
    assert.equal(readFileSync(siblingPath, "utf8"), before);
  });
  test("fix-stub repairs only the task-scoped plan structure", () => {
    writeFileSync(stubPath, "# Incomplete plan\n");
    const stubEnv = { TASK_PLAN_FILE: stubPath };
    assert.equal(run("scripts/check-failure-gate.mjs", ["--fix-stub"], stubEnv).status, 0);
    const repaired = readFileSync(stubPath, "utf8");
    assert.match(repaired, /## Pre-existing failures to ignore/);
    assert.match(repaired, /## Validation/);
    assert.match(repaired, /\*\*Command:\*\* `test-standard`/);
  });
  test("stubs-only reports incomplete existing validation without rewriting it", () => {
    const content = "# Existing plan\n\n## Validation\n**Command:** `test-standard`\n";
    writeFileSync(stubsOnlyPath, content);
    const before = readFileSync(stubsOnlyPath, "utf8");
    const stubsOnlyEnv = { TASK_PLAN_FILE: stubsOnlyPath };
    assert.equal(run("scripts/check-failure-gate.mjs", ["--stubs-only"], stubsOnlyEnv).status, 0);
    assert.equal(readFileSync(stubsOnlyPath, "utf8"), before);
  });
  test("required sections reject aliases and single-level headings", () => {
    const malformed = planWithoutBaseline()
      .replace("## Validation\n", "## Validation notes\n")
      .replace("## Regression Guard\n", "# Regression Guard\n")
      .replace("## Validation tier\n", "## Validation tier notes\n");
    writeFileSync(planPath, malformed);
    assert.equal(run("scripts/check-failure-gate.mjs", [], env).status, 1);
    assert.equal(run("scripts/check-regression-guard.mjs", [], env).status, 1);
    assert.equal(spawnSync("bash", ["scripts/check-plan-tier.sh", planPath], { cwd: resolve("."), encoding: "utf8" }).status, 1);
    writeFileSync(planPath, planWithoutBaseline());
  });
  test("Failure Gate rejects common placeholders", () => {
    for (const placeholder of ["TBD", "TODO", "FILL IN", "<FILL IN>"]) {
      const content = planWithoutBaseline().replace("Contract coverage requires the standard tier.", placeholder);
      writeFileSync(planPath, content);
      assert.equal(run("scripts/check-failure-gate.mjs", [], env).status, 1, placeholder);
    }
    writeFileSync(planPath, planWithoutBaseline());
  });
  test("Regression Guard rejects common placeholders", () => {
    for (const placeholder of ["TBD", "TODO", "FILL IN", "<FILL IN>"]) {
      const content = planWithoutBaseline().replace("Failure Gate contract behavior.", placeholder);
      writeFileSync(planPath, content);
      assert.equal(run("scripts/check-regression-guard.mjs", [], env).status, 1, placeholder);
    }
    writeFileSync(planPath, planWithoutBaseline());
  });
  test("Regression Guard accepts a complete N/A declaration", () => {
    const content = planWithoutBaseline().replace(
      /\n## Regression Guard[\s\S]*$/,
      "\n## Regression Guard\n**N/A**\n**Why N/A:** This task only changes validation guard contracts and has no separate runtime regression surface.\n",
    );
    writeFileSync(planPath, content);
    assert.equal(run("scripts/check-regression-guard.mjs", [], env).status, 0);
    writeFileSync(planPath, planWithoutBaseline());
  });
  test("Regression Guard rejects incomplete or placeholder N/A declarations", () => {
    for (const declaration of [
      "**N/A**\n",
      "**Why N/A:** This reason is incomplete without the marker.\n",
      "**N/A**\n**Why N/A:** TBD\n",
    ]) {
      const content = planWithoutBaseline().replace(/\n## Regression Guard[\s\S]*$/, `\n## Regression Guard\n${declaration}`);
      writeFileSync(planPath, content);
      assert.equal(run("scripts/check-regression-guard.mjs", [], env).status, 1, declaration);
    }
    writeFileSync(planPath, planWithoutBaseline());
  });
  test("Failure Gate repair preserves a legacy tier when exact Validation is absent", () => {
    const content = "# Existing plan\n\n## Validation tier\nstandard\n";
    writeFileSync(planPath, content);
    assert.equal(run("scripts/check-failure-gate.mjs", ["--fix-stub"], env).status, 0);
    const repaired = readFileSync(planPath, "utf8");
    assert.match(repaired, /^## Validation\n/m);
    assert.match(repaired, /^## Validation tier\nstandard$/m);
    assert.doesNotMatch(repaired, /^## Validation tier\n\*\*Command:/m);
    writeFileSync(planPath, planWithoutBaseline());
  });
  test("new-plan scaffold creates the required task sections", () => {
    const result = run("scripts/new-plan.mjs", [
      scaffoldSlug,
      "--why",
      "Verify the Failure Gate scaffold contract.",
      "--tier",
      "fast",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const scaffold = readFileSync(scaffoldPath, "utf8");
    assert.match(scaffold, /## Pre-existing failures to ignore/);
    assert.match(scaffold, /\*\*Command:\*\* `test-fast`/);
    assert.match(scaffold, /## Validation tier\nfast/);
    assert.match(scaffold, /## Regression Guard/);
  });
  test("invalid task plan paths are rejected", () => {
    assert.equal(run("scripts/check-failure-gate.mjs", [], { TASK_PLAN_FILE: join(temp, "outside.md") }).status, 2);
  });
  test("normal runs cannot replace the tracked catalog through environment variables", () => {
    writeFileSync(planPath, plan());
    const result = run("scripts/check-failure-gate.mjs", [], {
      TASK_PLAN_FILE: planPath,
      NODE_ENV: "test",
      FAILURE_GATE_TEST_BASELINE_FILE: catalogPath,
      FAILURE_BASELINE_FILE: catalogPath,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown baseline ID/);
    writeFileSync(planPath, planWithoutBaseline());
  });
  test("malformed unknown baseline declarations fail closed", () => {
    writeFileSync(planPath, plan("- **Ignored baseline:** `BASE-UNKNOWN` — malformed declaration"));
    const result = run("scripts/check-failure-gate.mjs", [], env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /without a valid/);
    writeFileSync(planPath, planWithoutBaseline());
  });
  test("missing Regression Guard fails strict mode", () => {
    writeFileSync(planPath, planWithoutBaseline().replace(/\n## Regression Guard[\s\S]*$/, "\n"));
    assert.equal(run("scripts/check-regression-guard.mjs", [], env).status, 1);
    writeFileSync(planPath, planWithoutBaseline());
  });
  test("explicit self-satisfying Regression Guard is accepted", () => {
    const content = planWithoutBaseline().replace(
      /\n## Regression Guard[\s\S]*$/,
      "\n## Regression Guard\n**Self-satisfying** — this task is the integration verification and focused contract coverage.\n",
    );
    writeFileSync(planPath, content);
    assert.equal(run("scripts/check-regression-guard.mjs", [], env).status, 0);
    writeFileSync(planPath, planWithoutBaseline());
  });
  test("self-satisfying Regression Guard still rejects placeholder text", () => {
    const content = planWithoutBaseline().replace(
      /\n## Regression Guard[\s\S]*$/,
      "\n## Regression Guard\n**Self-satisfying** — <describe the regression contract here>\n",
    );
    writeFileSync(planPath, content);
    assert.equal(run("scripts/check-regression-guard.mjs", [], env).status, 1);
    writeFileSync(planPath, planWithoutBaseline());
  });
  test("no-plan tier use fails unless explicitly ad-hoc", () => {
    assert.equal(assertTierLock({ planFile: "", requestedTier: "standard" }).ok, false);
    assert.equal(assertTierLock({ planFile: "", requestedTier: "standard", allowNoPlan: true }).bypassed, true);
    assert.equal(run("scripts/run-tier.mjs", ["standard"], { TASK_PLAN_FILE: "" }).status, 2);
  });
  test("tier mismatch is rejected before runner steps", () => {
    assert.equal(assertTierLock({ planFile: planPath, requestedTier: "heavy" }).ok, false);
    assert.equal(run("scripts/run-tier.mjs", ["heavy"], { TASK_PLAN_FILE: planPath }).status, 2);
  });
  test("plan parser accepts the registered command", () => assert.equal(parsePlanTier(plan()).tier, "standard"));
  for (const tier of ["fast", "standard", "standard-plus", "heavy"]) {
    test(`completion selection chooses only test-${tier}`, () => {
      writeFileSync(planPath, planForTier(tier));
      assert.deepEqual(resolveTaskCompletionSelection(planPath).commandIds, [`test-${tier}`]);
    });
  }
  test("completion selection rejects missing plan context before launch", () => {
    assert.equal(resolveTaskCompletionSelection("").ok, false);
  });
  test("conflicting tier declarations fail closed", () => {
    assert.equal(parsePlanTier(plan().replace("## Validation tier\nstandard", "## Validation tier\nheavy")).ok, false);
  });
  test("duplicate tier declarations fail closed", () => {
    assert.equal(parsePlanTier(`${plan()}\n## Validation tier\nstandard\n`).ok, false);
  });
  test("only a terminal successful one-command run is completion evidence", () => {
    writeFileSync(planPath, planForTier("standard-plus"));
    const selection = resolveTaskCompletionSelection(planPath);
    const passedRun = {
      runId: "run-contract-pass",
      status: "PASSED",
      commands: [{ commandId: "test-standard-plus", status: "PASSED" }],
    };
    assert.deepEqual(validateTaskCompletionEvidence(selection, passedRun), {
      ok: true,
      runId: "run-contract-pass",
      command: "test-standard-plus",
      status: "PASSED",
    });
    for (const status of ["RUNNING", "FAILED", "STOPPED", "ERROR", "TIMED_OUT"]) {
      assert.equal(validateTaskCompletionEvidence(selection, { ...passedRun, status }).ok, false);
    }
    assert.equal(validateTaskCompletionEvidence(selection, {
      ...passedRun,
      commands: [{ commandId: "test-heavy", status: "PASSED" }],
    }).ok, false);
    assert.equal(validateTaskCompletionEvidence(selection, {
      ...passedRun,
      commands: [...passedRun.commands, { commandId: "test-fast", status: "PASSED" }],
    }).ok, false);
  });
  test("explicit ad-hoc selection cannot masquerade as task completion evidence", () => {
    const selection = selectExplicitValidation("test-fast");
    assert.equal(selection.commandIds.length, 1);
    assert.equal(selection.completionEligible, false);
    assert.equal(validateTaskCompletionEvidence(selection, {
      runId: "run-adhoc",
      status: "PASSED",
      commands: [{ commandId: "test-fast", status: "PASSED" }],
    }).ok, false);
  });
  test("task plan symlinks cannot escape scoped writes", () => {
    const outside = join(temp, "outside.md");
    const link = join(taskDir, `failure-gate-contract-link-${nonce}.md`);
    writeFileSync(outside, "# outside\n");
    symlinkSync(outside, link);
    try {
      assert.equal(run("scripts/check-failure-gate.mjs", ["--fix-stub"], { TASK_PLAN_FILE: link }).status, 2);
      assert.equal(readFileSync(outside, "utf8"), "# outside\n");
    } finally {
      rmSync(link, { force: true });
    }
  });
  test("runner orders scoped repair before strict checks", () => {
    const names = getTierSteps("fast").map(([name]) => name);
    assert.ok(names.indexOf("plan-gate-fix") < names.indexOf("plan-gate-check"));
    assert.ok(names.indexOf("regression-guard-fix") < names.indexOf("regression-guard"));
  });
  test("standard runner synchronizes the package before checking its contract", () => {
    const names = getTierSteps("standard").map(([name]) => name);
    assert.ok(names.indexOf("failure-gate-package-sync") < names.indexOf("failure-gate-contract"));
  });
  test("tier advice describes the registered heavy-only step and its justified exception", () => {
    const standardPlus = new Set(getTierSteps("standard-plus").map(([name]) => name));
    const heavyOnly = getTierSteps("heavy").map(([name]) => name).filter((name) => !standardPlus.has(name));
    assert.deepEqual(heavyOnly, ["protected-map-concurrency"]);
    for (const file of [".agents/skills/failure-gate/SKILL.md", "replit.md"]) {
      const content = readFileSync(file, "utf8");
      const advice = file.startsWith(".agents")
        ? content.split("### Choosing the lightest sufficient tier\n")[1]?.split("\n### ")[0]
        : content.split("**Picking a tier (defaults unless the plan clearly implies otherwise):**\n")[1]?.split("\n### ")[0];
      assert.ok(advice, `${file} must have tier selection advice`);
      for (const tier of ["fast", "standard", "standard-plus", "heavy"]) {
        assert.match(advice, new RegExp(`\\btest-${tier}\\b|\\x60${tier}\\x60`), `${file} must advise on ${tier}`);
      }
      assert.match(advice, /report-only/, `${file} must allow static-only report audits`);
      assert.match(advice, /test-bearing change/, `${file} must distinguish test changes`);
      assert.match(advice, /auth/, `${file} must cover auth`);
      assert.match(advice, /API/, `${file} must cover API contracts`);
      assert.match(advice, /protected-map-concurrency/, `${file} must name the heavy-only step`);
      assert.match(advice, /explicitly requires? full-tier verification/, `${file} must allow justified heavy verification`);
      assert.doesNotMatch(advice, /heavy\s*[—:-]\s*same as standard-plus|identical steps/i);
      assert.match(advice, /not (?:merely because|require heavy)/, `${file} must not require heavy for unrelated changes`);
    }
  });
  test("standard Failure Gate contract runs plan-tier help and under-tier checks", () => {
    const result = spawnSync("bash", ["scripts/test/check-plan-tier.test.sh"], {
      cwd: resolve("."),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
  test("maintenance reports findings without becoming a validation failure", () => {
    const expiredPath = join(temp, "expired.json");
    writeFileSync(expiredPath, JSON.stringify({ version: 1, records: [{ ...record, reviewDeadline: "2026-08-01" }] }));
    const result = run("scripts/maintain-validation-baseline.mjs", ["--file", expiredPath]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /expired/);
  });
  test("maintenance defaults missing thresholds before reading the catalog", () => {
    const result = run("scripts/maintain-validation-baseline.mjs", ["--file", catalogPath], {
      BASELINE_WARNING_DAYS: undefined,
      BASELINE_MAX_EVIDENCE_DAYS: undefined,
    });
    assert.equal(result.status, 0, result.stderr);
  });
  test("maintenance rejects a missing CLI threshold before reading the catalog", () => {
    const result = run("scripts/maintain-validation-baseline.mjs", ["--file", join(temp, "missing.json"), "--warning-days"], {
      BASELINE_WARNING_DAYS: undefined,
      BASELINE_MAX_EVIDENCE_DAYS: undefined,
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--warning-days must be a finite, non-negative integer \(received missing\)/);
    assert.doesNotMatch(result.stderr, /ENOENT|missing\.json/);
  });
  test("maintenance rejects non-numeric environment thresholds before reading the catalog", () => {
    const result = run("scripts/maintain-validation-baseline.mjs", ["--file", join(temp, "missing.json")], {
      BASELINE_WARNING_DAYS: "soon",
      BASELINE_MAX_EVIDENCE_DAYS: undefined,
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /BASELINE_WARNING_DAYS must be a finite, non-negative integer/);
    assert.doesNotMatch(result.stderr, /ENOENT|missing\.json/);
  });
  test("maintenance rejects negative thresholds", () => {
    const result = run("scripts/maintain-validation-baseline.mjs", ["--file", catalogPath, "--warning-days", "-1"], {
      BASELINE_WARNING_DAYS: undefined,
      BASELINE_MAX_EVIDENCE_DAYS: "-1",
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--warning-days must be a finite, non-negative integer/);
    assert.match(result.stderr, /BASELINE_MAX_EVIDENCE_DAYS must be a finite, non-negative integer/);
  });
  test("maintenance rejects fractional thresholds", () => {
    const result = run("scripts/maintain-validation-baseline.mjs", ["--file", catalogPath, "--warning-days", "1.5"], {
      BASELINE_WARNING_DAYS: undefined,
      BASELINE_MAX_EVIDENCE_DAYS: "14",
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--warning-days must be a finite, non-negative integer/);
  });
  test("maintenance accepts zero and valid thresholds", () => {
    const result = run("scripts/maintain-validation-baseline.mjs", ["--file", catalogPath, "--warning-days", "0"], {
      BASELINE_WARNING_DAYS: undefined,
      BASELINE_MAX_EVIDENCE_DAYS: "14",
    });
    assert.equal(result.status, 0, result.stderr);
  });
  test("CLI maximum evidence threshold takes precedence over its environment value", () => {
    const result = run(
      "scripts/maintain-validation-baseline.mjs",
      ["--file", catalogPath, "--max-evidence-days", "100", "--json"],
      {
        BASELINE_WARNING_DAYS: undefined,
        BASELINE_MAX_EVIDENCE_DAYS: "0",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.thresholds, { warningDays: 30, maxEvidenceDays: 100 });
    assert.doesNotMatch(JSON.stringify(report.findings), /stale-evidence/);
  });
  test("environment maximum evidence threshold is used when its CLI override is omitted", () => {
    const result = run(
      "scripts/maintain-validation-baseline.mjs",
      ["--file", catalogPath, "--json"],
      {
        BASELINE_WARNING_DAYS: undefined,
        BASELINE_MAX_EVIDENCE_DAYS: "0",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assertBaselineReportContract(report);
    assert.deepEqual(report.thresholds, { warningDays: 30, maxEvidenceDays: 0 });
    assert.equal(report.findings[0]?.kind, "stale-evidence");
  });
  test("JSON findings match the stable item schema and allowed kinds", () => {
    const findingCatalogPath = join(temp, "finding-shapes.json");
    const findingRecords = [
      { ...record, id: "BASE-EXPIRED", reviewDeadline: dateOffset(-1) },
      { ...record, id: "BASE-REVIEW-DUE", reviewDeadline: dateOffset(1) },
      { ...record, id: "BASE-STALE", evidenceDate: dateOffset(-91) },
    ];
    writeFileSync(findingCatalogPath, JSON.stringify({ version: 1, records: findingRecords }));
    const result = run(
      "scripts/maintain-validation-baseline.mjs",
      ["--file", findingCatalogPath, "--warning-days", "30", "--max-evidence-days", "90", "--json"],
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assertBaselineReportContract(report);
    assert.deepEqual(new Set(report.findings.map((finding) => finding.kind)), BASELINE_FINDING_KINDS);
  });
  test("JSON report matches the stable schema and exposes default effective thresholds", () => {
    const result = run("scripts/maintain-validation-baseline.mjs", ["--file", catalogPath, "--json"], {
      BASELINE_WARNING_DAYS: undefined,
      BASELINE_MAX_EVIDENCE_DAYS: undefined,
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assertBaselineReportContract(report);
    assert.deepEqual(report.thresholds, { warningDays: 30, maxEvidenceDays: 90 });
  });
  test("maintenance rejects unsupported options before reading the catalog", () => {
    const missingCatalog = join(temp, "missing-unsupported-option.json");
    for (const args of [
      ["--file", missingCatalog, "--no-such-option"],
      ["--file", missingCatalog, "--no-such-option", "--json"],
    ]) {
      const result = run("scripts/maintain-validation-baseline.mjs", args, {
        BASELINE_WARNING_DAYS: undefined,
        BASELINE_MAX_EVIDENCE_DAYS: undefined,
      });
      assert.equal(result.status, 2);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /missing-unsupported-option\.json|ENOENT/);
      if (args.includes("--json")) {
        const error = JSON.parse(result.stderr);
        assert.equal(error.error, "invalid_configuration");
        assert.match(error.message, /unsupported option/);
      } else {
        assert.match(result.stderr, /unsupported option/);
      }
    }
  });
  test("maintenance rejects duplicate threshold options in human and JSON modes", () => {
    for (const suffix of [[], ["--json"]]) {
      const result = run(
        "scripts/maintain-validation-baseline.mjs",
        ["--file", catalogPath, "--warning-days", "14", "--warning-days", "30", ...suffix],
        {
          BASELINE_WARNING_DAYS: undefined,
          BASELINE_MAX_EVIDENCE_DAYS: undefined,
        },
      );
      assert.equal(result.status, 2);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /catalog\.json|ENOENT/);
      if (suffix.includes("--json")) {
        const error = JSON.parse(result.stderr);
        assert.equal(error.code, "INVALID_CONFIGURATION");
        assert.match(error.message, /--warning-days may only be specified once/);
      } else {
        assert.match(result.stderr, /--warning-days may only be specified once/);
      }
    }
  });
  test("CLI thresholds override environment values in the JSON report", () => {
    const result = run(
      "scripts/maintain-validation-baseline.mjs",
      ["--file", catalogPath, "--warning-days", "14", "--max-evidence-days", "60", "--json"],
      {
        BASELINE_WARNING_DAYS: "1",
        BASELINE_MAX_EVIDENCE_DAYS: "2",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).thresholds, { warningDays: 14, maxEvidenceDays: 60 });
  });
  test("invalid CLI configuration emits structured JSON before reading the catalog", () => {
    const missingCatalog = join(temp, "missing-json-config.json");
    const result = run(
      "scripts/maintain-validation-baseline.mjs",
      ["--file", missingCatalog, "--max-evidence-days", "soon", "--json"],
      {
        BASELINE_WARNING_DAYS: undefined,
        BASELINE_MAX_EVIDENCE_DAYS: undefined,
      },
    );
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    const error = JSON.parse(result.stderr);
    assertConfigurationErrorContract(error);
    assert.match(error.message, /--max-evidence-days must be a finite, non-negative integer/);
    assert.doesNotMatch(JSON.stringify(error), /missing-json-config\.json|ENOENT/);
  });
  test("generated mirrors and task archives are not tracked deliverables", () => {
    const names = spawnSync("git", ["diff", "--name-only"], { encoding: "utf8" }).stdout;
    assert.doesNotMatch(names, /^\.local\//m);
  });
  test("published package contains every durable component", () => {
    const output = spawnSync("unzip", ["-Z1", "artifacts/failure-gate-skill.zip"], { encoding: "utf8" }).stdout;
    for (const file of ["SKILL.md", ...DISTRIBUTION_FILES]) assert.match(output, new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  });
  test("published package matches every current durable component", () => {
    assert.equal(verifyDistribution(), true);
  });
  test("distribution verification rejects stale support-file bytes", () => {
    const staging = join(temp, "stale-package");
    const staleArchive = join(temp, "stale.zip");
    mkdirSync(staging);
    const unzip = spawnSync("unzip", ["-q", "artifacts/failure-gate-skill.zip", "-d", staging]);
    assert.equal(unzip.status, 0);
    writeFileSync(join(staging, "scripts/check-failure-gate.mjs"), "// stale\n");
    const zip = spawnSync("zip", ["-q", "-X", "-r", staleArchive, "."], { cwd: staging });
    assert.equal(zip.status, 0);
    assert.equal(verifyDistribution(staleArchive), false);
    assert.equal(syncDistribution(staleArchive), true);
    assert.equal(verifyDistribution(staleArchive), true);
  });
} finally {
  rmSync(planPath, { force: true });
  rmSync(siblingPath, { force: true });
  rmSync(stubPath, { force: true });
  rmSync(stubsOnlyPath, { force: true });
  rmSync(scaffoldPath, { force: true });
  rmSync(temp, { recursive: true, force: true });
}

console.log(`Failure Gate contract: ${passed} checks passed.`);