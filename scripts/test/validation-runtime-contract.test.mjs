#!/usr/bin/env node
/**
 * Contract coverage for the validation runner's database mode and Node
 * runtime declarations. Keep these checks side-effect free and portable so
 * they can run before the database-backed test step.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  ALL_VALIDATION_TIERS,
  assertValidationHostToolContract,
  getTierSteps,
  TIERS,
} from "../validation-steps.mjs";

const root = resolve(".");
const validationSteps = readFileSync(resolve(root, "scripts/validation-steps.mjs"), "utf8");
const tierRunner = readFileSync(resolve(root, "scripts/run-tier.mjs"), "utf8");
const serialLock = readFileSync(resolve(root, "scripts/serial-lock.mjs"), "utf8");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const apiPackageJson = JSON.parse(
  readFileSync(resolve(root, "artifacts/api-server/package.json"), "utf8"),
);
const nodeVersion = readFileSync(resolve(root, ".node-version"), "utf8").trim();
const replit = readFileSync(resolve(root, ".replit"), "utf8");
const workspaceGuide = readFileSync(resolve(root, "replit.md"), "utf8");
const githubSetup = readFileSync(
  resolve(root, ".github/actions/setup-node-pnpm/action.yml"),
  "utf8",
);
const parityReport = readFileSync(
  resolve(root, "docs/validation/ci-validation-parity.md"),
  "utf8",
);
const ciWorkflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");

assert.deepEqual(
  Object.keys(TIERS),
  ALL_VALIDATION_TIERS,
  "canonical tier registry must expose all four registered tiers in order",
);
const tierSteps = new Map(
  ALL_VALIDATION_TIERS.map((tier) => {
    const steps = getTierSteps(tier);
    assert.ok(steps?.length, `${tier} validation tier must not be empty`);
    const names = steps.map(([name]) => name);
    assert.equal(
      new Set(names).size,
      names.length,
      `${tier} validation tier must not contain duplicate step names`,
    );
    return [tier, steps];
  }),
);
for (let index = 1; index < ALL_VALIDATION_TIERS.length; index += 1) {
  const previousTier = ALL_VALIDATION_TIERS[index - 1];
  const tier = ALL_VALIDATION_TIERS[index];
  assert.deepEqual(
    tierSteps.get(tier).slice(0, tierSteps.get(previousTier).length),
    tierSteps.get(previousTier),
    `${tier} must include ${previousTier} as its ordered prefix`,
  );
}
const heavyOnlyNames = tierSteps
  .get("heavy")
  .map(([name]) => name)
  .filter((name) => !new Set(tierSteps.get("standard-plus").map(([step]) => step)).has(name));
assert.deepEqual(
  heavyOnlyNames,
  ["protected-map-concurrency"],
  "heavy must add only the documented protected-map concurrency check",
);

const standardSteps = tierSteps.get("standard");
const fastSteps = tierSteps.get("fast");
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
for (const scriptName of ["test", "test:coverage", "test:provider"]) {
  assert.match(
    apiPackageJson.scripts?.[scriptName] ?? "",
    /serial-lock\.mjs --resource shared-test-results --priority 2 --/,
    `${scriptName} must share the root test harness resource so nested validation is reentrant`,
  );
}
for (const tier of ALL_VALIDATION_TIERS) {
  assert.ok(
    getTierSteps(tier).length > 0 && getTierSteps(tier).every(([name]) => name),
    `${tier} must remain executable through the canonical registry`,
  );
  assert.ok(
    getTierSteps(tier).length <= getTierSteps("heavy").length,
    `${tier} must not exceed the heavy tier's registered scope`,
  );
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

const runnerContracts = {
  fast: { priority: 1, budgetMs: null },
  // A representative standard run used 660–723s after acquisition, including
  // ~300s of complete history scanning; 1800s leaves room for shared-host variance.
  standard: { priority: 2, budgetMs: 1_800_000 },
  "standard-plus": { priority: 2, budgetMs: 2_700_000 },
  heavy: { priority: 3, budgetMs: 2_700_000 },
};
const registeredTierScripts = Object.keys(packageJson.scripts ?? {})
  .filter((name) => /^test-(fast|standard|standard-plus|heavy)$/.test(name))
  .map((name) => name.slice("test-".length));
assert.deepEqual(
  registeredTierScripts,
  ALL_VALIDATION_TIERS,
  "package scripts must register exactly the canonical four validation tiers",
);
assert.equal(
  packageJson.scripts?.["test-standard:observed"],
  "node scripts/observe-validation.mjs start -- pnpm run test-standard",
  "the service observer must execute the complete canonical standard tier rather than replacing its checks",
);
for (const tier of ALL_VALIDATION_TIERS) {
  const { priority, budgetMs } = runnerContracts[tier];
  const budgetPrefix = budgetMs === null ? "" : `SERIAL_LOCK_BUDGET_MS=${budgetMs} `;
  assert.equal(
    packageJson.scripts?.[`test-${tier}`],
    `${budgetPrefix}node scripts/serial-lock.mjs --resource validation --priority ${priority} -- node scripts/run-tier.mjs ${tier} --allow-no-plan`,
    `test-${tier} must keep its documented lock priority and post-acquisition budget`,
  );
}
// A tier can time out before its summary is printed; the wrapper must still
// identify the interrupted step and release its lock after killing the worker.
{
  const fixtureDir = mkdtempSync(join(tmpdir(), "tier-budget-contract-"));
  const fixtureLock = join(fixtureDir, "lock");
  try {
    const result = spawnSync(
      process.execPath,
      [
        resolve(root, "scripts/serial-lock.mjs"),
        "--resource", "budget-fixture", "--priority", "2", "--",
        process.execPath, "-e",
        'const marker = Buffer.from("━━━ [run-tier] step: synthetic-slow-step ━━━\\n"); ' +
        'process.stdout.write(marker.subarray(0, 1)); ' +
        'setTimeout(() => process.stdout.write(marker.subarray(1)), 10); ' +
        'setInterval(() => {}, 1000)',
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 8_000,
        env: {
          ...process.env,
          SERIAL_LOCK_FILE: fixtureLock,
          SERIAL_LOCK_BUDGET_MS: "600",
          SERIAL_LOCK_KILL_GRACE_MS: "250",
        },
      },
    );
    assert.equal(result.status, 124, `budget fixture must time out: ${result.stderr}`);
    assert.match(
      result.stderr,
      /budget of 600ms exceeded after acquisition .*active step "synthetic-slow-step".*terminating process group/,
      "timeout diagnostics must name the interrupted tier step",
    );
    assert.equal(existsSync(fixtureLock), false, "timeout must release the serialized lock");
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}
// The registered service cannot observe a command beyond its own window.
// Pending is never a pass: the detached worker must retain the real exit and log.
{
  const observer = resolve(root, "scripts/observe-validation.mjs");
  const start = (command) => spawnSync(
    process.execPath,
    [observer, "start", "--wait-ms", "0", "--", ...command],
    { cwd: root, encoding: "utf8", timeout: 5_000 },
  );
  const readStatus = (id) => spawnSync(
    process.execPath,
    [observer, "status", id],
    { cwd: root, encoding: "utf8", timeout: 5_000 },
  );
  for (const [name, script, expected] of [
    ["pass", 'setTimeout(() => console.log("fixture complete"), 300)', 0],
    ["failure", 'setTimeout(() => process.exit(7), 300)', 7],
  ]) {
    const launch = start([process.execPath, "-e", script]);
    const id = launch.stdout.match(/started ([0-9a-f-]{36})/)?.[1];
    assert.equal(launch.status, 75, `${name}: pending must be nonzero: ${launch.stderr}`);
    assert.ok(id, `${name}: missing observation ID: ${launch.stdout}`);
    let terminal;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      terminal = readStatus(id);
      if (terminal.status !== 75) break;
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.equal(terminal.status, expected, `${name}: terminal status not retained: ${terminal.stderr}`);
    assert.match(terminal.stdout, new RegExp(expected === 0 ? "PASSED" : "FAILED"));
    assert.match(terminal.stdout, new RegExp(`exit=${expected}`));
  }
  const fixtureDir = mkdtempSync(join(tmpdir(), "observed-budget-"));
  try {
    const launch = spawnSync(process.execPath, [
      observer, "start", "--wait-ms", "0", "--",
      process.execPath, resolve(root, "scripts/serial-lock.mjs"),
      "--resource", "observed-budget", "--",
      process.execPath, "-e",
      'console.log("━━━ [run-tier] step: synthetic-timeout ━━━"); setInterval(() => {}, 1000)',
    ], {
      cwd: root,
      encoding: "utf8",
      timeout: 5_000,
      env: {
        ...process.env,
        SERIAL_LOCK_FILE: join(fixtureDir, "lock"),
        SERIAL_LOCK_BUDGET_MS: "500",
        SERIAL_LOCK_KILL_GRACE_MS: "250",
      },
    });
    const id = launch.stdout.match(/started ([0-9a-f-]{36})/)?.[1];
    assert.equal(launch.status, 75, launch.stderr);
    assert.ok(id, "timeout fixture must provide an observation ID");
    let terminal;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      terminal = readStatus(id);
      if (terminal.status !== 75) break;
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.equal(terminal.status, 124, `true execution timeout must stay nonzero: ${terminal.stderr}`);
    const logPath = terminal.stdout.match(/log: ([^\n;]+)/)?.[1];
    assert.ok(logPath, "timeout log path must be visible");
    assert.match(readFileSync(logPath, "utf8"), /active step "synthetic-timeout"/);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}
assert.match(
  tierRunner,
  /assertTierLock\(\{ requestedTier: tier, allowNoPlan \}\)/,
  "the real tier runner must enforce task-plan locking before resolving steps",
);
assert.match(
  readFileSync(resolve(root, "scripts/run-locked-tier.mjs"), "utf8"),
  /resolveTaskCompletionSelection\(planFile\)[\s\S]*TASK_PLAN_FILE: plan\.path/,
  "the locked runner must resolve one plan-selected tier and pass its plan context to the real runner",
);
assert.match(
  serialLock,
  /MAX_TIMER_DELAY_MS = 2_147_483_647[\s\S]*budgetMs > MAX_TIMER_DELAY_MS[\s\S]*or omit the variable for no execution budget/,
  "the serial lock must distinguish an omitted execution budget from an explicitly invalid value",
);
assert.match(
  serialLock,
  /SERIAL_LOCK_INHERITED_FILE[\s\S]*inheritedPathIsCurrent[\s\S]*explicitLockFile === inheritedLockFile[\s\S]*inheritedHeldResources\.has\(lockResource\)[\s\S]*defaultLockFile[\s\S]*explicitLockFile \|\| defaultLockFile/,
  "nested serial locks must derive a new resource lock path instead of inheriting a parent resource's lock file",
);
for (const setting of [
  "SERIAL_LOCK_POLL_MS",
  "SERIAL_LOCK_TIMEOUT_MS",
  "SERIAL_LOCK_HEARTBEAT_MS",
  "SERIAL_LOCK_STALE_HEARTBEAT_MS",
  "SERIAL_LOCK_PRIORITY_GRACE_MS",
  "SERIAL_LOCK_MAX_HOLD_MS",
  "SERIAL_LOCK_KILL_GRACE_MS",
  "SERIAL_LOCK_GROUP_POLL_MS",
]) {
  assert.match(
    serialLock,
    new RegExp(`positiveIntegerSetting\\(\\s*"${setting}"`),
    `${setting} must use the fail-closed timing parser`,
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
  tierRunner,
  /execution budget after lock:[\s\S]*headroom at report:/,
  "budgeted tiers must report their bounded post-lock budget and remaining headroom",
);
assert.match(
  parityReport,
  /`CI` → `Portable validation` →\s*`pnpm run test-standard-plus`/,
  "the parity report must name standard-plus as the single remote validation path",
);
assert.match(
  parityReport,
  /`protected-map-concurrency`[\s\S]*\*\*absent from remote CI\*\*/,
  "the parity report must keep heavy-only coverage explicitly local",
);
assert.match(
  workspaceGuide,
  /`standard-plus`[\s\S]*standard \+ `schema-check`[\s\S]*`heavy`[\s\S]*`protected-map-concurrency`/,
  "workspace documentation must describe cumulative local tier scope",
);
assert.equal(
  (ciWorkflow.match(/pnpm run test-standard-plus/g) ?? []).length,
  1,
  "CI must invoke the canonical standard-plus tier exactly once",
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
const testAllScript = resolve(root, "scripts/test-all.sh");
const testAllSource = readFileSync(testAllScript, "utf8");

function assertSharedPreflightSourceContract(source) {
  const helperStart = source.indexOf("run_preflight_phase() {");
  assert.notEqual(helperStart, -1, "test-all must define the canonical preflight helper");
  const helperEndMatch = /\n\s*# Ensure generated API clients/.exec(source.slice(helperStart));
  assert.ok(helperEndMatch, "preflight helper must end before setup phase declarations");
  const helperEnd = helperStart + helperEndMatch.index;
  const helperBody = source.slice(helperStart, helperEnd);
  const outsideHelper = source.slice(0, helperStart) + source.slice(helperEnd);

  assert.match(
    helperBody,
    /run_owned "\$phase" "\$@"/,
    "the canonical preflight helper must own the child invocation",
  );
  assert.doesNotMatch(
    outsideHelper,
    /run_owned\s+"[^"]*preflight"/,
    "setup phases must not invoke run_owned directly outside the shared helper",
  );
  for (const phase of ["codegen:ensure preflight", "API suite-floor preflight"]) {
    assert.match(
      source,
      new RegExp(`run_preflight_phase[\\s\\\\n]*"${phase.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}"`),
      `setup phase "${phase}" must use the canonical preflight helper`,
    );
  }
}

