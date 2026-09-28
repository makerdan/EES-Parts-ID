#!/usr/bin/env node
/**
 * test-timeout-report.mjs
 *
 * Reads Jest/Vitest JSON result files written by test-all.sh and emits a
 * structured diagnostic report covering:
 *   - Summary of all suites
 *   - Top-10 slowest individual tests
 *   - Tests that exceeded their timeout budget
 *   - Suites that hit their wall-clock limit
 *   - Actionable suggestions for each violation category
 *
 * Usage:
 *   node scripts/test-timeout-report.mjs <manifest-json-path>
 *
 * The manifest JSON is an array of:
 *   { suite, runId, jsonPath, wallClockMs, budgetMs, exitCode }
 *
 * Exit codes:
 *   0 — no violations
 *   1 — one or more violations found
 */

import { readFileSync, existsSync, statSync } from "fs";
import { validateTestResultArtifact } from "./test-result-artifact.mjs";

const SUGGESTION_LABELS = {
  MOCK_DEPENDENCY:
    "Mock the slow external dependency (network/DB) so the test does not wait for I/O.",
  FAKE_TIMERS:
    "Use jest.useFakeTimers() / vi.useFakeTimers() to advance time without waiting.",
  LOCAL_SETTIMEOUT:
    "Add jest.setTimeout(N) / vi.setConfig({ testTimeout: N }) at the top of the test file for tests that legitimately need more time.",
  OPEN_HANDLES:
    "Run with --detectOpenHandles to find sockets/timers keeping Jest alive past the test.",
  SPLIT_SUITE:
    "Move integration tests to a separate test:integration script so they don't block the unit suite.",
  CHECK_DB_POOL:
    "Check that the DB connection pool is not exhausted; lower pool size or add pool.end() in afterAll.",
  CHECK_CONNECTIVITY:
    "Verify DATABASE_URL is correct and the DB host is reachable from this environment.",
};

function label(category) {
  return `[${category}] ${SUGGESTION_LABELS[category]}`;
}

function formatMs(ms) {
  if (ms == null) return "?";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}

