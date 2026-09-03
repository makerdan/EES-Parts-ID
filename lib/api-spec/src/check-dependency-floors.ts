#!/usr/bin/env tsx
/**
 * Verify the security floors for the API code-generation and PDF-processing
 * dependency paths.
 *
 * This check intentionally reads the lockfile as well as the package manifests:
 * a manifest-only check can miss a stale vulnerable resolution, while a
 * lockfile-only check can miss a lowered constraint that has not been
 * reinstalled yet.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse as parseYaml } from "yaml";

export interface DependencyFloorFailure {
  dependency: string;
  message: string;
}

interface Lockfile {
  importers?: Record<string, {
    dependencies?: Record<string, { specifier?: string; version?: string }>;
    devDependencies?: Record<string, { specifier?: string; version?: string }>;
  }>;
  packages?: Record<string, unknown>;
}

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface DirectFloor {
  importer: string;
  section: "dependencies" | "devDependencies";
  dependency: string;
  minimum: string;
}

const DIRECT_FLOORS: Array<DirectFloor> = [
  {
    importer: "lib/api-spec",
    section: "devDependencies",
    dependency: "orval",
    minimum: "8.22.0",
  },
  {
    importer: "artifacts/api-server",
    section: "dependencies",
    dependency: "pdfjs-dist",
    minimum: "6.2.108",
  },
];

const TRANSITIVE_FLOORS: Array<{ dependency: string; minimum: string }> = [
  { dependency: "fast-uri", minimum: "4.1.3" },
  { dependency: "brace-expansion", minimum: "5.0.9" },
  { dependency: "qs", minimum: "6.16.0" },
];

const JS_YAML_FLOORS: Record<number, string> = {
  3: "3.15.1",
  4: "4.3.1",
};

function versionParts(version: string): [number, number, number] | null {
  const match = version.match(/(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)(?:[^0-9]|$)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(actual: string, minimum: string): boolean {
  const actualParts = versionParts(actual);
  const minimumParts = versionParts(minimum);
  if (!actualParts || !minimumParts) return false;
  for (let i = 0; i < 3; i++) {
    if (actualParts[i] !== minimumParts[i]) {
      return actualParts[i] > minimumParts[i];
    }
  }
  return true;
}

function packageNameFromLockKey(key: string, dependency: string): string | null {
  const prefix = `${dependency}@`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : null;
}

function manifestSpecifier(manifest: Manifest, floor: DirectFloor): string | undefined {
  return manifest[floor.section]?.[floor.dependency];
}

function specifierHasFloor(specifier: string | undefined, minimum: string): boolean {
  if (!specifier) return false;
  const declaredVersion = specifier.match(/(\d+\.\d+\.\d+)/)?.[1];
  return declaredVersion != null && atLeast(declaredVersion, minimum);
}

function resolvedVersion(
  lockfile: Lockfile,
  floor: DirectFloor,
): string | undefined {
  const importer = lockfile.importers?.[floor.importer];
  return importer?.[floor.section]?.[floor.dependency]?.version?.match(
    /^\d+\.\d+\.\d+/,
  )?.[0];
}

function resolvedVersions(lockfile: Lockfile, dependency: string): Array<string> {
  return Object.keys(lockfile.packages ?? {})
    .map((key) => packageNameFromLockKey(key, dependency))
    .filter((version): version is string => version != null)
    .map((version) => version.match(/^\d+\.\d+\.\d+/)?.[0])
    .filter((version): version is string => version != null);
}

export function checkDependencyFloors(
  lockfile: Lockfile,
  manifests: Record<string, Manifest>,
): Array<DependencyFloorFailure> {
  const failures: Array<DependencyFloorFailure> = [];

  for (const floor of DIRECT_FLOORS) {
    const manifest = manifests[floor.importer];
    const specifier = manifestSpecifier(manifest ?? {}, floor);
    if (!specifierHasFloor(specifier, floor.minimum)) {
      failures.push({
        dependency: floor.dependency,
        message: `${floor.importer}/package.json declares ${specifier ?? "no version"}; requires at least ${floor.minimum}`,
      });
    }

    const resolved = resolvedVersion(lockfile, floor);
    if (!resolved || !atLeast(resolved, floor.minimum)) {
      failures.push({
        dependency: floor.dependency,
        message: `${floor.importer} resolves ${resolved ?? "no version"}; requires at least ${floor.minimum}`,
      });
    }
  }

  for (const floor of TRANSITIVE_FLOORS) {
    const versions = resolvedVersions(lockfile, floor.dependency);
    if (versions.length === 0) {
      failures.push({
        dependency: floor.dependency,
        message: `lockfile contains no ${floor.dependency} resolution`,
      });
      continue;
    }
    const unsafe = versions.filter((version) => !atLeast(version, floor.minimum));
    if (unsafe.length > 0) {
      failures.push({
        dependency: floor.dependency,
        message: `lockfile resolves ${floor.dependency} at ${unsafe.join(", ")}; requires at least ${floor.minimum}`,
      });
    }
  }

  const jsYamlVersions = resolvedVersions(lockfile, "js-yaml");
  for (const [majorText, minimum] of Object.entries(JS_YAML_FLOORS)) {
    const major = Number(majorText);
    const versions = jsYamlVersions.filter((version) => versionParts(version)?.[0] === major);
    if (versions.length === 0) {
      failures.push({
        dependency: "js-yaml",
        message: `lockfile contains no js-yaml ${major}.x resolution`,
      });
      continue;
    }
    const unsafe = versions.filter((version) => !atLeast(version, minimum));
    if (unsafe.length > 0) {
      failures.push({
        dependency: "js-yaml",
        message: `lockfile resolves js-yaml ${major}.x at ${unsafe.join(", ")}; requires at least ${minimum}`,
      });
    }
  }

  return failures;
}

function loadCurrentInputs(): {
  lockfile: Lockfile;
  manifests: Record<string, Manifest>;
} {
  const root = resolve(process.cwd(), "../..");
  const readJson = (relativePath: string): Manifest =>
    JSON.parse(readFileSync(resolve(root, relativePath), "utf8")) as Manifest;

  return {
    lockfile: parseYaml(readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8")) as Lockfile,
    manifests: {
      "lib/api-spec": readJson("lib/api-spec/package.json"),
      "artifacts/api-server": readJson("artifacts/api-server/package.json"),
    },
  };
}

export function main(): void {
  const { lockfile, manifests } = loadCurrentInputs();
  const failures = checkDependencyFloors(lockfile, manifests);

  if (failures.length === 0) {
    console.log("✅  dependency:check passed — API security floors are satisfied.");
    return;
  }

  console.error("❌  dependency:check FAILED:");
  for (const failure of failures) {
    console.error(`  ${failure.dependency}: ${failure.message}`);
  }
  process.exitCode = 1;
}

if (process.argv[1]?.endsWith("check-dependency-floors.ts")) {
  main();
}