import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  hasExplicitTestFilter,
  getSuiteFloor,
  violatesSuiteFloor,
} from "../../artifacts/api-server/scripts/run-tests.mjs";
import {
  hasExplicitTestFilter as hasPartsIdTestFilter,
  normalizeForwardedArgs as normalizePartsIdArgs,
} from "../../artifacts/parts-id/scripts/run-tests.mjs";
import { validateTestResultArtifact } from "../../scripts/test-result-artifact.mjs";

assert.equal(hasExplicitTestFilter(["__tests__/inventory.test.ts"]), true);
assert.equal(
  hasExplicitTestFilter(["--testNamePattern=returns inventory"]),
  true,
);
assert.equal(
  hasExplicitTestFilter(["--testNamePattern", "returns inventory"]),
  true,
);
assert.equal(
  hasExplicitTestFilter(["--config", "jest.config.cjs", "--runInBand"]),
  false,
);

const focusedPartsIdArgs = [
  "--runTestsByPath",
  "components/__tests__/sizeLabel.test.ts",
];
for (const rawArgs of [focusedPartsIdArgs, ["--", ...focusedPartsIdArgs]]) {
  const { forwarded } = normalizePartsIdArgs(rawArgs);
  assert.deepEqual(forwarded, focusedPartsIdArgs);
  assert.equal(
    hasPartsIdTestFilter(forwarded),
    true,
    "Parts ID must disable only the full-run suite floor for pnpm-focused runs",
  );
}
assert.equal(
  hasPartsIdTestFilter(normalizePartsIdArgs(["--runInBand"]).forwarded),
  false,
  "Parts ID full runs must retain the suite-count floor",
);

const fullRunFloor = getSuiteFloor({ discoveredCount: 100, focused: false });
assert.equal(fullRunFloor, 85);
assert.equal(violatesSuiteFloor({ ran: 84, suiteFloor: fullRunFloor }), true);
assert.equal(violatesSuiteFloor({ ran: 85, suiteFloor: fullRunFloor }), false);

const focusedRunFloor = getSuiteFloor({ discoveredCount: 100, focused: true });
assert.equal(focusedRunFloor, null);
assert.equal(
  violatesSuiteFloor({ ran: 0, suiteFloor: focusedRunFloor }),
  false,
);

const resultShape = {
  numTotalTestSuites: 1,
  numPassedTestSuites: 1,
  numFailedTestSuites: 0,
  numPendingTestSuites: 0,
  numRuntimeErrorTestSuites: 0,
  numTotalTests: 1,
  numPassedTests: 1,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  testResults: [
    {
      testFilePath: "contract.test.ts",
      testResults: [{ status: "passed", title: "executes" }],
    },
  ],
};
assert.deepEqual(validateTestResultArtifact(resultShape), {
  ok: true,
  executedTestCount: 1,
  pendingTestCount: 0,
  hasFailures: false,
  isPassing: true,
});

const emptyResult = {
  ...resultShape,
  numTotalTestSuites: 0,
  numPassedTestSuites: 0,
  numTotalTests: 0,
  numPassedTests: 0,
  testResults: [],
};
assert.equal(validateTestResultArtifact(emptyResult).executedTestCount, 0);

const allPendingResult = {
  ...resultShape,
  numPassedTestSuites: 0,
  numPendingTestSuites: 1,
  numPassedTests: 0,
  numPendingTests: 1,
  testResults: [
    {
      testFilePath: "contract.test.ts",
      testResults: [{ status: "pending", title: "does not execute" }],
    },
  ],
};
assert.equal(validateTestResultArtifact(allPendingResult).executedTestCount, 0);
assert.equal(validateTestResultArtifact(allPendingResult).pendingTestCount, 1);
assert.equal(
  validateTestResultArtifact({ ...resultShape, numTotalTests: "1" }).ok,
  false,
  "schema-invalid result artifacts must be rejected",
);
assert.equal(
  validateTestResultArtifact({
    ...resultShape,
    numFailedTests: 1,
  }).ok,
  false,
  "result artifacts with contradictory aggregate assertion metadata must be rejected",
);

const require = createRequire(import.meta.url);
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const apiServerRoot = join(repositoryRoot, "artifacts/api-server");
const guardSources = [
  readFileSync(
    join(repositoryRoot, "artifacts/parts-id/scripts/run-tests.mjs"),
    "utf8",
  ),
  readFileSync(
    join(repositoryRoot, "artifacts/api-server/scripts/run-tests.mjs"),
    "utf8",
  ),
];
for (const source of guardSources) {
  assert.match(
    source,
    /no tests executed/,
    "artifact wrappers must reject setup failures, empty suites, and all-pending suites",
  );
  assert.match(
    source,
    /exitAfterCopy = true/,
    "caller-output copy failures must make the wrapper fail",
  );
  assert.match(
    source,
    /const ran = numPassedTestSuites \+ numFailedTestSuites;/,
    "pending suites must not satisfy the suite floor",
  );
  assert.match(
    source,
    /const focused = hasExplicitTestFilter\(forwarded\);/,
    "full-run floors must not reject intentionally focused runs",
  );
}
const apiIntegrationTestRoot = join(apiServerRoot, "__tests__");
const jestConfigPath = join(apiServerRoot, "jest.config.cjs");
const jestConfig = require(jestConfigPath);
const serialProject = jestConfig.projects?.find(
  ({ displayName }) => displayName === "db-serial",
);
const parallelProject = jestConfig.projects?.find(
  ({ displayName }) => displayName === "parallel",
);

