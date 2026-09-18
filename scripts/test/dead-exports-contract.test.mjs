#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const runner = join(root, "scripts", "check-dead-exports.mjs");
const fixture = mkdtempSync(join(tmpdir(), "dead-exports-contract-"));

try {
  writeFileSync(
    join(fixture, "package.json"),
    JSON.stringify({
      name: "@contract/dead-exports-fixture",
      private: true,
      type: "module",
      knip: {
        entry: ["index.js"],
        project: ["**/*.js"],
      },
    }),
  );
  writeFileSync(join(fixture, "index.js"), "console.log('entry');\n");
  writeFileSync(
    join(fixture, "unused.js"),
    "export function deliberatelyUnusedExport() {}\n",
  );

  const result = spawnSync(
    process.execPath,
    [runner, "--package-dir", fixture],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  const attribution = "dead-exports — checking @contract/dead-exports-fixture";
  const finding = "Unused files (1)";

  assert.equal(result.status, 1, "a Knip finding must fail dead-export validation");
  assert.match(output, new RegExp(attribution.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(output, /Unused files \(1\)\s+unused\.js/);
  assert.ok(
    output.indexOf(attribution) < output.indexOf(finding),
    "package attribution must precede the Knip report",
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.log("Dead-export contract: package attribution and failure propagation verified");