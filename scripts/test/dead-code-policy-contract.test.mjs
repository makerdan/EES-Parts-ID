#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../..", import.meta.url));
const scriptsDir = join(root, "scripts");
const manifest = JSON.parse(
  readFileSync(join(scriptsDir, "package.json"), "utf8"),
);
const policy = manifest.deadCodePolicy;

assert.equal(
  policy?.mode,
  "excluded",
  "scripts must declare an explicit dead-code exclusion policy",
);
assert.match(
  policy.reason,
  /command entrypoints.*generated validation helpers/i,
  "the exclusion policy must document why the scripts workspace is outside Knip",
);
for (const coveredPath of [
  "src/**/*.ts",
  "test/**/*.ts",
  "lib/**/*.mjs",
  "*.mjs",
  "*.sh",
]) {
  assert.ok(
    policy.coveredPaths.includes(coveredPath),
    `dead-code policy must cover ${coveredPath}`,
  );
}

const runner = join(scriptsDir, "check-dead-exports.mjs");
const result = spawnSync(process.execPath, [runner, "--package-dir", scriptsDir], {
  cwd: root,
  encoding: "utf8",
});
const output = `${result.stdout}\n${result.stderr}`;
assert.equal(
  result.status,
  0,
  "the scripts workspace exclusion contract must be accepted by the checker",
);
assert.match(
  output,
  /dead-exports — excluding @workspace\/scripts:/,
  "the checker must report the deliberate scripts exclusion",
);

console.log(
  "Dead-code policy contract: scripts exclusion and coverage declarations verified",
);