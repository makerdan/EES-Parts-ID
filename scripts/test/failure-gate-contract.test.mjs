#!/usr/bin/env node
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { assertTierLock, parsePlanTier } from "../lib/tier-lock-check.mjs";
import { baselineErrorsForPlan, validateCatalog } from "../lib/failure-baseline.mjs";
import { DISTRIBUTION_FILES, verify as verifyDistribution } from "../publish-failure-gate.mjs";
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
  return spawnSync(process.execPath, [script, ...args], {
    cwd: resolve("."),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

const temp = mkdtempSync(join(tmpdir(), "failure-gate-contract-"));
const taskDir = resolve(".local/tasks");
mkdirSync(taskDir, { recursive: true });
const nonce = `${process.pid}-${Date.now()}`;
const planPath = join(taskDir, `failure-gate-contract-${nonce}.md`);
const siblingPath = join(taskDir, `failure-gate-contract-sibling-${nonce}.md`);
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
  test("no-plan tier use fails unless explicitly ad-hoc", () => {
    assert.equal(assertTierLock({ planFile: "", requestedTier: "standard" }).ok, false);
    assert.equal(assertTierLock({ planFile: "", requestedTier: "standard", allowNoPlan: true }).bypassed, true);
  });
  test("tier mismatch is rejected before runner steps", () => {
    assert.equal(assertTierLock({ planFile: planPath, requestedTier: "heavy" }).ok, false);
  });
  test("plan parser accepts the registered command", () => assert.equal(parsePlanTier(plan()).tier, "standard"));
  test("conflicting tier declarations fail closed", () => {
    assert.equal(parsePlanTier(plan().replace("## Validation tier\nstandard", "## Validation tier\nheavy")).ok, false);
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
  test("maintenance reports findings without becoming a validation failure", () => {
    const expiredPath = join(temp, "expired.json");
    writeFileSync(expiredPath, JSON.stringify({ version: 1, records: [{ ...record, reviewDeadline: "2026-08-01" }] }));
    const result = run("scripts/maintain-validation-baseline.mjs", ["--file", expiredPath]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /expired/);
  });
  test("generated mirrors and task archives are not tracked deliverables", () => {
    const names = spawnSync("git", ["diff", "--name-only"], { encoding: "utf8" }).stdout;
    assert.doesNotMatch(names, /^\.local\//m);
  });
  test("published package contains every durable component", () => {
    const output = spawnSync("unzip", ["-Z1", "artifacts/failure-gate-skill.zip"], { encoding: "utf8" }).stdout;
    for (const file of ["SKILL.md", ...DISTRIBUTION_FILES]) assert.match(output, new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
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
  });
} finally {
  rmSync(planPath, { force: true });
  rmSync(siblingPath, { force: true });
  rmSync(temp, { recursive: true, force: true });
}

console.log(`Failure Gate contract: ${passed} checks passed.`);