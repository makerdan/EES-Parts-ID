#!/usr/bin/env node
/**
 * Validate and atomically publish one test runner result.
 *
 * Runner output is written to a per-run staging file. This helper is the only
 * path that turns it into report evidence: it parses the JSON, stamps the
 * validation run ID, and renames a completed file into its final location.
 */

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { validateTestResultArtifact } from "./test-result-artifact.mjs";

const [sourcePath, destinationPath, runId, suite] = process.argv.slice(2);

if (!sourcePath || !destinationPath || !runId || !suite) {
  console.error(
    "Usage: node scripts/publish-test-result.mjs <staging.json> <result.json> <run-id> <suite>",
  );
  process.exit(2);
}

let result;
try {
  result = JSON.parse(readFileSync(sourcePath, "utf8"));
} catch (error) {
  console.error(`[test-result] cannot publish ${suite}: ${error.message}`);
  process.exit(1);
}

if (result === null || typeof result !== "object" || Array.isArray(result)) {
  console.error(`[test-result] cannot publish ${suite}: result JSON is not an object`);
  process.exit(1);
}

const validation = validateTestResultArtifact(result);
if (!validation.ok) {
  console.error(
    `[test-result] cannot publish ${suite}: invalid result evidence: ${validation.reason}`,
  );
  process.exit(1);
}

const published = {
  ...result,
  validationRunId: runId,
  validationSuite: suite,
};
const temporaryDestination = `${destinationPath}.publishing-${process.pid}`;

try {
  writeFileSync(temporaryDestination, `${JSON.stringify(published)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  renameSync(temporaryDestination, destinationPath);
} catch (error) {
  try {
    unlinkSync(temporaryDestination);
  } catch {
    // The original error is the useful diagnostic.
  }
  console.error(`[test-result] cannot publish ${suite}: ${error.message}`);
  process.exit(1);
}