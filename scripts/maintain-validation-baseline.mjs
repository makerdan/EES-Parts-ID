#!/usr/bin/env node
/**
 * Opt-in baseline maintenance report. This never changes the catalog.
 */
import { BASELINE_PATH, readCatalog, todayUtc } from "./lib/failure-baseline.mjs";

const args = process.argv.slice(2);
const fileIndex = args.indexOf("--file");
const warningIndex = args.indexOf("--warning-days");
const file = fileIndex >= 0 ? args[fileIndex + 1] : BASELINE_PATH;
const warningDays = Number(warningIndex >= 0 ? args[warningIndex + 1] : process.env.BASELINE_WARNING_DAYS ?? 30);
const maxEvidenceDays = Number(process.env.BASELINE_MAX_EVIDENCE_DAYS ?? 90);
const result = readCatalog(file);

if (!result.ok) {
  console.error(`[baseline-maintenance] INVALID: ${result.errors.join("; ")}`);
  process.exit(2);
}

const today = new Date(`${todayUtc()}T00:00:00Z`);
const findings = [];
const daysBetween = (a, b) => Math.floor((b.getTime() - a.getTime()) / 86400000);
for (const record of result.catalog.records) {
  if (record.status !== "active") continue;
  const deadline = new Date(`${record.reviewDeadline}T00:00:00Z`);
  const evidence = new Date(`${record.evidenceDate}T00:00:00Z`);
  const untilReview = daysBetween(today, deadline);
  const sinceEvidence = daysBetween(evidence, today);
  if (untilReview < 0) findings.push({ kind: "expired", record, message: `review deadline ${record.reviewDeadline} has expired` });
  else if (untilReview <= warningDays) findings.push({ kind: "review-due", record, message: `review due in ${untilReview} day(s)` });
  if (sinceEvidence > maxEvidenceDays) findings.push({ kind: "stale-evidence", record, message: `evidence is ${sinceEvidence} day(s) old` });
}

if (args.includes("--json")) {
  console.log(JSON.stringify({ catalog: result.path, generated: todayUtc(), findings }, null, 2));
} else if (findings.length === 0) {
  console.log(`[baseline-maintenance] No active baseline records need attention (${result.catalog.records.length} total record(s)).`);
} else {
  console.log(`[baseline-maintenance] ${findings.length} finding(s):`);
  for (const finding of findings) console.log(`- ${finding.kind}: ${finding.record.id} — ${finding.message}`);
}
// Maintenance is a report, not a validation gate. Findings are informational.
process.exit(0);