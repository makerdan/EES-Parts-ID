#!/usr/bin/env node
/**
 * Opt-in baseline maintenance report. This never changes the catalog.
 */
import { BASELINE_PATH, readCatalog, todayUtc } from "./lib/failure-baseline.mjs";

const args = process.argv.slice(2);
const VALUE_OPTIONS = new Set(["--file", "--warning-days", "--max-evidence-days"]);
const FLAG_OPTIONS = new Set(["--json"]);
const jsonOutput = args.includes("--json");

function parseArgs() {
  const errors = [];
  const seen = new Set();
  const parsed = {
    file: BASELINE_PATH,
    warningDaysRaw: process.env.BASELINE_WARNING_DAYS ?? 30,
    maxEvidenceDaysRaw: process.env.BASELINE_MAX_EVIDENCE_DAYS ?? 90,
  };

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!VALUE_OPTIONS.has(option)) {
      if (option === "--json") {
        if (seen.has(option)) errors.push(`${option} may only be specified once.`);
        else seen.add(option);
        continue;
      }
      errors.push(`unsupported option ${JSON.stringify(option)}; use --file, --warning-days, --max-evidence-days, or --json.`);
      continue;
    }
    if (seen.has(option)) {
      errors.push(`${option} may only be specified once.`);
      continue;
    }
    seen.add(option);
    const value = args[index + 1];
    if (value === undefined || FLAG_OPTIONS.has(value) || VALUE_OPTIONS.has(value)) {
      if (option === "--warning-days") parsed.warningDaysRaw = undefined;
      else if (option === "--max-evidence-days") parsed.maxEvidenceDaysRaw = undefined;
      else errors.push(`${option} requires a value.`);
      continue;
    }
    index += 1;
    if (option === "--file") parsed.file = value;
    else if (option === "--warning-days") parsed.warningDaysRaw = value;
    else parsed.maxEvidenceDaysRaw = value;
  }

  return { parsed, errors };
}

const { parsed: parsedArgs, errors: argumentErrors } = parseArgs();

function parseThreshold(label, raw, example) {
  const value = Number(raw);
  if (
    raw === undefined ||
    (typeof raw === "string" && raw.trim() === "") ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    const received = raw === undefined ? "missing" : JSON.stringify(raw);
    return { error: `${label} must be a finite, non-negative integer (received ${received}); use ${example}.` };
  }
  return { value };
}

function fail(kind, errors) {
  const message = errors.join("; ");
  if (jsonOutput) {
    console.error(
      JSON.stringify({
        error: kind,
        code: kind === "invalid_configuration" ? "INVALID_CONFIGURATION" : "INVALID_CATALOG",
        message,
        errors,
      }),
    );
  } else {
    console.error(`[baseline-maintenance] INVALID: ${message}`);
  }
  process.exit(2);
}

if (argumentErrors.length > 0) {
  fail("invalid_configuration", argumentErrors);
}

const thresholdErrors = [];
const warningDaysResult = parseThreshold(
  args.includes("--warning-days") ? "--warning-days" : "BASELINE_WARNING_DAYS",
  parsedArgs.warningDaysRaw,
  args.includes("--warning-days") ? "--warning-days 14" : "BASELINE_WARNING_DAYS=14",
);
if (warningDaysResult.error) thresholdErrors.push(warningDaysResult.error);
const maxEvidenceDaysResult = parseThreshold(
  args.includes("--max-evidence-days") ? "--max-evidence-days" : "BASELINE_MAX_EVIDENCE_DAYS",
  parsedArgs.maxEvidenceDaysRaw,
  args.includes("--max-evidence-days") ? "--max-evidence-days 90" : "BASELINE_MAX_EVIDENCE_DAYS=90",
);
if (maxEvidenceDaysResult.error) thresholdErrors.push(maxEvidenceDaysResult.error);

if (thresholdErrors.length > 0) {
  fail("invalid_configuration", thresholdErrors);
}

const warningDays = warningDaysResult.value;
const maxEvidenceDays = maxEvidenceDaysResult.value;
const result = readCatalog(parsedArgs.file);

if (!result.ok) {
  fail("invalid_catalog", result.errors);
}

const today = new Date(`${todayUtc()}T00:00:00Z`);
const findings = [];
const FINDING_KINDS = Object.freeze({
  expired: "expired",
  reviewDue: "review-due",
  staleEvidence: "stale-evidence",
});
const daysBetween = (a, b) => Math.floor((b.getTime() - a.getTime()) / 86400000);
for (const record of result.catalog.records) {
  if (record.status !== "active") continue;
  const deadline = new Date(`${record.reviewDeadline}T00:00:00Z`);
  const evidence = new Date(`${record.evidenceDate}T00:00:00Z`);
  const untilReview = daysBetween(today, deadline);
  const sinceEvidence = daysBetween(evidence, today);
  if (untilReview < 0) {
    findings.push({
      kind: FINDING_KINDS.expired,
      record,
      message: `review deadline ${record.reviewDeadline} has expired`,
    });
  } else if (untilReview <= warningDays) {
    findings.push({
      kind: FINDING_KINDS.reviewDue,
      record,
      message: `review due in ${untilReview} day(s)`,
    });
  }
  if (sinceEvidence > maxEvidenceDays) {
    findings.push({
      kind: FINDING_KINDS.staleEvidence,
      record,
      message: `evidence is ${sinceEvidence} day(s) old`,
    });
  }
}

if (jsonOutput) {
  console.log(
    JSON.stringify(
      {
        catalog: result.path,
        generated: todayUtc(),
        thresholds: { warningDays, maxEvidenceDays },
        findings,
      },
      null,
      2,
    ),
  );
} else if (findings.length === 0) {
  console.log(`[baseline-maintenance] No active baseline records need attention (${result.catalog.records.length} total record(s)).`);
} else {
  console.log(`[baseline-maintenance] ${findings.length} finding(s):`);
  for (const finding of findings) console.log(`- ${finding.kind}: ${finding.record.id} — ${finding.message}`);
}
// Maintenance is a report, not a validation gate. Findings are informational.
process.exit(0);