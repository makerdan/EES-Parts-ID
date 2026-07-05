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
import { existsSync, readFileSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const jestBin = join(ROOT, "node_modules", ".bin", "jest");

/**
 * Auto-compute the suite floor by asking Jest which files it would run.
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

const listResult = spawnSync(jestBin, ["--listTests"], { cwd: ROOT, encoding: "utf8" });
if (listResult.error || listResult.status !== 0) {
  const detail = listResult.error?.message ?? listResult.stderr?.trim() ?? "(no output)";
  console.error(`\nERROR: Suite-count guard: "jest --listTests" failed — cannot compute floor.\n  ${detail}`);
  process.exit(1);
}
const discoveredCount = listResult.stdout.trim().split("\n").filter(Boolean).length;
const SUITE_FLOOR = Math.floor(discoveredCount * SUITE_FLOOR_RATIO);
console.log(`Suite-count guard: discovered ${discoveredCount} test files → floor = ${SUITE_FLOOR} (${Math.round(SUITE_FLOOR_RATIO * 100)}%)`);


const RESULTS_FILE = join(ROOT, "jest-results.json");

if (existsSync(RESULTS_FILE)) {
  unlinkSync(RESULTS_FILE);
}

const result = spawnSync(
  jestBin,
  ["--runInBand", "--json", `--outputFile=${RESULTS_FILE}`, ...process.argv.slice(2)],
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
    unlinkSync(RESULTS_FILE);
  } catch {
    // ignore
  }
}

const { numPassedTestSuites = 0, numFailedTestSuites = 0, numPendingTestSuites = 0, numTotalTestSuites = 0 } = data;
const ran = numPassedTestSuites + numFailedTestSuites + numPendingTestSuites;

if (ran < SUITE_FLOOR) {
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
