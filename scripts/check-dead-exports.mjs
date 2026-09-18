#!/usr/bin/env node
/**
 * Run the repository's dead-code policy for every workspace package.
 *
 * Knip is installed by the API Server package, so this runner has one stable
 * executable even though the libraries intentionally do not depend on Knip at
 * runtime. Importable packages must declare a `knip` policy in package.json;
 * command-entrypoint packages may instead declare a documented
 * `deadCodePolicy` exclusion. A missing policy is a validation error rather
 * than an omitted package.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const workspaceRoot = resolve(import.meta.dirname, "..");
const knip = resolve(
  workspaceRoot,
  "artifacts",
  "api-server",
  "node_modules",
  ".bin",
  "knip",
);

function findManifests(directory) {
  const result = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && entry.name === "package.json")
        result.push(fullPath);
    }
  }
  return result.sort();
}

function parseManifest(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function getDeadCodePolicy(manifest, packageDir) {
  if (manifest.knip || existsSync(resolve(packageDir, "knip.json"))) {
    return { mode: "knip" };
  }

  const policy = manifest.deadCodePolicy;
  if (
    policy?.mode === "excluded" &&
    typeof policy.reason === "string" &&
    policy.reason.trim() &&
    Array.isArray(policy.coveredPaths) &&
    policy.coveredPaths.length > 0 &&
    policy.coveredPaths.every(
      (path) => typeof path === "string" && path.trim(),
    )
  ) {
    return { mode: "excluded", reason: policy.reason };
  }

  return null;
}

const packageDirFlag = process.argv.indexOf("--package-dir");
const requested =
  packageDirFlag === -1 ? undefined : process.argv[packageDirFlag + 1];
const packageDirs = requested
  ? [resolve(process.cwd(), requested)]
  : [resolve(workspaceRoot, "lib"), resolve(workspaceRoot, "scripts")]
      .flatMap((directory) =>
        existsSync(directory) ? findManifests(directory) : [],
      )
      .map((path) => resolve(path, ".."));

if (!existsSync(knip)) {
  console.error(`dead-exports FAILED — Knip executable not found: ${knip}`);
  process.exit(1);
}

let failed = false;
for (const packageDir of packageDirs) {
  const manifestPath = resolve(packageDir, "package.json");
  if (!existsSync(manifestPath)) {
    console.error(
      `dead-exports FAILED — package manifest not found: ${manifestPath}`,
    );
    failed = true;
    continue;
  }
  const manifest = parseManifest(manifestPath);
  const policy = getDeadCodePolicy(manifest, packageDir);
  if (!policy) {
    console.error(
      `dead-exports FAILED — ${manifest.name ?? packageDir} has no explicit dead-code policy in package.json`,
    );
    failed = true;
    continue;
  }

  if (policy.mode === "excluded") {
    console.log(
      `dead-exports — excluding ${manifest.name ?? packageDir}: ${policy.reason}`,
    );
    continue;
  }

  console.log(
    `dead-exports — checking ${manifest.name ?? packageDir}`,
  );
  const result = spawnSync(
    knip,
    ["--directory", packageDir, "--no-config-hints"],
    {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        DATABASE_ENV: process.env.DATABASE_ENV ?? "development",
      },
      stdio: "inherit",
    },
  );
  if (result.error || result.status !== 0) failed = true;
}

process.exit(failed ? 1 : 0);