assertSharedPreflightSourceContract(testAllSource);
assert.throws(
  () =>
    assertSharedPreflightSourceContract(`
      run_preflight_phase() {
        run_owned "$phase" "$@"
      }
      # Ensure generated API clients
      run_owned "future setup preflight" pnpm --filter @workspace/api-spec run codegen:ensure
    `),
  /must not invoke run_owned directly outside the shared helper/,
  "a direct setup invocation must be rejected by the source contract",
);

assert.match(
  testAllSource,
  /run_preflight_phase\(\)[\s\S]*PREFLIGHT_REPORT phase=.*status=.*exit-status=.*timeout=.*suite-started=false child-status=/,
  "all preflight phases must share structured fail-closed reporting",
);

assert.match(
  testAllSource,
  /RUNTIME_DIR="\$\(mktemp -d "\$\{TMPDIR:-\/tmp\}\/test-all-\$\{BASHPID\}\.XXXXXX"\)"/,
  "each test-all invocation must create an isolated runtime directory",
);
assert.match(
  testAllSource,
  /publish-test-result\.mjs/,
  "test-all must publish parsed, run-stamped result evidence",
);
assert.match(
  testAllSource,
  /runId.*RUN_ID/,
  "the manifest must identify the validation run for every suite",
);

function runTimeoutReport({
  file,
  testName,
  duration,
  evidenceMode = "current",
  manifestSuite = "contract-fixture",
  resultSuite = "contract-fixture",
  omitManifestSuite = false,
  omitResultSuite = false,
  wallClockMs = duration,
  budgetMs = 60_000,
  statuses = ["passed"],
}) {
  const resultPath = join(timeoutFixtureDir, `${file.replaceAll("/", "_")}.json`);
  const manifestPath = join(timeoutFixtureDir, `${file.replaceAll("/", "_")}.manifest.json`);
  const runId = `run-${file.replaceAll("/", "-")}`;
  const passedCount = statuses.filter((status) => status === "passed").length;
  const failedCount = statuses.filter((status) => status === "failed").length;
  const todoCount = statuses.filter((status) => status === "todo").length;
  const pendingCount = statuses.filter(
    (status) => status === "pending" || status === "skipped",
  ).length;
  writeFileSync(
    resultPath,
    JSON.stringify({
      validationRunId: evidenceMode === "stale" ? `${runId}-old` : runId,
      ...(omitResultSuite ? {} : { validationSuite: resultSuite }),
      numTotalTestSuites: 1,
      numPassedTestSuites: passedCount > 0 ? 1 : 0,
      numFailedTestSuites: failedCount > 0 ? 1 : 0,
      numPendingTestSuites: 0,
      numTotalTests: statuses.length,
      numPassedTests: passedCount,
      numFailedTests: failedCount,
      numPendingTests: pendingCount,
      numTodoTests: todoCount,
      testResults: [
        {
          testFilePath: file,
          testResults: statuses.map((status) => ({
            status,
            title: `${testName} (${status})`,
            fullName: `${testName} (${status})`,
            ...(status === "passed" || status === "failed" ? { duration } : {}),
          })),
        },
      ],
    }),
  );
  writeFileSync(
    manifestPath,
    JSON.stringify([
      {
        ...(omitManifestSuite ? {} : { suite: manifestSuite }),
        runId,
        jsonPath: resultPath,
        startedAtMs: Date.now() - 1_000,
        wallClockMs,
        budgetMs,
        exitCode: 0,
      },
    ]),
  );
  if (evidenceMode === "missing") rmSync(resultPath, { force: true });
  if (evidenceMode === "corrupt") writeFileSync(resultPath, "{not-json");
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
  assert.match(
    boundary.stdout,
    /RESULT EVIDENCE[\s\S]*All suite results belong to the current validation run\./,
    "a current result must be accepted as report evidence",
  );

  for (const [evidenceMode, expectedStatus, expectedReason] of [
    ["stale", "STALE", "run ID does not match"],
    ["missing", "UNAVAILABLE", "result file is missing"],
    ["corrupt", "UNAVAILABLE", "result JSON is corrupt"],
  ]) {
    const invalidEvidence = runTimeoutReport({
      file: `${evidenceMode}.test.js`,
      testName: `${evidenceMode} result evidence`,
      duration: 1_000,
      evidenceMode,
    });
    assert.equal(invalidEvidence.status, 1, `${evidenceMode} evidence must fail`);
    assert.match(
      invalidEvidence.stdout,
      new RegExp(`RESULT EVIDENCE[\\s\\S]*${expectedStatus}[\\s\\S]*${expectedReason}`),
      `${evidenceMode} evidence must be explicitly classified`,
    );
    assert.doesNotMatch(
      invalidEvidence.stdout,
      /RESULT: All suites passed within their budgets\./,
      `${evidenceMode} evidence must not report a green result`,
    );
  }

  const wrongSuite = runTimeoutReport({
    file: "wrong-suite.test.js",
    testName: "wrong suite result evidence",
    duration: 1_000,
  });
  const wrongSuiteManifest = join(
    timeoutFixtureDir,
    "wrong-suite.test.js.manifest.json",
  );
  const wrongSuiteResult = join(timeoutFixtureDir, "wrong-suite.test.js.json");
  writeFileSync(
    wrongSuiteResult,
    JSON.stringify({
      validationRunId: "run-wrong-suite.test.js",
      validationSuite: "different-suite",
      numTotalTestSuites: 1,
      numPassedTestSuites: 1,
      numFailedTestSuites: 0,
      numPendingTestSuites: 0,
      numTotalTests: 1,
      numPassedTests: 1,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      testResults: [
        {
          testFilePath: "wrong-suite.test.js",
          testResults: [{ status: "passed", title: "wrong suite" }],
        },
      ],
    }),
  );
  writeFileSync(
    wrongSuiteManifest,
    JSON.stringify([
      {
        suite: "contract-fixture",
        runId: "run-wrong-suite.test.js",
        jsonPath: wrongSuiteResult,
        startedAtMs: Date.now() - 1_000,
        wallClockMs: 1_000,
        budgetMs: 60_000,
        exitCode: 0,
      },
    ]),
  );
  const wrongSuiteReport = spawnSync(
    process.execPath,
    [timeoutReportScript, wrongSuiteManifest],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(wrongSuiteReport.status, 1, wrongSuiteReport.stderr);
  assert.match(
    wrongSuiteReport.stdout,
    /CONTRADICTORY[\s\S]*result suite does not match the manifest suite/,
    "result evidence from another suite must not be accepted as current",
  );

  const metadataFailurePath = join(timeoutFixtureDir, "metadata-failure.json");
  const metadataFailureManifest = join(
    timeoutFixtureDir,
    "metadata-failure.manifest.json",
  );
  writeFileSync(
    metadataFailurePath,
    JSON.stringify({
      validationRunId: "run-metadata-failure",
      validationSuite: "contract-fixture",
      numTotalTestSuites: 1,
      numPassedTestSuites: 0,
      numFailedTestSuites: 1,
      numPendingTestSuites: 0,
      numTotalTests: 1,
      numPassedTests: 0,
      numFailedTests: 1,
      numPendingTests: 0,
      numTodoTests: 0,
      testResults: [
        {
          testFilePath: "metadata-failure.test.js",
          testResults: [{ status: "failed", title: "fails" }],
        },
      ],
    }),
  );
  writeFileSync(
    metadataFailureManifest,
    JSON.stringify([
      {
        suite: "contract-fixture",
        runId: "run-metadata-failure",
        jsonPath: metadataFailurePath,
        startedAtMs: Date.now() - 1_000,
        wallClockMs: 1_000,
        budgetMs: 60_000,
        exitCode: 0,
      },
    ]),
  );
  const metadataFailureReport = spawnSync(
    process.execPath,
    [timeoutReportScript, metadataFailureManifest],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(metadataFailureReport.status, 1, metadataFailureReport.stderr);
  assert.match(
    metadataFailureReport.stdout,
    /CONTRADICTORY[\s\S]*package exit status disagrees with result metadata/,
    "a zero package exit must not claim success when result metadata reports failures",
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

  const suiteOverage = runTimeoutReport({
    file: "suite-overage.test.js",
    testName: "suite wall clock over budget",
    duration: 1_000,
    wallClockMs: 60_001,
  });
  assert.equal(suiteOverage.status, 1, suiteOverage.stderr);
  assert.match(
    suiteOverage.stdout,
    /SUITE BUDGET VIOLATIONS \(wall clock\)[\s\S]*Suite budget violation/,
    "a current suite wall-clock overage must have an explicit suite-budget diagnostic",
  );
  assert.doesNotMatch(
    suiteOverage.stdout,
    /RESULT: All suites passed within their budgets\./,
    "a suite wall-clock overage must not claim all suites passed",
  );

  for (const [identityCase, options, expectedReason] of [
    [
      "missing manifest suite",
      { omitManifestSuite: true },
      "manifest suite identity is missing or empty",
    ],
    [
      "empty manifest suite",
      { manifestSuite: "" },
      "manifest suite identity is missing or empty",
    ],
    [
      "missing result validationSuite",
      { omitResultSuite: true },
      "result validationSuite identity is missing or empty",
    ],
    [
      "empty result validationSuite",
      { resultSuite: "" },
      "result validationSuite identity is missing or empty",
    ],
  ]) {
    const missingIdentity = runTimeoutReport({
      file: `${identityCase.replaceAll(" ", "-")}.test.js`,
      testName: `${identityCase} evidence`,
      duration: 1_000,
      ...options,
    });
    assert.equal(missingIdentity.status, 1, `${identityCase} evidence must fail`);
    assert.match(
      missingIdentity.stdout,
      new RegExp(`RESULT EVIDENCE[\\s\\S]*UNAVAILABLE[\\s\\S]*${expectedReason}`),
      `${identityCase} evidence must be explicitly rejected`,
    );
    assert.doesNotMatch(
      missingIdentity.stdout,
      /RESULT: All suites passed within their budgets\./,
      `${identityCase} evidence must not report a green result`,
    );
  }

  const distinctDeferredStatuses = runTimeoutReport({
    file: "distinct-deferred-statuses.test.js",
    testName: "deferred status",
    duration: 1_000,
    statuses: ["passed", "pending", "todo", "skipped"],
  });
  assert.equal(distinctDeferredStatuses.status, 0, distinctDeferredStatuses.stderr);
  assert.match(
    distinctDeferredStatuses.stdout,
    /\[1 pending\] \[1 todo\] \[1 skipped\]/,
    "pending, todo, and skipped assertions must keep distinct summary labels",
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

const hungPreflightFixtureDir = mkdtempSync(join(tmpdir(), "test-all-preflight-contract-"));
const fakeBinDir = join(hungPreflightFixtureDir, "bin");
const fakePnpm = join(fakeBinDir, "pnpm");
const fakeNode = join(fakeBinDir, "node");
const preflightPidFile = join(hungPreflightFixtureDir, "preflight-pids.txt");
mkdirSync(fakeBinDir, { recursive: true });
writeFileSync(
  fakePnpm,
  [
    "#!/usr/bin/env bash",
    "exit 0",
    "",
  ].join("\n"),
  { mode: 0o755 },
);
writeFileSync(
  fakeNode,
  [
    "#!/usr/bin/env bash",
    'if [[ "${1:-}" == "scripts/test/api-suite-floor-contract.test.mjs" ]]; then',
    '  echo "$$" > "$TEST_ALL_PREFLIGHT_PID_FILE"',
    "  sleep 60 &",
    '  echo "$!" >> "$TEST_ALL_PREFLIGHT_PID_FILE"',
    "  wait",
    "fi",
    'exec "$TEST_ALL_REAL_NODE" "$@"',
    "",
  ].join("\n"),
  { mode: 0o755 },
);

try {
  const startedAt = Date.now();
  const hungPreflight = spawnSync("bash", [testAllScript], {
    cwd: root,
    encoding: "utf8",
    timeout: 5_000,
    env: {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      SERIAL_LOCK_HELD_RESOURCES: "shared-test-results",
      TEST_ALL_PREFLIGHT_PID_FILE: preflightPidFile,
      TEST_ALL_REAL_NODE: process.execPath,
      TEST_ALL_TOTAL_BUDGET_SECONDS: "1",
      TEST_ALL_WATCHDOG_GRACE_SECONDS: "1",
    },
  });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(
    hungPreflight.status,
    124,
    `hung preflight should return timeout status; output:\n${hungPreflight.stdout}\n${hungPreflight.stderr}`,
  );
  assert(
    elapsedMs < 5_000,
    `hung preflight exceeded the bounded test window (${elapsedMs}ms)`,
  );
  assert.match(
    `${hungPreflight.stdout}\n${hungPreflight.stderr}`,
    /outer wall-clock cap expired during API suite-floor preflight/,
    "hung preflight must identify setup ownership in its timeout diagnostic",
  );
  assert.match(
    `${hungPreflight.stdout}\n${hungPreflight.stderr}`,
    /PREFLIGHT_REPORT phase="API suite-floor preflight" status=TIMED_OUT exit-status=124 timeout=true suite-started=false/,
    "hung preflight must report phase, timeout status, exit status, and that suites did not start",
  );
  assert.match(
    `${hungPreflight.stdout}\n${hungPreflight.stderr}`,
    /Validation Setup Summary[\s\S]*SETUP_TIMED_OUT[\s\S]*child-status=124\s+timeout=true\s+suite-started=false/,
    "timed-out preflight failures must remain visible in the validation setup summary",
  );

  const pids = readFileSync(preflightPidFile, "utf8")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
  assert.equal(pids.length, 2, "hung preflight fixture must record its process and child");
  for (const pid of pids) {
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (error) {
      assert.equal(error.code, "ESRCH", `unexpected PID probe error for ${pid}`);
    }
    assert.equal(alive, false, `timed-out preflight left process ${pid} alive`);
  }
} finally {
  rmSync(hungPreflightFixtureDir, { recursive: true, force: true });
}

const failedPreflightFixtureDir = mkdtempSync(
  join(tmpdir(), "test-all-preflight-failure-contract-"),
);
const failedPreflightBinDir = join(failedPreflightFixtureDir, "bin");
const failedPreflightPnpm = join(failedPreflightBinDir, "pnpm");
const failedPreflightNode = join(failedPreflightBinDir, "node");
const suiteStartedFile = join(failedPreflightFixtureDir, "suite-started");
mkdirSync(failedPreflightBinDir, { recursive: true });
writeFileSync(
  failedPreflightPnpm,
  [
    "#!/usr/bin/env bash",
    'if [[ " $* " == *" run test "* || " $* " == *" exec vitest "* ]]; then',
    '  printf "suite\\n" >> "$TEST_ALL_SUITE_STARTED_FILE"',
    "fi",
    "exit 0",
    "",
  ].join("\n"),
  { mode: 0o755 },
);
writeFileSync(
  failedPreflightNode,
  [
    "#!/usr/bin/env bash",
    'if [[ "${1:-}" == "scripts/test/api-suite-floor-contract.test.mjs" ]]; then',
    '  echo "synthetic API suite-floor failure" >&2',
    "  exit 7",
    "fi",
    'exec "$TEST_ALL_REAL_NODE" "$@"',
    "",
  ].join("\n"),
  { mode: 0o755 },
);

try {
  const startedAt = Date.now();
  const failedPreflight = spawnSync("bash", [testAllScript], {
    cwd: root,
    encoding: "utf8",
    timeout: 5_000,
    env: {
      ...process.env,
      PATH: `${failedPreflightBinDir}:${process.env.PATH}`,
      SERIAL_LOCK_HELD_RESOURCES: "shared-test-results",
      TEST_ALL_REAL_NODE: process.execPath,
      TEST_ALL_SUITE_STARTED_FILE: suiteStartedFile,
      TEST_ALL_TOTAL_BUDGET_SECONDS: "10",
      TEST_ALL_WATCHDOG_GRACE_SECONDS: "1",
    },
  });
  const elapsedMs = Date.now() - startedAt;
  const output = `${failedPreflight.stdout}\n${failedPreflight.stderr}`;

  assert.equal(
    failedPreflight.status,
    7,
    `failed preflight should return ordinary failure status; output:\n${output}`,
  );
  assert(
    elapsedMs < 5_000,
    `failed preflight exceeded the bounded test window (${elapsedMs}ms)`,
  );
  assert.match(
    output,
    /API suite-floor preflight failed \(exit code 7\)/,
    "ordinary preflight failures must identify the API suite-floor phase and exit code",
  );
  assert.match(
    output,
    /PREFLIGHT_REPORT phase="API suite-floor preflight" status=FAILED exit-status=7 timeout=false suite-started=false/,
    "ordinary preflight failures must report phase, status, exit status, and that suites did not start",
  );
  assert.match(
    output,
    /Validation Setup Summary[\s\S]*SETUP_FAILED[\s\S]*child-status=7\s+timeout=false\s+suite-started=false/,
    "ordinary preflight failures must remain visible in the validation setup summary",
  );
  assert.doesNotMatch(
    output,
    /outer wall-clock cap expired during API suite-floor preflight/,
    "a non-timeout preflight failure must not use the timeout diagnostic",
  );
  assert.equal(
    existsSync(suiteStartedFile),
    false,
    "package suites must not start after an API suite-floor preflight failure",
  );
} finally {
  rmSync(failedPreflightFixtureDir, { recursive: true, force: true });
}

const failedCodegenFixtureDir = mkdtempSync(
  join(tmpdir(), "test-all-codegen-preflight-failure-contract-"),
);
const failedCodegenBinDir = join(failedCodegenFixtureDir, "bin");
const failedCodegenPnpm = join(failedCodegenBinDir, "pnpm");
const failedCodegenNode = join(failedCodegenBinDir, "node");
const codegenSuiteStartedFile = join(failedCodegenFixtureDir, "suite-started");
mkdirSync(failedCodegenBinDir, { recursive: true });
writeFileSync(
  failedCodegenPnpm,
  [
    "#!/usr/bin/env bash",
    'if [[ " $* " == *" run codegen:ensure "* ]]; then',
    '  echo "synthetic codegen preflight failure" >&2',
    "  exit 7",
    "fi",
    'if [[ " $* " == *" run test "* || " $* " == *" exec vitest "* ]]; then',
    '  printf "suite\\n" >> "$TEST_ALL_SUITE_STARTED_FILE"',
    "fi",
    "exit 0",
    "",
  ].join("\n"),
  { mode: 0o755 },
);
writeFileSync(
  failedCodegenNode,
  [
    "#!/usr/bin/env bash",
    'exec "$TEST_ALL_REAL_NODE" "$@"',
    "",
  ].join("\n"),
  { mode: 0o755 },
);

try {
  const startedAt = Date.now();
  const failedCodegen = spawnSync("bash", [testAllScript], {
    cwd: root,
    encoding: "utf8",
    timeout: 5_000,
    env: {
      ...process.env,
      PATH: `${failedCodegenBinDir}:${process.env.PATH}`,
      SERIAL_LOCK_HELD_RESOURCES: "shared-test-results",
      TEST_ALL_REAL_NODE: process.execPath,
      TEST_ALL_SUITE_STARTED_FILE: codegenSuiteStartedFile,
      TEST_ALL_TOTAL_BUDGET_SECONDS: "10",
      TEST_ALL_WATCHDOG_GRACE_SECONDS: "1",
    },
  });
  const elapsedMs = Date.now() - startedAt;
  const output = `${failedCodegen.stdout}\n${failedCodegen.stderr}`;

  assert.equal(
    failedCodegen.status,
    7,
    `failed codegen preflight should preserve its ordinary status; output:\n${output}`,
  );
  assert(
    elapsedMs < 5_000,
    `failed codegen preflight exceeded the bounded test window (${elapsedMs}ms)`,
  );
  assert.match(
    output,
    /codegen:ensure preflight failed \(exit code 7\)/,
    "ordinary codegen failures must identify the codegen preflight phase and exit code",
  );
  assert.match(
    output,
    /PREFLIGHT_REPORT phase="codegen:ensure preflight" status=FAILED exit-status=7 timeout=false suite-started=false/,
    "ordinary codegen failures must report phase, status, exit status, and that suites did not start",
  );
  assert.match(
    output,
    /Validation Setup Summary[\s\S]*SETUP_FAILED[\s\S]*child-status=7\s+timeout=false\s+suite-started=false/,
    "ordinary codegen failures must remain visible in the validation setup summary",
  );
  assert.doesNotMatch(
    output,
    /outer wall-clock cap expired during codegen:ensure preflight/,
    "a non-timeout codegen failure must not use the timeout diagnostic",
  );
  assert.equal(
    existsSync(codegenSuiteStartedFile),
    false,
    "package suites must not start after a codegen preflight failure",
  );
} finally {
  rmSync(failedCodegenFixtureDir, { recursive: true, force: true });
}

const canonicalTierFixtureDir = mkdtempSync(
  join(tmpdir(), "validation-tier-setup-report-contract-"),
);
// Allow canonical tier startup and the inner 1s watchdog + 1s cleanup grace
// to finish under load; the outer deadline remains a finite fixture bound.
const CANONICAL_TIER_FIXTURE_TIMEOUT_MS = 20_000;
const canonicalTierBinDir = join(canonicalTierFixtureDir, "bin");
const canonicalTierPnpm = join(canonicalTierBinDir, "pnpm");
const canonicalTierNode = join(canonicalTierBinDir, "node");
const canonicalTierBash = join(canonicalTierBinDir, "bash");
const canonicalTierSuiteStartedFile = join(canonicalTierFixtureDir, "suite-started");
const canonicalTierPidFile = join(canonicalTierFixtureDir, "preflight-pids.txt");
mkdirSync(canonicalTierBinDir, { recursive: true });
writeFileSync(
  canonicalTierPnpm,
  [
    "#!/usr/bin/env bash",
    'if [[ "${1:-}" == "test" ]]; then',
    '  exec bash "$TEST_ALL_SCRIPT"',
    "fi",
    "exit 0",
    "",
  ].join("\n"),
  { mode: 0o755 },
);
writeFileSync(
  canonicalTierBash,
  [
    "#!/usr/bin/bash",
    'if [[ "${1:-}" == "-c" && "${2:-}" == *"scripts/check-light-mode-config.sh"* ]]; then',
    "  exit 0",
    "fi",
    'exec "$TEST_ALL_REAL_BASH" "$@"',
    "",
  ].join("\n"),
  { mode: 0o755 },
);
writeFileSync(
  canonicalTierNode,
  [
    "#!/usr/bin/env bash",
    'if [[ "${1:-}" == "scripts/test/api-suite-floor-contract.test.mjs" && -n "${VALIDATION_SETUP_REPORT_FILE:-}" ]]; then',
    '  if [[ "$TEST_ALL_SETUP_MODE" == "timeout" ]]; then',
    '    echo "$$" > "$TEST_ALL_PREFLIGHT_PID_FILE"',
    "    sleep 60 &",
    '    echo "$!" >> "$TEST_ALL_PREFLIGHT_PID_FILE"',
    "    wait",
    "  fi",
    '  echo "synthetic API suite-floor failure" >&2',
    "  exit 7",
    "fi",
    'if [[ "${1:-}" == "scripts/test/api-suite-floor-contract.test.mjs" ]]; then',
    '  exec "$TEST_ALL_REAL_NODE" "$@"',
    "fi",
    'if [[ "${1:-}" == "scripts/serial-lock.mjs" && " $* " == *" --resource shared-test-results "* ]]; then',
    '  exec "$TEST_ALL_REAL_NODE" "$@"',
    "fi",
    "exit 0",
    "",
  ].join("\n"),
  { mode: 0o755 },
);

function runCanonicalTierSetupFixture(mode) {
  // This is an ad-hoc standard-tier fixture, not the enclosing fast-tier task run.
  const fixtureEnv = { ...process.env };
  delete fixtureEnv.TASK_PLAN_FILE;
  return spawnSync(process.execPath, ["scripts/run-tier.mjs", "standard", "--allow-no-plan"], {
    cwd: root,
    encoding: "utf8",
    timeout: CANONICAL_TIER_FIXTURE_TIMEOUT_MS,
    env: {
      ...fixtureEnv,
      PATH: `${canonicalTierBinDir}:${process.env.PATH}`,
      TEST_ALL_SCRIPT: testAllScript,
      TEST_ALL_REAL_BASH: "/usr/bin/bash",
      TEST_ALL_REAL_NODE: process.execPath,
      TEST_ALL_SETUP_MODE: mode,
      TEST_ALL_PREFLIGHT_PID_FILE: canonicalTierPidFile,
      TEST_ALL_SUITE_STARTED_FILE: canonicalTierSuiteStartedFile,
      TEST_ALL_TOTAL_BUDGET_SECONDS: mode === "timeout" ? "1" : "10",
      TEST_ALL_WATCHDOG_GRACE_SECONDS: "1",
      SERIAL_LOCK_HELD_RESOURCES: "validation",
    },
  });
}

function canonicalPreflightPids() {
  if (!existsSync(canonicalTierPidFile)) return [];
  return readFileSync(canonicalTierPidFile, "utf8")
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

function fixtureProcessRunning(pid) {
  let stat;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  const stateStart = stat.lastIndexOf(") ") + 2;
  const state = stat.slice(stateStart, stateStart + 1);
  assert.match(state, /^[A-Z]$/, `cannot inspect preflight process ${pid}`);
  if (state === "Z" || state === "X") return false;

  try {
    return readFileSync(`/proc/${pid}/environ`, "utf8")
      .split("\0")
      .includes(`TEST_ALL_PREFLIGHT_PID_FILE=${canonicalTierPidFile}`);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

try {
  const ordinaryStartedAt = Date.now();
  const ordinaryTier = runCanonicalTierSetupFixture("ordinary");
  const ordinaryElapsedMs = Date.now() - ordinaryStartedAt;
  const ordinaryOutput = `${ordinaryTier.stdout}\n${ordinaryTier.stderr}`;
  assert.equal(
    ordinaryTier.status,
    1,
    `canonical tier must remain unsuccessful for ordinary setup failure; output:\n${ordinaryOutput}`,
  );
  assert(
    ordinaryElapsedMs < CANONICAL_TIER_FIXTURE_TIMEOUT_MS,
    `canonical ordinary setup fixture exceeded its bounded test window (${ordinaryElapsedMs}ms)`,
  );
  assert.match(
    ordinaryOutput,
    /━━━ \[run-tier\] standard tier report ━━━[\s\S]*FAILED\s+test/,
    "the canonical tier report must identify the failed package-test step",
  );
  assert.match(
    ordinaryOutput,
    /Validation Setup Summary[\s\S]*SETUP_FAILED\s+API suite-floor preflight[\s\S]*exit-status=7\s+child-status=7\s+timeout=false\s+suite-started=false/,
    "the canonical tier report must preserve ordinary setup evidence",
  );
  assert.match(
    ordinaryOutput,
    /PREFLIGHT_REPORT phase="API suite-floor preflight" status=FAILED exit-status=7 timeout=false suite-started=false child-status=7/,
    "ordinary setup failure must report its distinct preflight outcome",
  );
  assert.doesNotMatch(
    ordinaryOutput,
    /SETUP_TIMED_OUT\s+API suite-floor preflight/,
    "an ordinary setup failure must not be classified as a timeout",
  );
  assert.doesNotMatch(
    ordinaryOutput,
    /PASSED\s+(?:mockup-sandbox|parts-id|api-server)\s+\(/,
    "ordinary setup failure must not report a package suite as passed",
  );
  assert.equal(
    existsSync(canonicalTierSuiteStartedFile),
    false,
    "ordinary setup failure must stop before package suites start",
  );

  const timeoutStartedAt = Date.now();
  const timeoutTier = runCanonicalTierSetupFixture("timeout");
  const timeoutElapsedMs = Date.now() - timeoutStartedAt;
  const timeoutOutput = `${timeoutTier.stdout}\n${timeoutTier.stderr}`;
  assert.equal(
    timeoutTier.status,
    1,
    `canonical tier must remain unsuccessful for timeout setup failure; output:\n${timeoutOutput}`,
  );
  assert(
    timeoutElapsedMs < CANONICAL_TIER_FIXTURE_TIMEOUT_MS,
    `canonical timeout setup fixture exceeded its bounded test window (${timeoutElapsedMs}ms)`,
  );
  assert.match(
    timeoutOutput,
    /FAILED\s+test[\s\S]*Validation Setup Summary[\s\S]*SETUP_TIMED_OUT\s+API suite-floor preflight[\s\S]*exit-status=124\s+child-status=124\s+timeout=true\s+suite-started=false/,
    "the canonical tier report must preserve timeout setup evidence",
  );
  assert.match(
    timeoutOutput,
    /PREFLIGHT_REPORT phase="API suite-floor preflight" status=TIMED_OUT exit-status=124 timeout=true suite-started=false child-status=124/,
    "timed-out setup must report its distinct preflight outcome",
  );
  assert.doesNotMatch(
    timeoutOutput,
    /SETUP_FAILED\s+API suite-floor preflight/,
    "a timed-out setup must not be classified as an ordinary failure",
  );
  assert.doesNotMatch(
    timeoutOutput,
    /PASSED\s+(?:mockup-sandbox|parts-id|api-server)\s+\(/,
    "timeout setup failure must not report a package suite as passed",
  );
  assert.equal(
    existsSync(canonicalTierSuiteStartedFile),
    false,
    "timeout setup failure must stop before package suites start",
  );
  const recordedPids = canonicalPreflightPids();
  assert.equal(recordedPids.length, 2, "canonical timeout fixture must record its preflight and descendant");
  assert.notEqual(recordedPids[0], recordedPids[1], "preflight and descendant must be distinct");
  const cleanupDeadline = Date.now() + 2_000;
  while (recordedPids.some(fixtureProcessRunning) && Date.now() < cleanupDeadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  for (const pid of recordedPids) {
    assert.equal(fixtureProcessRunning(pid), false, `canonical timeout left preflight process ${pid} running`);
  }
} finally {
  // If a report assertion fails, do not leave the synthetic 60-second descendant running.
  try {
    for (const pid of canonicalPreflightPids().reverse()) {
      if (fixtureProcessRunning(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
    }
  } finally {
    rmSync(canonicalTierFixtureDir, { recursive: true, force: true });
  }
}

console.log("Validation runtime contract: test database mode and Node declarations are aligned");