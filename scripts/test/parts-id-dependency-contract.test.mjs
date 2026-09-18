#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const manifestPath = resolve("artifacts/parts-id/package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const runtimeDependencies = Object.keys(manifest.dependencies ?? {});
const developmentDependencies = new Set(Object.keys(manifest.devDependencies ?? {}));
const overlap = runtimeDependencies
  .filter((name) => developmentDependencies.has(name))
  .sort();

assert.deepEqual(
  overlap,
  [],
  `Parts ID dependencies and devDependencies must not overlap: ${overlap.join(", ")}`,
);

console.log("Parts ID dependency contract: runtime and development declarations do not overlap");