import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function readJson(relativePath) {
  return JSON.parse(await readFile(resolve(root, relativePath), "utf8"));
}

const apiSpecPackage = await readJson("lib/api-spec/package.json");
const apiSpecTsconfig = await readJson("lib/api-spec/tsconfig.json");
const rootTsconfig = await readJson("tsconfig.json");
const validationSteps = await readFile(
  resolve(root, "scripts/validation-steps.mjs"),
  "utf8",
);

assert.equal(
  apiSpecTsconfig.extends,
  "../../tsconfig.base.json",
  "api-spec typechecking must inherit the workspace TypeScript defaults",
);
assert.equal(
  apiSpecPackage.scripts.typecheck,
  "tsc --build ./tsconfig.json",
  "api-spec must expose its explicit typecheck boundary",
);
assert.deepEqual(
  apiSpecTsconfig.include,
  ["src"],
  "api-spec typechecking must cover source and test helpers",
);
assert.ok(
  rootTsconfig.references?.some((reference) => reference.path === "./lib/api-spec"),
  "api-spec must remain in the root TypeScript build graph",
);
assert.match(
  validationSteps,
  /\["api-spec-typecheck",\s*"pnpm --filter @workspace\/api-spec run typecheck"\]/,
  "the fast validation tier must run the api-spec typecheck",
);
assert.match(
  validationSteps,
  /\["codegen-check",[\s\S]*\],/,
  "generated-input drift checks must remain a separately registered step",
);
assert.match(
  validationSteps,
  /standard:\s*\[\.\.\.FAST,\s*\.\.\.STANDARD_EXTRA\]/,
  "generated-input drift checks must remain outside the fast tier",
);

console.log("api-spec typecheck contract passed");