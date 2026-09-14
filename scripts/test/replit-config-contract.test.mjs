#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  STRUCTURAL_TABLES,
  collectStructuralParity,
  compareStructuralConfig,
  redactStructuralConfig,
} from "../lib/replit-config-parity.mjs";
import { getTierSteps, TIERS } from "../validation-steps.mjs";

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
assert.deepEqual(config.ports, [
  { localPort: 3001, externalPort: 4200 },
  { localPort: 8080, externalPort: 8080 },
  { localPort: 8081, externalPort: 80 },
  { localPort: 8082, externalPort: 3001 },
  { localPort: 8083, externalPort: 3003 },
  { localPort: 19000, externalPort: 5000 },
  { localPort: 22660, externalPort: 3000 },
  { localPort: 22661, externalPort: 3002 },
]);

const workflows = new Map(
  config.workflows.workflow.map((workflow) => [workflow.name, workflow]),
);
const validationWorkflowNames = Object.keys(TIERS).map((tier) => `test-${tier}`);
assert.deepEqual(
  [...workflows.keys()].sort(),
  [
    "Project",
    "artifacts/api-server: API Server",
    "artifacts/mockup-sandbox: Component Preview Server",
    "artifacts/parts-id: expo",
    ...validationWorkflowNames,
  ].sort(),
  "active workflows must be exactly the project, registered artifacts, and canonical validation tiers",
);
assert.equal(workflows.get("Project")?.tasks?.length, 1);
assert.equal(workflows.get("Project")?.tasks?.[0]?.task, "workflow.run");
assert.equal(workflows.get("Project")?.tasks?.[0]?.args, "test-fast");
for (const name of validationWorkflowNames) {
  assert.equal(workflows.get(name)?.metadata?.isValidation, true);
  assert.equal(workflows.get(name)?.tasks?.length, 1);
  assert.equal(workflows.get(name)?.tasks?.[0]?.task, "shell.exec");
  assert.equal(workflows.get(name)?.tasks?.[0]?.args, `pnpm run ${name}`);
}
assert(
  getTierSteps("heavy").some(([name]) => name === "protected-map-concurrency"),
  "heavy validation must retain the protected-map concurrency smoke step",
);
assert(
  !getTierSteps("standard-plus").some(([name]) => name === "protected-map-concurrency"),
  "the protected-map concurrency smoke step must remain heavy-only",
);

const malformed = source.replace(
  '[postMerge]\npath = "scripts/post-merge.sh"',
  '[postMerge]\n<\npath = "scripts/post-merge.sh"',
);
assert.notEqual(malformed, source, "malformed fixture insertion point must exist");
assert.throws(
  () => parseToml(malformed, "stray-angle-bracket fixture"),
  /stray-angle-bracket fixture: TOML parse error:/,
);

const { snapshot: activeFixture } = redactStructuralConfig(config);

const noReaderResult = collectStructuralParity({ checkedIn: config });
assert.deepEqual(noReaderResult, {
  status: "unavailable",
  readerStatus: "unsupported",
  reason: "no-supported-reader",
  ok: false,
  diagnostics: [],
});

let unavailableReaderCalled = false;
const unavailableReaderResult = collectStructuralParity({
  checkedIn: config,
  reader: {
    isAvailable: () => false,
    read: () => {
      unavailableReaderCalled = true;
      throw new Error("must not be called");
    },
  },
});
assert.deepEqual(unavailableReaderResult, {
  status: "unavailable",
  readerStatus: "unavailable",
  reason: "reader-unavailable",
  ok: false,
  diagnostics: [],
});
assert.equal(unavailableReaderCalled, false);

const supportedReaderResult = collectStructuralParity({
  checkedIn: config,
  reader: {
    isAvailable: () => true,
    read: () => activeFixture,
  },
});
assert.equal(supportedReaderResult.status, "available");
assert.equal(supportedReaderResult.readerStatus, "available");
assert.equal(supportedReaderResult.reason, "matched");
assert.equal(supportedReaderResult.ok, true);
assert.deepEqual(supportedReaderResult.diagnostics, []);
assert.equal(supportedReaderResult.report.ok, true);

const matching = compareStructuralConfig({
  checkedIn: config,
  active: activeFixture,
});
assert.equal(matching.ok, true);
assert.deepEqual(matching.diagnostics, []);
assert.equal(matching.checkedInDigest, matching.activeDigest);

