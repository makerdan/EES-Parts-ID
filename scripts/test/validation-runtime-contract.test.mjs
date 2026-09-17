#!/usr/bin/env node
/**
 * Contract coverage for the validation runner's database mode and Node
 * runtime declarations. Keep these checks side-effect free and portable so
 * they can run before the database-backed test step.
 */
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  assertValidationHostToolContract,
  getTierSteps,
} from "../validation-steps.mjs";

const root = resolve(".");
const validationSteps = readFileSync(resolve(root, "scripts/validation-steps.mjs"), "utf8");
const tierRunner = readFileSync(resolve(root, "scripts/run-tier.mjs"), "utf8");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const nodeVersion = readFileSync(resolve(root, ".node-version"), "utf8").trim();
const replit = readFileSync(resolve(root, ".replit"), "utf8");
const githubSetup = readFileSync(
  resolve(root, ".github/actions/setup-node-pnpm/action.yml"),
  "utf8",
);

const standardSteps = getTierSteps("standard");
const fastSteps = getTierSteps("fast");
const validationRuntimeStep = fastSteps.find(
  ([name]) => name === "validation-runtime-contract",
);
const testStep = standardSteps.find(([name]) => name === "test");
assert.ok(
  testStep,
  "standard validation must define a database-backed test step",
);
assert.deepEqual(
  validationRuntimeStep,
  [
    "validation-runtime-contract",
    "node scripts/test/validation-runtime-contract.test.mjs",
  ],
  "host-tool contract coverage must run in the fast validation tier",
);
assert.match(
  tierRunner,
  /name === "test" \? \{ \.\.\.process\.env, DATABASE_ENV: "test" \}/,
  "the runner must scope DATABASE_ENV=test to the test step",
);
assert.doesNotMatch(
  tierRunner,
  /process\.env\.DATABASE_ENV\s*=\s*"test"/,
  "the runner must not mutate the parent process database mode",
);
assert.equal(
  standardSteps.filter(([name]) => name === "test").length,
  1,
  "standard validation must have exactly one database-backed test step",
);
assert.match(
  validationSteps,
  /\["test",\s*"node scripts\/serial-lock\.mjs --resource shared-test-results/,
  "the canonical test step must remain the serialized workspace test command",
);
for (const tier of ["fast", "standard", "standard-plus", "heavy"]) {
  assert.doesNotThrow(
    () => assertValidationHostToolContract(tier),
    `${tier} validation commands must use only declared host tools`,
  );
}
assert.throws(
  () =>
    assertValidationHostToolContract("fast", [
      [
        "synthetic-unlisted-tool",
        "node scripts/example.mjs && missing-host-tool --check",
      ],
    ]),
  /step "synthetic-unlisted-tool" relies on unlisted host executable "missing-host-tool".*validation capability and setup source.*scripts\/validation-steps\.mjs/s,
  "an unlisted executable must identify the validation step and where its capability/setup contract belongs",
);
assert.deepEqual(
  fastSteps.find(([name]) => name === "port-authority-contract"),
  ["port-authority-contract", "node scripts/test-port-authority.mjs"],
  "test-fast must keep the focused Port Authority contract reachable",
);

for (const [tier, priority, budgetMs] of [
  ["fast", 1, null],
  ["standard", 2, 300_000],
  ["standard-plus", 2, 2_700_000],
  ["heavy", 3, 2_700_000],
]) {
  const budgetPrefix = budgetMs === null ? "" : `SERIAL_LOCK_BUDGET_MS=${budgetMs} `;
  assert.equal(
    packageJson.scripts?.[`test-${tier}`],
    `${budgetPrefix}node scripts/serial-lock.mjs --resource validation --priority ${priority} -- node scripts/run-tier.mjs ${tier} --allow-no-plan`,
    `test-${tier} must keep its documented lock priority and post-acquisition budget`,
  );
}

assert.match(
  tierRunner,
  /queue-wait before start:/,
  "the tier report must report queue wait separately from execution time",
);
assert.match(
  tierRunner,
  /tier execution after lock:/,
  "the tier report must keep execution time separate from queue wait time",
);

assert.match(
  packageJson.engines?.node ?? "",
  /^>=24\.12\.0 <25$/,
  "package.json must accept the Replit pnpm launcher while staying within Node 24",
);
assert.equal(nodeVersion, "24.13.0", ".node-version must keep the pinned Node patch");
assert.match(replit, /modules = \["nodejs-24"/, "Replit must use the Node 24 module");
assert.match(
  githubSetup,
  /node-version-file:\s*\.node-version/,
  "GitHub Actions must install the pinned repository Node version",
);

const runtimeCheck = spawnSync(process.execPath, ["scripts/check-node-runtime.mjs"], {
  cwd: root,
  encoding: "utf8",
});
assert.equal(runtimeCheck.status, 0, runtimeCheck.stderr);
assert.match(
  runtimeCheck.stdout,
  /Node runtime contract OK: 24\.13\.0/,
  "runtime diagnostics must confirm the active pinned version",
);
assert.doesNotMatch(
  `${runtimeCheck.stdout}\n${runtimeCheck.stderr}`,
  /Unsupported engine|does not match/,
  "runtime diagnostics must not report a stale engine mismatch",
);

const timeoutReportScript = resolve(root, "scripts/test-timeout-report.mjs");
const timeoutFixtureDir = mkdtempSync(join(tmpdir(), "timeout-report-contract-"));

function runTimeoutReport({ file, testName, duration }) {
  const resultPath = join(timeoutFixtureDir, `${file.replaceAll("/", "_")}.json`);
  const manifestPath = join(timeoutFixtureDir, `${file.replaceAll("/", "_")}.manifest.json`);
  writeFileSync(
    resultPath,
    JSON.stringify({
      numTotalTests: 1,
      testResults: [
        {
          testFilePath: file,
          testResults: [
            {
              status: "passed",
              title: testName,
              fullName: testName,
              duration,
            },
          ],
        },
      ],
    }),
  );
  writeFileSync(
    manifestPath,
    JSON.stringify([
      {
        suite: "contract-fixture",
        jsonPath: resultPath,
        wallClockMs: duration,
        budgetMs: 60_000,
        exitCode: 0,
      },
    ]),
  );
  return spawnSync(process.execPath, [timeoutReportScript, manifestPath], {
    cwd: root,
    encoding: "utf8",
  });
}

try {
  const boundary = runTimeoutReport({
    file: "boundary.test.js",
    testName: "normal test at the exact budget boundary",
    duration: 10_000,
  });
  assert.equal(boundary.status, 0, boundary.stderr);
  assert.match(
    boundary.stdout,
    /RESULT: All suites passed within their budgets\./,
    "an exact-boundary normal test must remain within budget",
  );
  assert.match(
    boundary.stdout,
    /TEST BUDGET VIOLATIONS \(completed tests\)[\s\S]*None\./,
    "the exact boundary must not be reported as a budget violation",
  );

  const normalOverage = runTimeoutReport({
    file: "normal.test.js",
    testName: "normal test over budget",
    duration: 10_001,
  });
  assert.equal(normalOverage.status, 1, normalOverage.stderr);
  assert.match(
    normalOverage.stdout,
    /\[normal-test\] \[contract-fixture\] normal test over budget/,
    "normal-test budget overage must identify its budget category and test",
  );
  assert.match(
    normalOverage.stdout,
    /Duration: 10\.00s /,
    "normal-test budget overage must report the measured duration",
  );
  assert.doesNotMatch(
    normalOverage.stdout,
    /RESULT: All suites passed within their budgets\./,
    "a normal-test budget overage must not claim all suites passed",
  );

  const integrationOverage = runTimeoutReport({
    file: "warehouse.integration.test.js",
    testName: "integration test over budget",
    duration: 20_001,
  });
  assert.equal(integrationOverage.status, 1, integrationOverage.stderr);
  assert.match(
    integrationOverage.stdout,
    /\[integration-test\] \[contract-fixture\] integration test over budget/,
    "integration-test budget overage must identify its distinct budget category and test",
  );
  assert.match(
    integrationOverage.stdout,
    /Budget: 20\.00s/,
    "integration-test budget overage must use the integration budget",
  );
  assert.doesNotMatch(
    integrationOverage.stdout,
    /TIMEOUT VIOLATIONS \(individual tests\)[\s\S]*integration test over budget/,
    "a completed integration-test overage must remain distinct from framework timeouts",
  );
} finally {
  rmSync(timeoutFixtureDir, { recursive: true, force: true });
}

console.log("Validation runtime contract: test database mode and Node declarations are aligned");