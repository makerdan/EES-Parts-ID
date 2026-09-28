#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

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
const workspaceFixture = mkdtempSync(join(root, ".dead-exports-workspace-"));
const workspaceConfig = join(workspaceFixture, "pnpm-workspace.yaml");

try {
  const result = spawnSync(
    process.execPath,
    [runner, "--package-dir", scriptsDir],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
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

  writeFileSync(
    join(workspaceFixture, "package.json"),
    JSON.stringify({
      name: "@contract/unconfigured-workspace-package",
      private: true,
      type: "module",
    }),
  );
  writeFileSync(
    workspaceConfig,
    `packages:\n  - ${relative(root, workspaceFixture)}\n`,
  );
  const workspaceDiscovery = spawnSync(
    process.execPath,
    [runner, "--workspace-config", workspaceConfig],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  const workspaceDiscoveryOutput = `${workspaceDiscovery.stdout}\n${workspaceDiscovery.stderr}`;
  assert.equal(
    workspaceDiscovery.status,
    1,
    "a package newly declared by the workspace configuration must be checked",
  );
  assert.match(
    workspaceDiscoveryOutput,
    /@contract\/unconfigured-workspace-package has no explicit dead-code policy/,
    "new workspace packages must fail closed when their policy is missing",
  );
} finally {
  rmSync(workspaceFixture, { recursive: true, force: true });
}

console.log(
  "Dead-code policy contract: workspace discovery and scripts exclusion verified",
);
