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
const workspaceConfig = resolve(workspaceRoot, "pnpm-workspace.yaml");
const knip = resolve(
  workspaceRoot,
  "artifacts",
  "api-server",
  "node_modules",
  ".bin",
  "knip",
);

function readWorkspaceGlobs(configPath) {
  const yaml = readFileSync(configPath, "utf8");
  const globs = [];
  let inPackages = false;
  for (const line of yaml.split("\n")) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;

    const match = line.match(/^\s+-\s+['"]?([^'"#]+?)['"]?\s*$/);
    if (match) {
      globs.push(match[1].trim());
      continue;
    }

    if (!/^\s*(#|$)/.test(line)) inPackages = false;
  }
  if (globs.length === 0) {
    throw new Error(
      `could not parse packages: globs from ${configPath}`,
    );
  }
  return globs;
}

function matchesSegment(name, pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(
    name,
  );
}

function expandWorkspaceGlob(root, glob) {
  const dirs = [];
  const parts = glob.split("/").filter(Boolean);

  function walk(base, index) {
    if (index === parts.length) {
      dirs.push(base);
      return;
    }

    const part = parts[index];
    if (part === "**") {
      walk(base, index + 1);
      if (!existsSync(base)) return;
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== "node_modules") {
          walk(resolve(base, entry.name), index);
        }
      }
      return;
    }

    if (!existsSync(base)) return;
    if (!part.includes("*") && !part.includes("?")) {
      walk(resolve(base, part), index + 1);
      return;
    }

    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        entry.name !== "node_modules" &&
        matchesSegment(entry.name, part)
      ) {
        walk(resolve(base, entry.name), index + 1);
      }
    }
  }

  walk(root, 0);
  return dirs;
}

function discoverPackageDirs(root, configPath) {
  const packageDirs = new Set();
  for (const configuredGlob of readWorkspaceGlobs(configPath)) {
    const excluded = configuredGlob.startsWith("!");
    const glob = excluded ? configuredGlob.slice(1) : configuredGlob;
    const matches = expandWorkspaceGlob(root, glob).filter((directory) =>
      existsSync(resolve(directory, "package.json")),
    );
    for (const directory of matches) {
      if (excluded) packageDirs.delete(directory);
      else packageDirs.add(directory);
    }
  }
  return [...packageDirs].sort();
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
const workspaceConfigFlag = process.argv.indexOf("--workspace-config");
const configuredWorkspace =
  workspaceConfigFlag === -1
    ? workspaceConfig
    : resolve(process.cwd(), process.argv[workspaceConfigFlag + 1]);
const packageDirs = requested
  ? [resolve(process.cwd(), requested)]
  : discoverPackageDirs(workspaceRoot, configuredWorkspace);

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
