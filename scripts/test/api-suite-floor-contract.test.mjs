import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { hasExplicitTestFilter, getSuiteFloor, violatesSuiteFloor } from "../../artifacts/api-server/scripts/run-tests.mjs";

assert.equal(hasExplicitTestFilter(["__tests__/inventory.test.ts"]), true);
assert.equal(hasExplicitTestFilter(["--testNamePattern=returns inventory"]), true);
assert.equal(hasExplicitTestFilter(["--testNamePattern", "returns inventory"]), true);
assert.equal(hasExplicitTestFilter(["--config", "jest.config.cjs", "--runInBand"]), false);

const fullRunFloor = getSuiteFloor({ discoveredCount: 100, focused: false });
assert.equal(fullRunFloor, 85);
assert.equal(violatesSuiteFloor({ ran: 84, suiteFloor: fullRunFloor }), true);
assert.equal(violatesSuiteFloor({ ran: 85, suiteFloor: fullRunFloor }), false);

const focusedRunFloor = getSuiteFloor({ discoveredCount: 100, focused: true });
assert.equal(focusedRunFloor, null);
assert.equal(violatesSuiteFloor({ ran: 0, suiteFloor: focusedRunFloor }), false);

const require = createRequire(import.meta.url);
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const apiServerRoot = join(repositoryRoot, "artifacts/api-server");
const apiIntegrationTestRoot = join(apiServerRoot, "__tests__");
const jestConfig = require(join(apiServerRoot, "jest.config.cjs"));
const serialProject = jestConfig.projects?.find(({ displayName }) => displayName === "db-serial");
const parallelProject = jestConfig.projects?.find(({ displayName }) => displayName === "parallel");

assert.ok(serialProject, "Jest config must define a db-serial project");
assert.ok(parallelProject, "Jest config must define a parallel project");
assert.equal(
  serialProject.maxWorkers,
  1,
  "The db-serial Jest project must keep maxWorkers: 1 for globally ordered floor-plan metadata.",
);

function discoverFloorPlanWriters() {
  return readdirSync(apiIntegrationTestRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".integration.test.ts"))
    .filter((entry) => {
      const source = readFileSync(join(apiIntegrationTestRoot, entry.name), "utf8");
      return /\b(?:insert|update|delete)\s*\(\s*floorPlanMetaTable\b/.test(source);
    })
    .map((entry) => relative(apiServerRoot, join(apiIntegrationTestRoot, entry.name)));
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
const missingSerialIsolation = floorPlanWriters.filter((testPath) => !serialPaths.has(testPath));
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
  return !parallelIgnores.some((pattern) => matchesJestPathPattern(pattern, fileName));
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

console.log("API suite-floor contract: focused and full-run guard behavior passed");
console.log(`Floor-plan serial contract: ${floorPlanWriters.length} metadata writer suites isolated`);