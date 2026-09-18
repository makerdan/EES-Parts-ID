/**
 * Jest wrapper that guards against silent suite-load failures.
 *
 * Problem: when a module-load error (e.g. an ESM-only transitive dep) hits a
 * test file, Jest may mark that suite as "failed to run" but still report 0
 * assertion failures.  A CI script that only checks "0 test failures" would
 * declare a green build while entire suites silently never executed.
 *
 * This script adds a hard floor on the number of suites that must actually
 * run.  If fewer suites ran than expected, it prints a clear error and exits
 * non-zero — even if Jest itself reported success.
 */

import { spawnSync } from "child_process";
import { copyFileSync, existsSync, readFileSync, unlinkSync } from "fs";
import { glob } from "node:fs/promises";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const jestBin = join(ROOT, "node_modules", ".bin", "jest");

/**
 * Auto-compute the suite floor by globbing test files directly on the
 * filesystem instead of spawning "jest --listTests".
 *
 * Using a glob avoids a full Jest startup just to enumerate files, which is
 * noticeable on cold node_modules caches or large projects.  The pattern
 * below intentionally mirrors the testMatch value in jest.config.cjs
 * ("**\/__tests__\/**\/*.test.ts") so the two stay in sync — if testMatch
 * ever changes, update this pattern to match.
 *
 * The floor is set to 85 % of the discovered file count.  This means a single
 * accidentally-excluded file won't trip the guard, but a broad module-load
 * failure (where many suites evaporate) is caught immediately.
 *
 * Raise or lower the percentage here if false positives / false negatives
 * become a problem — no other change is required when test files are added or
 * removed.
 */
const SUITE_FLOOR_RATIO = 0.85;

const RESULTS_FILE = join(ROOT, "jest-results.json");

const TEST_FILTER_FLAGS = new Set([
  "--changedSince",
  "--changedFilesWithAncestor",
  "--findRelatedTests",
  "--lastCommit",
  "--onlyChanged",
  "--runTestsByPath",
  "--selectProjects",
  "--testNamePattern",
  "--testPathPattern",
  "--testPathPatterns",
  "-t",
]);

// These options consume the following argument. Their values are not test
// file patterns, so do not mistake them for focused-run selectors.
const VALUE_FLAGS = new Set([
  "--cacheDirectory",
  "--config",
  "--coverageDirectory",
  "--coverageReporters",
  "--globals",
  "--maxWorkers",
  "--moduleNameMapper",
  "--outputFile",
  "--preset",
  "--projects",
  "--resolver",
  "--roots",
  "--setupFiles",
  "--setupFilesAfterEnv",
  "--testEnvironment",
  "--testMatch",
  "--testPathIgnorePatterns",
  "--transform",
  "--watchPathIgnorePatterns",
]);

/**
 * Return whether Jest was asked to run a focused selection.
 *
 * Positional arguments are test path patterns. Jest's named selection flags
 * are also focused, including test-name selection, because the full-tree
 * suite floor is not meaningful when the caller intentionally narrows the
 * run.
 */
export function hasExplicitTestFilter(args) {
  let consumesValue = false;

  for (const arg of args) {
    if (consumesValue) {
      consumesValue = false;
      continue;
    }

    if (VALUE_FLAGS.has(arg)) {
      consumesValue = true;
      continue;
    }

    if (TEST_FILTER_FLAGS.has(arg) || [...TEST_FILTER_FLAGS].some((flag) => arg.startsWith(`${flag}=`))) {
      return true;
    }

    if (!arg.startsWith("-")) {
      return true;
    }
  }

  return false;
}

export function getSuiteFloor({ discoveredCount, focused }) {
  if (focused) return null;
  return Math.floor(discoveredCount * SUITE_FLOOR_RATIO);
}

export function violatesSuiteFloor({ ran, suiteFloor }) {
  return suiteFloor !== null && ran < suiteFloor;
}

async function main() {
  // pnpm ≥9 forwards a literal "--" separator into script argv; Jest would
  // treat it and everything after it as test-path patterns (matching nothing).
  // Strip it, and intercept any caller-supplied --outputFile: the guard below
  // must read Jest's JSON from RESULTS_FILE, so we run Jest with RESULTS_FILE
  // and copy the JSON to the caller's requested path afterwards.
  const forwarded = [];
  let callerOutputFile = null;
  for (const arg of process.argv.slice(2)) {
    if (arg === "--") continue;
    if (arg.startsWith("--outputFile=")) {
      callerOutputFile = arg.slice("--outputFile=".length);
      continue;
    }
    if (arg === "--json") continue; // already passed below
    forwarded.push(arg);
  }

  const focused = hasExplicitTestFilter(forwarded);
  let suiteFloor = null;
  if (focused) {
    console.log("Suite-count guard: focused run detected → full-run floor disabled");
  } else {
    const globbed = await Array.fromAsync(
      glob("**/__tests__/**/*.test.ts", { cwd: ROOT, withFileTypes: false, exclude: ["node_modules/**"] })
    );
    const discoveredCount = globbed.length;
    suiteFloor = getSuiteFloor({ discoveredCount, focused });
    console.log(`Suite-count guard: discovered ${discoveredCount} test files → floor = ${suiteFloor} (${Math.round(SUITE_FLOOR_RATIO * 100)}%)`);
  }

  if (existsSync(RESULTS_FILE)) {
    unlinkSync(RESULTS_FILE);
  }

  const result = spawnSync(
    jestBin,
    ["--json", `--outputFile=${RESULTS_FILE}`, ...forwarded],
    { stdio: "inherit", cwd: ROOT }
  );

  let exitCode = result.status ?? 1;

  if (!existsSync(RESULTS_FILE)) {
    console.error(
      "\nERROR: Suite-count guard: jest-results.json was not written — Jest may have crashed before producing output."
    );
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(readFileSync(RESULTS_FILE, "utf8"));
  } catch (err) {
    console.error(`\nERROR: Suite-count guard: could not parse jest-results.json — ${err.message}`);
    process.exit(1);
  } finally {
    try {
      if (callerOutputFile) {
        copyFileSync(RESULTS_FILE, callerOutputFile);
      }
    } catch (err) {
      console.error(`WARNING: could not copy results to ${callerOutputFile} — ${err.message}`);
    }
    try {
      unlinkSync(RESULTS_FILE);
    } catch {
      // ignore
    }
  }

  const { numPassedTestSuites = 0, numFailedTestSuites = 0, numPendingTestSuites = 0, numTotalTestSuites = 0 } = data;
  const ran = numPassedTestSuites + numFailedTestSuites + numPendingTestSuites;

  if (violatesSuiteFloor({ ran, suiteFloor })) {
    console.error(`
\x1b[31m╔══════════════════════════════════════════════════════════════╗
║              SUITE-COUNT GUARD FAILED                        ║
╚══════════════════════════════════════════════════════════════╝\x1b[0m
  Expected at least \x1b[33m${suiteFloor}\x1b[0m suites to run.
  Only \x1b[31m${ran}\x1b[0m ran out of \x1b[33m${numTotalTestSuites}\x1b[0m matched.
    passed : ${numPassedTestSuites}
    failed : ${numFailedTestSuites}
    pending: ${numPendingTestSuites}

  This usually means a module-load error (e.g. a new ESM-only
  transitive dependency) silently prevented suites from loading,
  or testMatch no longer finds the expected files.

  Fix the underlying load error, then re-run the tests.
`);
    exitCode = 1;
  }

  process.exit(exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
