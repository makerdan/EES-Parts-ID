#!/usr/bin/env node
/**
 * Keep the CI parity report's nested test coverage synchronized with the
 * executable root test harness and the validation-tier registry.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { getTierSteps } from "../validation-steps.mjs";

const root = resolve(".");
const harness = readFileSync(resolve(root, "scripts/test-all.sh"), "utf8");
const parityReport = readFileSync(
  resolve(root, "docs/validation/ci-validation-parity.md"),
  "utf8",
);
const testCoverageRow = parityReport
  .split(/\r?\n/)
  .find((line) => line.startsWith("| `test` |"));
const suiteFloorCoverageRow = parityReport
  .split(/\r?\n/)
  .find((line) => line.startsWith("| `api-suite-floor-contract` |"));

assert.ok(testCoverageRow, 'parity report is missing the "`test`" coverage entry');
assert.ok(
  suiteFloorCoverageRow,
  'parity report is missing the standalone "`api-suite-floor-contract`" coverage entry',
);

function assertRepresented(source, expected, description) {
  assert(
    source.includes(expected),
    `${description} is missing from the CI parity report or executable harness: ${expected}`,
  );
}

const codegenPreflight = "pnpm --filter @workspace/api-spec run codegen:ensure";
const suiteFloorCommand = "node scripts/test/api-suite-floor-contract.test.mjs";
const timeoutReport = "node scripts/test-timeout-report.mjs /tmp/jest-run-manifest.json";
const suiteDefinitions = [
  ["mockup-sandbox", "./artifacts/mockup-sandbox", "180", "vitest"],
  ["parts-id", "./artifacts/parts-id", "300", "jest"],
  ["api-server", "./artifacts/api-server", "240", "jest"],
];

assertRepresented(harness, codegenPreflight, "codegen preflight");
assertRepresented(testCoverageRow, codegenPreflight, "codegen preflight coverage");

assertRepresented(harness, suiteFloorCommand, "nested API suite-floor preflight");
assertRepresented(testCoverageRow, suiteFloorCommand, "nested API suite-floor coverage");

for (const [name, filter, budget, runner] of suiteDefinitions) {
  const definition = `"${name}:${filter}:${budget}:${runner}"`;
  assertRepresented(harness, definition, `${name} suite definition`);
  assertRepresented(
    testCoverageRow,
    `${name === "mockup-sandbox" ? "Canvas Vitest" : name === "parts-id" ? "Parts ID Jest" : "API Server Jest"} (\`${budget}s\`)`,
    `${name} timeout-wrapped coverage`,
  );
}

assertRepresented(harness, 'run_owned "suite ${name}" timeout --kill-after=15s "${budget}s"', "timeout-wrapped suite execution");
assertRepresented(testCoverageRow, "timeout-wrapped", "timeout-wrapped suite coverage");
assertRepresented(
  harness,
  'node scripts/test-timeout-report.mjs "$MANIFEST_FILE"',
  "timeout-report post-processing",
);
assertRepresented(testCoverageRow, timeoutReport, "timeout-report post-processing coverage");

const standardPlusSteps = getTierSteps("standard-plus");
const standaloneSuiteFloor = standardPlusSteps.find(
  ([name]) => name === "api-suite-floor-contract",
);
assert.deepEqual(
  standaloneSuiteFloor,
  ["api-suite-floor-contract", suiteFloorCommand],
  "the API suite-floor command must remain a standalone standard-plus tier member",
);
assertRepresented(
  suiteFloorCoverageRow,
  suiteFloorCommand,
  "standalone API suite-floor coverage",
);
assert(
  /its second execution inside `scripts\/test-all\.sh`\s+is required nested harness coverage, not an additional tier member/.test(
    parityReport,
  ),
  "parity report must distinguish the standalone suite-floor tier member from its nested harness invocation",
);

assertRepresented(
  standardPlusSteps
    .filter(([name, command]) => name === "ci-validation-parity-contract")
    .map(([, command]) => command)
    .join("\n"),
  "node scripts/test/ci-validation-parity-contract.test.mjs",
  "parity contract tier registration",
);
assertRepresented(
  parityReport,
  "| `ci-validation-parity-contract` | canonical portable path → `node scripts/test/ci-validation-parity-contract.test.mjs` | direct contract | inferred |",
  "parity contract documentation",
);

console.log(
  "CI validation parity contract: test harness preflights, suite legs, post-processing, and tier distinction are mapped",
);