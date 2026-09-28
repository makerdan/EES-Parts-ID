#!/usr/bin/env node
/**
 * Refresh only the provenance headers of the checked-in CI parity report.
 *
 * The report is intentionally treated as an opaque analysis document. This
 * script replaces exactly one collection-date header and one repository-
 * revision header, leaving every other byte unchanged.
 */
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PARITY_REPORT_PATH = join(
  ROOT,
  "docs",
  "validation",
  "ci-validation-parity.md",
);
export const COLLECTION_DATE_HEADER =
  /^\*\*Collection date:\*\*[ \t]*(?:`([^`\r\n]*)`|([^\r\n]*?))[ \t]*$/gm;
export const REPOSITORY_REVISION_HEADER =
  /^\*\*Repository revision:\*\*[ \t]*(?:`([^`\r\n]*)`|([^\r\n]*?))[ \t]*$/gm;
const FULL_REVISION = /^[0-9a-f]{40}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidCollectionDate(value) {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function assertMetadata(metadata) {
  if (!FULL_REVISION.test(metadata.revision)) {
    throw new Error("checked-out repository revision is not a full SHA-1");
  }
  if (!isValidCollectionDate(metadata.collectionDate)) {
    throw new Error("collection date must be a valid UTC date in YYYY-MM-DD form");
  }
}

function replaceHeader(document, pattern, label, value) {
  const matches = [...document.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`parity report must contain exactly one ${label} header`);
  }
  return document.replace(pattern, (match) => {
    const delimiter = match.includes("`") ? "`" : "";
    return `**${label}:** ${delimiter}${value}${delimiter}`;
  });
}

/**
 * Replace only the report's collection date and repository revision headers.
 */
export function refreshParityReport(document, metadata) {
  assertMetadata(metadata);
  const withDate = replaceHeader(
    document,
    COLLECTION_DATE_HEADER,
    "Collection date",
    metadata.collectionDate,
  );
  return replaceHeader(
    withDate,
    REPOSITORY_REVISION_HEADER,
    "Repository revision",
    metadata.revision,
  );
}

/**
 * The report analyzes the checkout before the report commit. In a clean checkout
 * whose HEAD changed this report, its evidence revision is HEAD's first parent;
 * while drafting an uncommitted refresh, it is the current HEAD. A later commit
 * which does not refresh the report requires another refresh.
 */
export function getParityEvidenceRevision({ cwd = ROOT, reportPath = PARITY_REPORT_PATH } = {}) {
  const path = relative(cwd, reportPath);
  if (path.startsWith("..") || !path || path.startsWith("/")) {
    throw new Error("parity report must be inside the repository");
  }
  const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const head = git(["rev-parse", "--verify", "HEAD^{commit}"]);
  const modified = git(["diff", "--name-only", "HEAD", "--", path]);
  if (modified) return head;
  const changedInHead = git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD", "--", path]);
  return changedInHead ? git(["rev-parse", "--verify", "HEAD^1"]) : head;
}

/**
 * A clean, committed report may be historical. When its revision equals the
 * parent of the last report commit, it is stale; otherwise its provenance is
 * unverified. Neither status establishes current evidence or blocks unrelated
 * validation. A mismatch in the report-changing commit itself fails closed.
 */
export function getParityReportRevisionState({
  cwd = ROOT,
  reportPath = PARITY_REPORT_PATH,
  document = readFileSync(reportPath, "utf8"),
} = {}) {
  const path = relative(cwd, reportPath);
  if (path.startsWith("..") || !path || path.startsWith("/")) {
    throw new Error("parity report must be inside the repository");
  }
  const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const expectedRevision = getParityEvidenceRevision({ cwd, reportPath });
  const matches = [...document.matchAll(REPOSITORY_REVISION_HEADER)];
  const observedRevision = matches.length === 1 ? (matches[0][1] ?? matches[0][2]) : null;
  if (!observedRevision || !FULL_REVISION.test(observedRevision)) {
    return { status: "malformed", expectedRevision, observedRevision: null };
  }
  if (observedRevision === expectedRevision) {
    return { status: "current", expectedRevision, observedRevision };
  }
  // Never isolate an edited report: it may contain new analysis and must
  // identify the checkout against which that analysis was performed.
  if (git(["diff", "--name-only", "HEAD", "--", path])) {
    return { status: "mismatch", expectedRevision, observedRevision };
  }
  const lastReportCommit = git(["log", "-1", "--format=%H", "--", path]);
  if (!lastReportCommit) {
    return { status: "mismatch", expectedRevision, observedRevision };
  }
  const historicalRevision = git(["rev-parse", "--verify", `${lastReportCommit}^1`]);
  return {
    status: observedRevision === historicalRevision
      ? "stale"
      : lastReportCommit === git(["rev-parse", "--verify", "HEAD^{commit}"])
        ? "mismatch"
        : "unverified",
    expectedRevision,
    observedRevision,
  };
}

export function getParityReportMetadata({
  cwd = ROOT,
  now = new Date(),
  reportPath = PARITY_REPORT_PATH,
} = {}) {
  const revision = getParityEvidenceRevision({ cwd, reportPath });
  const collectionDate = now.toISOString().slice(0, 10);
  const metadata = { collectionDate, revision };
  assertMetadata(metadata);
  return metadata;
}

export function refreshParityReportFile({
  reportPath = PARITY_REPORT_PATH,
  metadata = getParityReportMetadata(),
} = {}) {
  const original = readFileSync(reportPath, "utf8");
  const refreshed = refreshParityReport(original, metadata);
  const revisions = [...original.matchAll(REPOSITORY_REVISION_HEADER)];
  if (revisions.length !== 1 || revisions[0][1] !== metadata.revision) {
    throw new Error(
      "refusing metadata-only refresh across revisions; collect a new parity analysis for the exact checkout first",
    );
  }
  const temporaryPath = `${reportPath}.tmp-${process.pid}`;
  try {
    writeFileSync(temporaryPath, refreshed, "utf8");
    renameSync(temporaryPath, reportPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return metadata;
}

function main() {
  if (process.argv.length !== 2) {
    console.error(
      "Usage: node scripts/refresh-ci-validation-parity-report.mjs",
    );
    process.exitCode = 1;
    return;
  }
  const metadata = refreshParityReportFile();
  console.log(
    "Refreshed CI validation parity metadata: " +
      `collection date ${metadata.collectionDate}; ` +
      `repository revision ${metadata.revision}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}