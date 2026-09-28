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
const lockfile = await readFile(resolve(root, "pnpm-lock.yaml"), "utf8");
const validationSteps = await readFile(
  resolve(root, "scripts/validation-steps.mjs"),
  "utf8",
);

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseImporter(lockfileText, importerName) {
  const importer = {};
  let inImporters = false;
  let inTargetImporter = false;
  let currentDependencyGroup;
  let currentDependency;

  for (const line of lockfileText.split(/\r?\n/)) {
    if (line === "importers:") {
      inImporters = true;
      continue;
    }
    if (!inImporters) continue;

    const importerHeader = line.match(/^  ([^ ].*):$/);
    if (importerHeader) {
      if (inTargetImporter) break;
      inTargetImporter = importerHeader[1] === importerName;
      continue;
    }
    if (!inTargetImporter) continue;

    const dependencyGroup = line.match(/^    (dependencies|devDependencies):$/);
    if (dependencyGroup) {
      currentDependencyGroup = dependencyGroup[1];
      currentDependency = undefined;
      continue;
    }

    const dependencyHeader = line.match(/^      (.+):$/);
    if (dependencyHeader && currentDependencyGroup) {
      currentDependency = unquote(dependencyHeader[1]);
      importer[currentDependencyGroup] ??= {};
      importer[currentDependencyGroup][currentDependency] = {};
      continue;
    }

    const field = line.match(/^        (specifier|version):\s*(.+)$/);
    if (field && currentDependencyGroup && currentDependency) {
      importer[currentDependencyGroup][currentDependency][field[1]] = unquote(field[2]);
    }
  }

  return importer;
}

const apiSpecImporter = parseImporter(lockfile, "lib/api-spec");

function assertLockfileDependency(name) {
  const manifestSpecifier = apiSpecPackage.devDependencies[name];
  const importerDependency = apiSpecImporter.devDependencies?.[name];
  assert.ok(
    importerDependency,
    `pnpm-lock.yaml importer "lib/api-spec" must retain devDependency "${name}" from lib/api-spec/package.json`,
  );
  assert.equal(
    importerDependency.specifier,
    manifestSpecifier,
    `pnpm-lock.yaml importer "lib/api-spec" must keep ${name} in sync with lib/api-spec/package.json`,
  );
  assert.match(
    importerDependency.version ?? "",
    /^\d+\.\d+\.\d+/,
    `pnpm-lock.yaml importer "lib/api-spec" must resolve ${name} to a concrete version`,
  );
}

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
assert.equal(
  apiSpecPackage.devDependencies.typescript,
  "~5.9.2",
  "api-spec must declare the TypeScript binary used by its typecheck script",
);
assertLockfileDependency("@types/node");
assertLockfileDependency("typescript");
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