#!/usr/bin/env node
/**
 * Keep the CI parity report synchronized with the canonical standard-plus tier.
 *
 * The report intentionally includes local-only provenance rows, while heavy-only
 * coverage lives in a separate section. This check compares only the canonical
 * local-to-remote table with the standard-plus membership.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { getParityReportRevisionState } from "../refresh-ci-validation-parity-report.mjs";
import { getTierSteps } from "../validation-steps.mjs";

const COVERAGE_MAP_HEADING = "## Local-to-remote coverage map";
const HEAVY_ONLY_HEADING = "### Heavy-only coverage";

export function extractCanonicalCoverageRows(document) {
  const start = document.indexOf(COVERAGE_MAP_HEADING);
  const end = document.indexOf(HEAVY_ONLY_HEADING, start + COVERAGE_MAP_HEADING.length);
  assert.ok(start >= 0, `parity report is missing "${COVERAGE_MAP_HEADING}"`);
  assert.ok(end > start, `parity report is missing "${HEAVY_ONLY_HEADING}"`);

  return [...document.slice(start, end).matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map(
    ([, name]) => name,
  );
}

export function compareValidationParity(expectedNames, reportNames) {
  const expected = new Set(expectedNames);
  const reportCounts = new Map();
  for (const name of reportNames) {
    reportCounts.set(name, (reportCounts.get(name) ?? 0) + 1);
  }

  const missing = expectedNames.filter((name) => !reportCounts.has(name));
  const extra = reportNames.filter((name) => !expected.has(name));
  const duplicated = [...reportCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name, count]) => `${name} (x${count})`);

  return { missing, extra, duplicated };
}

export function formatValidationParityErrors({
  missing,
  extra,
  duplicated,
}) {
  const errors = [];
  if (missing.length) errors.push(`missing report rows: ${missing.join(", ")}`);
  if (extra.length) errors.push(`extra report rows: ${extra.join(", ")}`);
  if (duplicated.length) {
    errors.push(`duplicated report rows: ${duplicated.join(", ")}`);
  }
  return errors;
}

const reportPath = resolve("docs/validation/ci-validation-parity.md");
const parityDocument = readFileSync(reportPath, "utf8");
const revisionState = getParityReportRevisionState({ reportPath, document: parityDocument });
assert.ok(
  ["current", "stale", "unverified"].includes(revisionState.status),
  `CI parity report revision cannot be isolated: ${revisionState.status}`,
);
const expectedNames = getTierSteps("standard-plus").map(([name]) => name);
const reportNames = extractCanonicalCoverageRows(parityDocument);
const errors = formatValidationParityErrors(
  compareValidationParity(expectedNames, reportNames),
);

if (revisionState.status === "current") {
  assert.equal(
    errors.length,
    0,
    [
      "CI validation parity report is out of sync with the standard-plus tier.",
      ...errors.map((error) => `- ${error}`),
      "Update docs/validation/ci-validation-parity.md to restore one canonical row per standard-plus member.",
    ].join("\n"),
  );
} else {
  console.log(
    `Validation parity report ${revisionState.status.toUpperCase()} (not current): ` +
    `${errors.length} current-tier differences excluded from current coverage claims.`,
  );
}

const fixtureResult = compareValidationParity(
  ["alpha", "beta", "expected"],
  ["alpha", "beta", "beta", "unexpected"],
);
assert.deepEqual(fixtureResult, {
  missing: ["expected"],
  extra: ["unexpected"],
  duplicated: ["beta (x2)"],
});
assert.deepEqual(
  formatValidationParityErrors(fixtureResult),
  [
    "missing report rows: expected",
    "extra report rows: unexpected",
    "duplicated report rows: beta (x2)",
  ],
);

console.log(
  `Validation parity contract: ${expectedNames.length} standard-plus members; report status ${revisionState.status}.`,
);