const drifted = structuredClone(activeFixture);
drifted.workflows.runButton = "Not Project";
const driftResult = compareStructuralConfig({
  checkedIn: config,
  active: drifted,
});
assert.equal(driftResult.ok, false);
assert.deepEqual(driftResult.diagnostics, [
  { source: "active", table: "workflows", issue: "digest-mismatch" },
]);
assert(!JSON.stringify(driftResult).includes("Not Project"));

const partial = structuredClone(activeFixture);
delete partial.ports;
const partialResult = compareStructuralConfig({
  checkedIn: config,
  active: partial,
});
assert.equal(partialResult.ok, false);
assert.deepEqual(partialResult.diagnostics, [
  { source: "active", table: "ports", issue: "missing-table" },
]);

const malformedSnapshotResult = compareStructuralConfig({
  checkedIn: config,
  active: { ...activeFixture, workflows: "not-a-table" },
});
assert.equal(malformedSnapshotResult.ok, false);
assert.deepEqual(malformedSnapshotResult.diagnostics, [
  {
    source: "active",
    table: "workflows",
    issue: "expected-object",
    actualType: "string",
  },
]);

const malformedNestedResult = compareStructuralConfig({
  checkedIn: config,
  active: { ...activeFixture, ports: [undefined] },
});
assert.equal(malformedNestedResult.ok, false);
assert.deepEqual(malformedNestedResult.diagnostics, [
  {
    source: "active",
    table: "ports",
    issue: "malformed-table",
  },
]);

const unexpectedTableResult = compareStructuralConfig({
  checkedIn: config,
  active: { ...activeFixture, notAReplitTable: true },
});
assert.equal(unexpectedTableResult.ok, false);
assert.deepEqual(unexpectedTableResult.diagnostics, [
  {
    source: "active",
    table: "notAReplitTable",
    issue: "unexpected-table",
  },
]);

const multipleUnexpectedTableResult = compareStructuralConfig({
  checkedIn: config,
  active: {
    ...activeFixture,
    zetaTable: true,
    alphaTable: true,
    middleTable: true,
  },
});
assert.equal(multipleUnexpectedTableResult.ok, false);
assert.deepEqual(multipleUnexpectedTableResult.diagnostics, [
  {
    source: "active",
    table: "alphaTable",
    issue: "unexpected-table",
  },
  {
    source: "active",
    table: "middleTable",
    issue: "unexpected-table",
  },
  {
    source: "active",
    table: "zetaTable",
    issue: "unexpected-table",
  },
]);

const longUnknownTable = "unknown".repeat(40);
const boundedUnknownTableResult = compareStructuralConfig({
  checkedIn: config,
  active: { ...activeFixture, [longUnknownTable]: true },
});
assert.equal(boundedUnknownTableResult.ok, false);
assert.equal(boundedUnknownTableResult.diagnostics.length, 1);
assert.equal(boundedUnknownTableResult.diagnostics[0].table.length, 128);
assert.equal(boundedUnknownTableResult.diagnostics[0].issue, "unexpected-table");

const checkedInUnexpectedTableResult = compareStructuralConfig({
  checkedIn: { ...config, newlyAddedTable: { enabled: true } },
  active: activeFixture,
});
assert.equal(checkedInUnexpectedTableResult.ok, false);
assert.deepEqual(checkedInUnexpectedTableResult.diagnostics, [
  {
    source: "checked-in",
    table: "newlyAddedTable",
    issue: "unexpected-table",
  },
]);

const secretBearingSnapshot = {
  ...activeFixture,
  userenv: { ADMIN_PASSWORD: "must-not-appear" },
};
const secretResult = compareStructuralConfig({
  checkedIn: config,
  active: secretBearingSnapshot,
});
assert.equal(secretResult.ok, false);
assert.deepEqual(secretResult.diagnostics, [
  {
    source: "active",
    table: "userenv",
    issue: "environment-bearing-table",
  },
]);
assert(!JSON.stringify(secretResult).includes("must-not-appear"));

assert.deepEqual(STRUCTURAL_TABLES, [
  "modules",
  "deployment",
  "workflows",
  "agent",
  "postMerge",
  "ports",
  "nix",
]);
assert(
  !readFileSync(resolve(ROOT, "scripts/lib/replit-config-parity.mjs"), "utf8").includes(
    "/run/replit/env",
  ),
  "parity source must not read environment metadata",
);

console.log("Replit configuration and parity contracts OK.");