assert.ok(serialProject, "Jest config must define a db-serial project");
assert.ok(parallelProject, "Jest config must define a parallel project");
assert.equal(
  serialProject.maxWorkers,
  1,
  "The db-serial Jest project must keep maxWorkers: 1 for globally ordered floor-plan metadata.",
);

function discoverFloorPlanWriters() {
  return readdirSync(apiIntegrationTestRoot, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".integration.test.ts"),
    )
    .filter((entry) => {
      const source = readFileSync(
        join(apiIntegrationTestRoot, entry.name),
        "utf8",
      );
      return /\b(?:insert|update|delete)\s*\(\s*floorPlanMetaTable\b/.test(
        source,
      );
    })
    .map((entry) =>
      relative(apiServerRoot, join(apiIntegrationTestRoot, entry.name)),
    );
}

function configuredSerialPaths(project) {
  return new Set(
    (project.testMatch ?? [])
      .filter((pattern) => typeof pattern === "string")
      .map((pattern) => pattern.replace(/^<rootDir>\//, "")),
  );
}

function configuredParallelIgnores(project) {
  return (project.testPathIgnorePatterns ?? []).filter(
    (pattern) => typeof pattern === "string",
  );
}

function liveProviderIgnorePatterns(optIn) {
  const env = { ...process.env };
  if (optIn) env.POE_LIVE_PROVIDER = "1";
  else delete env.POE_LIVE_PROVIDER;
  const probe = [
    `const config = require(${JSON.stringify(jestConfigPath)});`,
    'const project = config.projects.find(({ displayName }) => displayName === "parallel");',
    "process.stdout.write(JSON.stringify(project.testPathIgnorePatterns));",
  ].join("\n");
  const result = spawnSync(process.execPath, ["-e", probe], {
    cwd: repositoryRoot,
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function matchesJestPathPattern(pattern, value) {
  const source = pattern.replace(/^\/+/, "");
  return new RegExp(source).test(value);
}

const floorPlanWriters = discoverFloorPlanWriters();
assert.ok(
  floorPlanWriters.length > 0,
  "Floor-plan writer discovery found no integration suites; update the guard if the fixture API changes.",
);

const serialPaths = configuredSerialPaths(serialProject);
const parallelIgnores = configuredParallelIgnores(parallelProject);
const missingSerialIsolation = floorPlanWriters.filter(
  (testPath) => !serialPaths.has(testPath),
);
assert.deepEqual(
  missingSerialIsolation,
  [],
  [
    "Floor-plan integration suites that mutate floor_plan_meta must run in the db-serial Jest project.",
    `Missing serial entries: ${missingSerialIsolation.join(", ") || "(none)"}`,
    "Add each missing path to db-serial.testMatch and its matching pattern to parallel.testPathIgnorePatterns in artifacts/api-server/jest.config.cjs.",
  ].join("\n"),
);

const parallelLeaks = floorPlanWriters.filter((testPath) => {
  const fileName = testPath.split("/").at(-1);
  return !parallelIgnores.some((pattern) =>
    matchesJestPathPattern(pattern, fileName),
  );
});
assert.deepEqual(
  parallelLeaks,
  [],
  [
    "Floor-plan integration suites that mutate floor_plan_meta must be excluded from the parallel Jest project.",
    `Parallel leaks: ${parallelLeaks.join(", ") || "(none)"}`,
    "Add each missing file-name pattern to parallel.testPathIgnorePatterns in artifacts/api-server/jest.config.cjs.",
  ].join("\n"),
);

const liveTestIgnore = "poeModelName\\.live\\.test\\.ts";
assert(
  liveProviderIgnorePatterns(false).some((pattern) =>
    pattern.includes(liveTestIgnore),
  ),
  "Portable API validation must ignore the live Poe provider suite by default.",
);
assert(
  !liveProviderIgnorePatterns(true).some((pattern) =>
    pattern.includes(liveTestIgnore),
  ),
  "The explicit live provider mode must include the Poe provider suite.",
);

console.log(
  "API suite-floor contract: focused and full-run guard behavior passed",
);
console.log(
  `Floor-plan serial contract: ${floorPlanWriters.length} metadata writer suites isolated`,
);
