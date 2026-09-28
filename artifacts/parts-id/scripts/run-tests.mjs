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
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { validateTestResultArtifact } from "../../../scripts/test-result-artifact.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

/**
 * Minimum number of test suites that must start (pass OR fail with real tests
 * OR fail to load — any state counts as "ran").  We currently have 107 .test.ts/tsx
 * files across __tests__/ and components/__tests__/; set the floor at 94 so a
 * single accidentally-excluded file doesn't trip the guard, but a broad
 * module-load failure (where many suites evaporate) is caught immediately.
 *
 * Update this constant when test files are intentionally added or removed.
 */
const SUITE_FLOOR = 94;

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
    if (
      TEST_FILTER_FLAGS.has(arg) ||
      [...TEST_FILTER_FLAGS].some((flag) => arg.startsWith(`${flag}=`))
    ) {
      return true;
    }
    if (!arg.startsWith("-")) {
      return true;
    }
  }

  return false;
}

export function normalizeForwardedArgs(args) {
  const forwarded = [];
  let callerOutputFile = null;

  for (const arg of args) {
    if (arg === "--") continue;
    if (arg.startsWith("--outputFile=")) {
      callerOutputFile = arg.slice("--outputFile=".length);
      continue;
    }
    if (arg === "--json") continue;
    forwarded.push(arg);
  }

  return { callerOutputFile, forwarded };
}

function main() {
  if (existsSync(RESULTS_FILE)) {
    unlinkSync(RESULTS_FILE);
  }

  const jestBin = join(ROOT, "node_modules", ".bin", "jest");

  // pnpm ≥9 may forward a literal "--" separator into script argv; Jest would
  // treat it and everything after it as test-path patterns (matching nothing).
  // Normalize both pnpm invocation forms before detecting focused selectors.
  const { callerOutputFile, forwarded } = normalizeForwardedArgs(
    process.argv.slice(2),
  );
  const focused = hasExplicitTestFilter(forwarded);
  const result = spawnSync(
    jestBin,
    // --forceExit: the full suite passes but leaves open handles (timers/RN
    // mocks) that keep the process alive until an outer timeout kills it. The
    // JSON results file is written before exit, so the guard below still runs.
    [
      "--runInBand",
      "--forceExit",
      "--json",
      `--outputFile=${RESULTS_FILE}`,
      ...forwarded,
    ],
    { stdio: "inherit", cwd: ROOT },
  );

  let exitCode = result.status ?? 1;

  if (!existsSync(RESULTS_FILE)) {
    console.error(
      "\nERROR: Suite-count guard: jest-results.json was not written — Jest may have crashed before producing output.",
    );
    process.exit(1);
  }

  let data;
  let validation;
  let exitAfterCopy = false;
  try {
    data = JSON.parse(readFileSync(RESULTS_FILE, "utf8"));
    validation = validateTestResultArtifact(data);
  } catch (err) {
    console.error(
      `\nERROR: Suite-count guard: could not parse jest-results.json — ${err.message}`,
    );
    exitAfterCopy = true;
  } finally {
    try {
      if (callerOutputFile) {
        copyFileSync(RESULTS_FILE, callerOutputFile);
      }
    } catch (err) {
      console.error(
        `ERROR: could not copy results to ${callerOutputFile} — ${err.message}`,
      );
      exitAfterCopy = true;
    }
    try {
      unlinkSync(RESULTS_FILE);
    } catch {
      // ignore
    }
  }

  if (exitAfterCopy) {
    process.exit(1);
  }

  if (!validation.ok) {
    console.error(
      `\nERROR: Suite-count guard: invalid jest-results.json — ${validation.reason}`,
    );
    process.exit(1);
  }

  if (!focused && validation.executedTestCount === 0) {
    console.error(
      "\nERROR: Suite-count guard: no tests executed — pending, todo, and skipped tests do not count as a successful full run.",
    );
    exitCode = 1;
  }

  const {
    numPassedTestSuites = 0,
    numFailedTestSuites = 0,
    numPendingTestSuites = 0,
    numTotalTestSuites = 0,
  } = data;
  const ran = numPassedTestSuites + numFailedTestSuites;

  if (!focused && ran < SUITE_FLOOR) {
    console.error(`
\x1b[31m╔══════════════════════════════════════════════════════════════╗
║              SUITE-COUNT GUARD FAILED                        ║
╚══════════════════════════════════════════════════════════════╝\x1b[0m
  Expected at least \x1b[33m${SUITE_FLOOR}\x1b[0m suites to run.
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
