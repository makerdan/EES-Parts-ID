#!/usr/bin/env node
/**
 * Contract coverage for the validation runner's database mode and Node
 * runtime declarations. Keep these checks side-effect free and portable so
 * they can run before the database-backed test step.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { getTierSteps } from "../validation-steps.mjs";

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
const testStep = standardSteps.find(([name]) => name === "test");
assert.ok(testStep, "standard validation must define a database-backed test step");
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
assert.deepEqual(
  fastSteps.find(([name]) => name === "port-authority-contract"),
  ["port-authority-contract", "node scripts/test-port-authority.mjs"],
  "test-fast must keep the focused Port Authority contract reachable",
);

for (const [tier, priority] of [
  ["fast", 1],
  ["standard", 2],
  ["standard-plus", 2],
  ["heavy", 3],
]) {
  assert.equal(
    packageJson.scripts?.[`test-${tier}`],
    `node scripts/serial-lock.mjs --resource validation --priority ${priority} -- node scripts/run-tier.mjs ${tier} --allow-no-plan`,
    `test-${tier} must remain executable through the documented lock priority scale`,
  );
}

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

console.log("Validation runtime contract: test database mode and Node declarations are aligned");