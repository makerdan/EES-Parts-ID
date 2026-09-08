#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPLIT_PATH = resolve(ROOT, ".replit");

function parseToml(source, label) {
  const result = spawnSync(
    "python3",
    [
      "-c",
      [
        "import json, sys, tomllib",
        "try:",
        "    parsed = tomllib.loads(sys.stdin.read())",
        "except tomllib.TOMLDecodeError as error:",
        "    print(f'TOML parse error: {error}', file=sys.stderr)",
        "    raise SystemExit(2)",
        "json.dump(parsed, sys.stdout)",
      ].join("\n"),
    ],
    { encoding: "utf8", input: source },
  );

  if (result.status !== 0) {
    throw new Error(`${label}: ${result.stderr.trim() || "TOML parser failed"}`);
  }
  return JSON.parse(result.stdout);
}

const source = readFileSync(REPLIT_PATH, "utf8");
const config = parseToml(source, ".replit must be valid TOML");

assert.deepEqual(config.modules, ["nodejs-24", "python-3.11", "postgresql-16"]);
assert.deepEqual(config.postMerge, {
  path: "scripts/post-merge.sh",
  timeoutMs: 420000,
});
assert.equal(config.nix?.channel, "stable-25_05");
assert.equal(config.workflows?.runButton, "Project");
assert.equal(config.workflows?.workflow?.length, 8);
assert.equal(config.ports?.length, 7);

const workflows = new Map(
  config.workflows.workflow.map((workflow) => [workflow.name, workflow]),
);
assert.equal(workflows.get("Project")?.tasks?.length, 1);
assert.equal(workflows.get("Project")?.tasks?.[0]?.task, "workflow.run");
assert.equal(workflows.get("Project")?.tasks?.[0]?.args, "test-fast");
for (const name of [
  "test-fast",
  "test-standard",
  "test-standard-plus",
  "test-heavy",
]) {
  assert.equal(workflows.get(name)?.metadata?.isValidation, true);
}

const malformed = source.replace(
  '[postMerge]\npath = "scripts/post-merge.sh"',
  '[postMerge]\n<\npath = "scripts/post-merge.sh"',
);
assert.notEqual(malformed, source, "malformed fixture insertion point must exist");
assert.throws(
  () => parseToml(malformed, "stray-angle-bracket fixture"),
  /stray-angle-bracket fixture: TOML parse error:/,
);

console.log("Replit configuration contract OK.");