function pad(str, len) {
  const s = String(str);
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

function hr(char = "─", width = 60) {
  return char.repeat(width);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// ── Load manifest ────────────────────────────────────────────────────────────

const manifestPath = process.argv[2];
if (!manifestPath) {
  console.error("Usage: node scripts/test-timeout-report.mjs <manifest.json>");
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (e) {
  console.error(`Cannot read manifest at ${manifestPath}: ${e.message}`);
  process.exit(1);
}
if (!Array.isArray(manifest) || manifest.length === 0) {
  console.error("Cannot read manifest: expected a non-empty array.");
  process.exit(1);
}

function loadResultEvidence(jsonPath, expectedRunId, expectedSuite, startedAtMs) {
  if (!isNonEmptyString(expectedSuite)) {
    return {
      status: "UNAVAILABLE",
      reason: "manifest suite identity is missing or empty",
    };
  }
  if (typeof jsonPath !== "string" || jsonPath.length === 0) {
    return { status: "UNAVAILABLE", reason: "result path is missing" };
  }
  if (!existsSync(jsonPath)) {
    return { status: "UNAVAILABLE", reason: "result file is missing" };
  }

  let data;
  try {
    data = JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch (error) {
    return {
      status: "UNAVAILABLE",
      reason: `result JSON is corrupt (${error.message})`,
    };
  }

  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { status: "UNAVAILABLE", reason: "result JSON is not an object" };
  }
  if (typeof expectedRunId !== "string" || expectedRunId.length === 0) {
    return { status: "UNAVAILABLE", reason: "manifest run ID is missing" };
  }
  if (data.validationRunId !== expectedRunId) {
    return {
      status: "STALE",
      reason: "result run ID does not match the manifest run ID",
    };
  }
  if (!isNonEmptyString(data.validationSuite)) {
    return {
      status: "UNAVAILABLE",
      reason: "result validationSuite identity is missing or empty",
    };
  }
  if (data.validationSuite !== expectedSuite) {
    return {
      status: "CONTRADICTORY",
      reason: "result suite does not match the manifest suite",
    };
  }
  if (!Number.isFinite(startedAtMs)) {
    return { status: "UNAVAILABLE", reason: "manifest is missing a valid startedAtMs" };
  }
  try {
    if (statSync(jsonPath).mtimeMs < startedAtMs) {
      return { status: "STALE", reason: "result file is stale" };
    }
  } catch (error) {
    return {
      status: "UNAVAILABLE",
      reason: `could not stat result file (${error.message})`,
    };
  }

  const validation = validateTestResultArtifact(data);
  if (!validation.ok) {
    return {
      status: "INVALID",
      reason: `invalid result schema: ${validation.reason}`,
    };
  }
  return { status: "CURRENT", data, validation };
}

// ── Parse results ────────────────────────────────────────────────────────────

const suiteReports = [];
const allTests = [];

for (const entry of manifest) {
  const { suite, jsonPath, startedAtMs, wallClockMs, budgetMs, exitCode } = entry;

  const timedOut = exitCode === 124;
  const failed = !timedOut && exitCode !== 0;
  const passed = exitCode === 0;

  const evidence = loadResultEvidence(
    jsonPath,
    entry.runId,
    suite,
    startedAtMs,
  );
  const jestData = evidence.data ?? null;
  const resultError =
    evidence.status === "CURRENT" ? null : evidence.reason;

  const testResults = jestData?.testResults ?? [];
  const completedTests = [];
  let todoCount = 0;
  let pendingCount = 0;
  let skippedCount = 0;

  for (const fileResult of testResults) {
    if (!fileResult || typeof fileResult !== "object") {
      continue;
    }
    // Jest uses testFilePath; Vitest uses name.
    const filePath = fileResult.testFilePath ?? fileResult.name ?? "";
    // Integration tests (*.integration.test.*) get a 20s budget; others get 10s.
    const isIntegration = /\.integration\.test\.[jt]sx?$/.test(filePath);
    const testBudgetMs = isIntegration ? 20_000 : 10_000;

    // Jest uses testResults[]; Vitest uses assertionResults[].
    const tests = fileResult.testResults ?? fileResult.assertionResults ?? [];

    for (const t of tests) {
      if (!t || typeof t !== "object") {
        continue;
      }
      if (t.status === "todo") {
        todoCount++;
        continue;
      }
      if (t.status === "pending") {
        pendingCount++;
        continue;
      }
      if (t.status === "skipped") {
        skippedCount++;
        continue;
      }
      const name =
        t.fullName ??
        (t.ancestorTitles?.length
          ? t.ancestorTitles.join(" > ") + " > " + t.title
          : t.title) ??
        "";
      const rec = {
        suite,
        file: filePath,
        name,
        duration: t.duration ?? null,
        status: t.status,
        budgetCategory: isIntegration ? "integration-test" : "normal-test",
        testBudgetMs,
        timedOut:
          t.failureMessages?.some((m) =>
            /exceeded timeout|Exceeded timeout|timed out/i.test(m)
          ) ?? false,
      };
      rec.budgetViolation =
        (rec.status === "passed" || rec.status === "failed") &&
        !rec.timedOut &&
        rec.duration != null &&
        rec.duration > rec.testBudgetMs;
      completedTests.push(rec);
      allTests.push(rec);
    }
  }

  const estimatedTotal = jestData?.numTotalTests ?? null;
  // "ran" = passed or failed assertions only. Pending/todo/skipped assertions
  // are declared but did not execute.
  const ranCount = completedTests.length;
  const suiteBudgetViolation =
    Number.isFinite(wallClockMs) &&
    Number.isFinite(budgetMs) &&
    wallClockMs > budgetMs;
  const evidenceContradiction =
    evidence.status === "CURRENT" &&
    ((passed && evidence.validation.hasFailures) ||
      (failed && evidence.validation.isPassing && ranCount > 0));

  suiteReports.push({
    suite,
    passed,
    failed,
    timedOut,
    exitCode,
    resultError,
    evidenceContradiction,
    wallClockMs,
    budgetMs,
    suiteBudgetViolation,
    completedTests,
    budgetViolationCount: completedTests.filter((t) => t.budgetViolation).length,
    ranCount,
    todoCount,
    pendingCount,
    skippedCount,
    estimatedTotal,
    evidence,
  });
}

// ── Build analysis ────────────────────────────────────────────────────────────

const slowTests = [...allTests]
  .filter((t) => t.duration != null)
  .sort((a, b) => b.duration - a.duration)
  .slice(0, 10);

const timedOutTests = allTests.filter((t) => t.timedOut);
const budgetViolations = allTests.filter((t) => t.budgetViolation);
const suiteBudgetViolations = suiteReports.filter((s) => s.suiteBudgetViolation);

const incompleteOrTimedOutSuites = suiteReports.filter(
  (s) => s.timedOut || s.resultError !== null || s.ranCount === 0
);
const unavailableEvidenceSuites = suiteReports.filter(
  (s) => s.evidence.status !== "CURRENT",
);

const hasViolations =
  timedOutTests.length > 0 ||
  budgetViolations.length > 0 ||
  suiteBudgetViolations.length > 0 ||
  incompleteOrTimedOutSuites.length > 0 ||
  suiteReports.some((s) => s.evidenceContradiction) ||
  suiteReports.some((s) => s.failed || s.timedOut) ||
  unavailableEvidenceSuites.length > 0;

// ── Emit report ──────────────────────────────────────────────────────────────

console.log();
console.log(hr("═"));
console.log("  TEST TIMEOUT REPORT");
console.log(hr("═"));

// Summary
console.log();
console.log("SUMMARY");
console.log(hr());
for (const s of suiteReports) {
  const statusTag = s.evidenceContradiction
    ? "CONTRADICT"
    : s.resultError !== null
    ? s.evidence.status.padEnd(10)
    : s.ranCount === 0
    ? "EMPTY     "
    : s.passed
    ? s.budgetViolationCount > 0 || s.suiteBudgetViolation
      ? "BUDGET_ERR"
      : "PASSED    "
    : s.timedOut
    ? "TIMED_OUT "
    : "FAILED    ";
  const wall = formatMs(s.wallClockMs);
  const budget = formatMs(s.budgetMs);
  const budgetNote =
    s.budgetMs != null
      ? ` (wall ${wall} / budget ${budget})`
      : ` (wall ${wall})`;
  const countNotes = [
    s.pendingCount > 0 ? `[${s.pendingCount} pending]` : "",
    s.todoCount > 0 ? `[${s.todoCount} todo]` : "",
    s.skippedCount > 0 ? `[${s.skippedCount} skipped]` : "",
  ].filter(Boolean);
  const deferredNote = countNotes.length > 0 ? `  ${countNotes.join(" ")}` : "";
  console.log(`  ${statusTag}  ${s.suite}${budgetNote}${deferredNote}`);
  if (s.resultError !== null) {
    console.log(`       Result artifact: ${s.resultError}`);
  } else if (s.evidenceContradiction) {
    console.log(
      `       Result artifact: package exit status disagrees with result metadata`,
    );
  } else if (s.ranCount === 0) {
    console.log("       Result artifact: no tests executed (pending/todo/skipped tests do not count).");
  }
}

// Result evidence
console.log();
console.log("RESULT EVIDENCE");
console.log(hr());
if (unavailableEvidenceSuites.length === 0) {
  console.log("  All suite results belong to the current validation run.");
} else {
  for (const s of unavailableEvidenceSuites) {
    console.log(`  ✗  ${s.suite} — ${s.evidence.status}: ${s.evidence.reason}`);
  }
}
const contradictoryEvidenceSuites = suiteReports.filter(
  (s) => s.evidenceContradiction || s.evidence.status === "CONTRADICTORY",
);
if (contradictoryEvidenceSuites.length > 0) {
  for (const s of contradictoryEvidenceSuites) {
    console.log(
      `  ✗  ${s.suite} — CONTRADICTORY: ${
        s.evidence.status === "CONTRADICTORY"
          ? s.evidence.reason
          : "package exit status disagrees with result metadata"
      }`,
    );
  }
}

// Slow tests
console.log();
console.log("TOP 10 SLOWEST TESTS");
console.log(hr());
if (slowTests.length === 0) {
  console.log("  (no timing data available)");
} else {
  console.log(
    `  ${pad("Duration", 10)}  ${pad("Budget", 8)}  ${pad("Delta", 10)}  ${pad("Suite", 14)}  Test`
  );
  console.log(`  ${hr("-", 8)}  ${hr("-", 6)}  ${hr("-", 8)}  ${hr("-", 12)}  ${hr("-", 40)}`);
  for (const t of slowTests) {
    const suiteName = t.suite.length > 14 ? t.suite.slice(0, 13) + "…" : t.suite;
    const testName = t.name.length > 55 ? t.name.slice(0, 52) + "…" : t.name;
    const budget = t.testBudgetMs ?? null;
    const budgetStr = budget != null ? formatMs(budget) : "?";
    let deltaStr = "?";
    if (budget != null && t.duration != null) {
      const delta = t.duration - budget;
      deltaStr = delta >= 0 ? `+${formatMs(delta)}` : `-${formatMs(Math.abs(delta))}`;
    }
    console.log(
      `  ${pad(formatMs(t.duration), 10)}  ${pad(budgetStr, 8)}  ${pad(deltaStr, 10)}  ${pad(suiteName, 14)}  ${testName}`
    );
  }
}

// Completed test budget violations
console.log();
console.log("TEST BUDGET VIOLATIONS (completed tests)");
console.log(hr());
if (budgetViolations.length === 0) {
  console.log("  None.");
} else {
  for (const t of budgetViolations) {
    const overBy = t.duration - t.testBudgetMs;
    console.log(`  ✗  [${t.budgetCategory}] [${t.suite}] ${t.name}`);
    console.log(
      `     Duration: ${formatMs(t.duration)} / Budget: ${formatMs(t.testBudgetMs)} (over by ${formatMs(overBy)})`
    );
    console.log(
      `     → ${
        t.status === "passed"
          ? "Completed successfully"
          : "Completed with a framework failure"
      }, but exceeded the applicable test duration budget.`
    );
    console.log();
  }
}

// Timeout violations
console.log();
console.log("SUITE BUDGET VIOLATIONS (wall clock)");
console.log(hr());
if (suiteBudgetViolations.length === 0) {
  console.log("  None.");
} else {
  for (const s of suiteBudgetViolations) {
    const overBy = s.wallClockMs - s.budgetMs;
    console.log(`  ✗  [suite-budget] [${s.suite}]`);
    console.log(
      `     Wall clock: ${formatMs(s.wallClockMs)} / Budget: ${formatMs(s.budgetMs)} (over by ${formatMs(overBy)})`,
    );
    console.log("     → Suite budget violation: current suite wall clock exceeded its manifest budget.");
    console.log();
  }
}

// Timeout violations
console.log();
console.log("TIMEOUT VIOLATIONS (individual tests)");
console.log(hr());
if (timedOutTests.length === 0) {
  console.log("  None.");
} else {
  for (const t of timedOutTests) {
    console.log(`  ✗  [${t.suite}] ${t.name}`);
    console.log(`     Duration: ${formatMs(t.duration)}`);
    if (/network|http|fetch|axios|request/i.test(t.name)) {
      console.log(`     → ${label("MOCK_DEPENDENCY")}`);
    } else if (/timer|interval|timeout|debounce|throttle/i.test(t.name)) {
      console.log(`     → ${label("FAKE_TIMERS")}`);
    } else if (/db|database|sql|postgres|drizzle/i.test(t.name)) {
      console.log(`     → ${label("CHECK_DB_POOL")}`);
    } else {
      console.log(`     → ${label("LOCAL_SETTIMEOUT")}`);
      console.log(`     → ${label("OPEN_HANDLES")}`);
    }
    console.log();
  }
}

// Incomplete suites
console.log();
console.log("INCOMPLETE / WALL-CLOCK CAPPED SUITES");
console.log(hr());
if (incompleteOrTimedOutSuites.length === 0) {
  console.log("  None.");
} else {
  for (const s of incompleteOrTimedOutSuites) {
    console.log(`  ✗  ${s.suite} — ${s.timedOut ? "TIMED OUT" : "FAILED (no tests ran)"}`);
    console.log(`     Tests completed: ${s.ranCount}`);
    if (s.estimatedTotal != null && s.estimatedTotal > s.ranCount) {
      console.log(
        `     Estimated not run: ${s.estimatedTotal - s.ranCount}`
      );
    }
    console.log(`     Wall clock: ${formatMs(s.wallClockMs)} / Budget: ${formatMs(s.budgetMs)}`);
    console.log();
    if (s.suite === "api-server") {
      console.log(`     Suggestions:`);
      console.log(`       → ${label("SPLIT_SUITE")}`);
      console.log(`       → ${label("CHECK_DB_POOL")}`);
      console.log(
        `       → Run with: pnpm --filter ./artifacts/api-server run test -- --testPathPattern=<pattern>`
      );
    } else {
      console.log(`     Suggestions:`);
      console.log(`       → ${label("SPLIT_SUITE")}`);
      console.log(`       → ${label("LOCAL_SETTIMEOUT")}`);
    }
    console.log();
  }
}

// GlobalSetup breach detection (look for schema-sync failure patterns in any failed suite)
const globalSetupViolations = suiteReports.filter(
  (s) =>
    s.failed &&
    s.ranCount === 0 &&
    !s.timedOut
);

if (globalSetupViolations.length > 0) {
  console.log();
  console.log("GLOBAL SETUP BREACHES (no tests ran — setup likely failed)");
  console.log(hr());
  for (const s of globalSetupViolations) {
    console.log(`  ✗  ${s.suite}`);
    console.log(`     Suggestions:`);
    console.log(`       → ${label("CHECK_CONNECTIVITY")}`);
    console.log(
      `       → Ensure DATABASE_URL is set and the DB is reachable before running tests.`
    );
    console.log(
      `       → Run: pnpm --filter ./artifacts/${s.suite} run test manually to see globalSetup output.`
    );
    console.log();
  }
}

console.log(hr("═"));
if (hasViolations) {
  console.log("  RESULT: Violations found — see sections above.");
} else {
  console.log("  RESULT: All suites passed within their budgets.");
}
console.log(hr("═"));
console.log();

process.exit(hasViolations ? 1 : 0);
