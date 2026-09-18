/**
 * ensure-codegen: idempotent, cross-process-safe codegen guard for dev boot.
 *
 * The destructive generator is always run through the repository's shared
 * `codegen` serial-lock resource. Post-merge generation and direct `codegen`
 * invocations use the same resource, so no clean-and-rewrite window can
 * overlap another generator or a second ensure process.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  checkGeneratedOutputs,
  formatGeneratedOutputFailures,
} from "./generated-output-check.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(__dirname, "../../..");
const root = resolve(process.env.CODEGEN_WORKSPACE_ROOT || repositoryRoot);
const apiSpecDir = resolve(
  process.env.CODEGEN_API_SPEC_DIR || resolve(root, "lib/api-spec"),
);
const serialLockScript = resolve(repositoryRoot, "scripts/serial-lock.mjs");

const packageManifestPath = resolve(apiSpecDir, "package.json");
const lockfilePath = resolve(root, "pnpm-lock.yaml");
const cacheDir = resolve(apiSpecDir, ".cache");
const markerPath = resolve(cacheDir, "codegen-marker.json");

const INPUT_FILES = [
  resolve(apiSpecDir, "openapi.yaml"),
  resolve(apiSpecDir, "orval.config.ts"),
  resolve(apiSpecDir, "post-codegen.mjs"),
];

function log(msg) {
  console.log(`[ensure-codegen] ${msg}`);
}

function sleepSync(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`unable to read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function packageKeyForSnapshot(snapshotKey) {
  const peerSuffix = snapshotKey.indexOf("(");
  return peerSuffix === -1 ? snapshotKey : snapshotKey.slice(0, peerSuffix);
}

function dependencySnapshotKey(name, value) {
  if (
    typeof value !== "string" ||
    value.startsWith("link:") ||
    value.startsWith("workspace:") ||
    value.startsWith("file:") ||
    value.startsWith("npm:")
  ) {
    return null;
  }
  return `${name}@${value}`;
}

function addDependencyGraph(lockfile, startingKeys) {
  const packages = lockfile.packages ?? {};
  const snapshots = lockfile.snapshots ?? {};
  const selected = new Set();
  const pending = [...startingKeys].filter(Boolean);

  while (pending.length > 0) {
    const snapshotKey = pending.pop();
    if (!snapshotKey || selected.has(snapshotKey)) continue;
    selected.add(snapshotKey);

    const packageKey = packageKeyForSnapshot(snapshotKey);
    const packageRecord = packages[packageKey];
    const snapshotRecord = snapshots[snapshotKey] ?? snapshots[packageKey];
    for (const record of [packageRecord, snapshotRecord]) {
      for (const field of ["dependencies", "optionalDependencies"]) {
        for (const [dependencyName, dependencyVersion] of Object.entries(record?.[field] ?? {})) {
          const dependencyKey = dependencySnapshotKey(dependencyName, dependencyVersion);
          if (dependencyKey) pending.push(dependencyKey);
        }
      }
    }
  }

  return [...selected].sort().map((snapshotKey) => ({
    key: snapshotKey,
    package: packages[packageKeyForSnapshot(snapshotKey)] ?? null,
    snapshot: snapshots[snapshotKey] ?? snapshots[packageKeyForSnapshot(snapshotKey)] ?? null,
  }));
}

function resolvedGeneratorToolchain() {
  const manifest = readJson(packageManifestPath);
  let lockfile;
  try {
    lockfile = parseYaml(readFileSync(lockfilePath, "utf8"));
  } catch (error) {
    throw new Error(
      `unable to parse ${lockfilePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const importer = lockfile?.importers?.["lib/api-spec"];
  const orvalResolution = importer?.devDependencies?.orval;
  if (!orvalResolution?.version) {
    throw new Error("pnpm-lock.yaml has no resolved lib/api-spec Orval entry");
  }

  const pnpmVersion = execFileSync("pnpm", ["--version"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const nodeToolchain = {
    node: process.version,
    pnpm: pnpmVersion,
  };
  const generatorManifest = {
    name: manifest.name,
    version: manifest.version,
    scripts: { codegen: manifest.scripts?.codegen, locked: manifest.scripts?.["codegen:locked"] },
    devDependencies: { orval: manifest.devDependencies?.orval },
  };
  const orvalGraph = addDependencyGraph(lockfile, [`orval@${orvalResolution.version}`]);

  return {
    lockfileVersion: lockfile.lockfileVersion,
    importer: { orval: orvalResolution },
    generatorManifest,
    orvalGraph,
    nodeToolchain,
  };
}

function computeInputHash() {
  const hash = createHash("sha256");
  for (const file of INPUT_FILES) {
    hash.update(file);
    hash.update("\0");
    try {
      hash.update(readFileSync(file));
    } catch {
      hash.update("<missing>");
    }
    hash.update("\0");
  }
  hash.update(JSON.stringify(resolvedGeneratorToolchain()));
  return hash.digest("hex");
}

function generatedOutputPresent() {
  return checkGeneratedOutputs({ root, checkTracked: false }).ok;
}

function generatedOutputFailureMessage() {
  const result = checkGeneratedOutputs({ root, checkTracked: false });
  return result.ok ? "" : `\n${formatGeneratedOutputFailures(result.failures)}`;
}

function readMarker() {
  try {
    return JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    return null;
  }
}

function writeMarker(hash) {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    markerPath,
    JSON.stringify({ hash, updatedAt: new Date().toISOString() }, null, 2),
  );
}

function inSync(hash) {
  const marker = readMarker();
  return !!marker && marker.hash === hash && generatedOutputPresent();
}

function runCodegen() {
  log("spec, generator, or generated output changed — running codegen (orval)");
  const result = spawnSync("pnpm", ["run", "codegen"], {
    cwd: apiSpecDir,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`codegen failed with exit code ${result.status ?? "unknown"}`);
  }
}

function runLockedEnsure() {
  const result = spawnSync(
    process.execPath,
    [
      serialLockScript,
      "--resource",
      "codegen",
      "--priority",
      "2",
      "--",
      process.execPath,
      fileURLToPath(import.meta.url),
    ],
    {
      cwd: repositoryRoot,
      stdio: "inherit",
      env: { ...process.env, CODEGEN_ENSURE_LOCKED: "1" },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `unable to establish the shared codegen lock (exit ${result.status ?? "unknown"})`,
    );
  }
}

function main() {
  if (process.env.CODEGEN_ENSURE_SKIP === "1") {
    log("CODEGEN_ENSURE_SKIP set — nested codegen typecheck, skipping guard");
    return;
  }

  const hash = computeInputHash();
  if (inSync(hash)) {
    log("generated api clients are up to date — skipping codegen");
    return;
  }

  if (process.env.CODEGEN_ENSURE_LOCKED !== "1") {
    runLockedEnsure();
    return;
  }

  // Re-check after acquiring the shared lock: another generator may have
  // completed while this process was queued.
  if (inSync(hash)) {
    log("generated api clients became up to date while waiting — skipping");
    return;
  }

  try {
    runCodegen();
    if (!generatedOutputPresent()) {
      throw new Error(
        "codegen completed but the generated-output inventory is invalid" +
          generatedOutputFailureMessage(),
      );
    }
    writeMarker(hash);
    log("codegen complete and generated output verified");
  } finally {
    // The shared serial-lock wrapper owns cleanup. This block intentionally
    // does not remove a second lock or marker on failure.
  }
}

main();