#!/usr/bin/env node
/**
 * Run the browser-bundle smoke check declared by every mobile/web artifact.
 *
 * The workspace reachability guard and this check intentionally cover different
 * boundaries: the former checks local package edges, while this one asks each
 * artifact's real browser bundler to resolve and emit its client graph.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  buildGraph,
  collectClientRoots,
  getPackageEntry,
} from "./check-db-reachability.mjs";

const ROOT = resolve(".");
const BUNDLE_CHECK_SCRIPT = "check:browser-bundle";

export function getBrowserBundleChecks(packages, roots = collectClientRoots(packages)) {
  return roots.map((packageName) => {
    const entry = getPackageEntry(packages, packageName);
    const manifest = JSON.parse(readFileSync(resolve(entry.dir, "package.json"), "utf8"));
    const command = manifest.scripts?.[BUNDLE_CHECK_SCRIPT];
    if (!command) {
      throw new Error(
        `browser bundle check missing for ${packageName}: declare ` +
          `"${BUNDLE_CHECK_SCRIPT}" in ${resolve(entry.dir, "package.json")}`,
      );
    }
    return { packageName, command, directory: entry.dir };
  });
}

export function runBrowserBundleChecks({
  packages = buildGraph(ROOT),
  roots,
  spawn = spawnSync,
} = {}) {
  const checks = getBrowserBundleChecks(packages, roots);
  let failed = false;

  for (const check of checks) {
    console.log(`\n[browser-bundle] ${check.packageName}`);
    const result = spawn(
      "pnpm",
      ["--filter", check.packageName, "run", BUNDLE_CHECK_SCRIPT],
      {
        cwd: ROOT,
        env: process.env,
        stdio: "inherit",
      },
    );
    if (result.error) {
      console.error(
        `[browser-bundle] ${check.packageName} failed to start: ${result.error.message}`,
      );
      failed = true;
    } else if (result.status !== 0) {
      console.error(
        `[browser-bundle] ${check.packageName} failed with exit code ${result.status}`,
      );
      failed = true;
    }
  }

  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exit(runBrowserBundleChecks());
}