#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  getBrowserBundleChecks,
} from "../check-browser-bundles.mjs";
import {
  buildGraph,
  collectClientRoots,
} from "../check-db-reachability.mjs";
import {
  findForbiddenBundleSources,
  runPartsIdBrowserBundleCheck,
} from "../../artifacts/parts-id/scripts/check-browser-bundle.mjs";

function makeSourceMap(sources) {
  const outputDir = mkdtempSync(join(tmpdir(), "browser-bundle-contract-"));
  const jsRoot = join(outputDir, "_expo/static/js/web");
  mkdirSync(jsRoot, { recursive: true });
  writeFileSync(
    join(jsRoot, "fixture.js.map"),
    JSON.stringify({ version: 3, sources, names: [], mappings: "" }),
  );
  return outputDir;
}

const workspaceRoot = resolve(".");
const partsIdDir = resolve("artifacts/parts-id");
const dbDir = resolve("lib/db");
const packages = new Map([
  ["@workspace/parts-id", { dir: partsIdDir, deps: new Set() }],
  ["@workspace/db", { dir: dbDir, deps: new Set() }],
]);

const workspacePackages = buildGraph(workspaceRoot);
assert.deepEqual(
  collectClientRoots(workspacePackages),
  ["@workspace/parts-id"],
  "development-only artifacts must remain excluded through explicit classification",
);
const clientChecks = getBrowserBundleChecks(workspacePackages);
assert.deepEqual(
  clientChecks.map(({ packageName }) => packageName),
  ["@workspace/parts-id"],
  "every client artifact must declare a focused browser bundle check",
);

const cleanOutput = makeSourceMap(["/artifacts/parts-id/app/index.tsx"]);
try {
  assert.equal(
    findForbiddenBundleSources({
      outputDir: cleanOutput,
      packages,
      forbiddenTargets: ["@workspace/db"],
    }).size,
    0,
  );
} finally {
  rmSync(cleanOutput, { recursive: true, force: true });
}

const forbiddenOutput = makeSourceMap(["/lib/db/src/index.ts"]);
try {
  const found = findForbiddenBundleSources({
    outputDir: forbiddenOutput,
    packages,
    forbiddenTargets: ["@workspace/db"],
  });
  assert.equal(found.size, 1);
  assert.equal(found.has("@workspace/db"), true);
} finally {
  rmSync(forbiddenOutput, { recursive: true, force: true });
}

const fixtureOutput = makeSourceMap(["/lib/db/src/index.ts"]);
assert.throws(
  () =>
    runPartsIdBrowserBundleCheck({
      outputDir: fixtureOutput,
      packages,
      forbiddenTargets: ["@workspace/db"],
      spawn: () => ({ status: 0 }),
    }),
  /@workspace\/parts-id contains forbidden server-only dependencies:[\s\S]*@workspace\/db/,
  "a fixture-only server import must identify the offending browser artifact",
);

console.log(
  `Browser bundle dependency contract passed (${workspaceRoot}): ` +
    "client declaration, clean bundle, and forbidden fixture coverage",
);