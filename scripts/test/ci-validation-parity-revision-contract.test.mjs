#!/usr/bin/env node
/**
 * Keep the CI parity report tied to the checkout that produced it.
 *
 * This contract intentionally reports only the expected and observed revision
 * metadata. It must not dump the report or unrelated repository contents when
 * the metadata is malformed or stale.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getParityReportMetadata,
  getParityReportRevisionState,
  getParityEvidenceRevision,
  refreshParityReport,
  refreshParityReportFile,
} from "../refresh-ci-validation-parity-report.mjs";

const root = join(fileURLToPath(new URL("../..", import.meta.url)));
const parityReportPath = join(
  root,
  "docs",
  "validation",
  "ci-validation-parity.md",
);
const REVISION_HEADER = /^\*\*Repository revision:\*\*\s*`([^`\r\n]*)`\s*$/gm;
const FULL_REVISION = /^[0-9a-f]{40}$/;

export function inspectRepositoryRevision(document, expectedRevision) {
  const matches = [...document.matchAll(REVISION_HEADER)];
  if (matches.length !== 1 || !FULL_REVISION.test(expectedRevision)) {
    return {
      ok: false,
      reason: "malformed",
      expectedRevision,
      observedRevision: null,
    };
  }

  const observedRevision = matches[0][1];
  if (!FULL_REVISION.test(observedRevision)) {
    return {
      ok: false,
      reason: "malformed",
      expectedRevision,
      observedRevision: null,
    };
  }

  if (observedRevision !== expectedRevision) {
    return {
      ok: false,
      reason: "mismatch",
      expectedRevision,
      observedRevision,
    };
  }

  return {
    ok: true,
    reason: "match",
    expectedRevision,
    observedRevision,
  };
}

export function formatRepositoryRevisionFailure(result) {
  const observed = result.observedRevision ?? "<malformed>";
  if (result.reason === "mismatch") {
    return (
      "CI parity report repository revision mismatch: " +
      `expected=${result.expectedRevision} observed=${observed}`
    );
  }
  return (
    "CI parity report repository revision metadata is missing or malformed: " +
    `expected=${result.expectedRevision} observed=${observed}`
  );
}

const checkedOutRevision = execFileSync(
  "git",
  ["rev-parse", "--verify", "HEAD^{commit}"],
  { cwd: root, encoding: "utf8" },
).trim();
const expectedRevision = getParityEvidenceRevision({ cwd: root, reportPath: parityReportPath });
const reportChangedInWorktree = execFileSync(
  "git",
  ["diff", "--name-only", "HEAD", "--", "docs/validation/ci-validation-parity.md"],
  { cwd: root, encoding: "utf8" },
).trim();
const headChangedReport = execFileSync(
  "git",
  ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD", "--", "docs/validation/ci-validation-parity.md"],
  { cwd: root, encoding: "utf8" },
).trim();
const independentlyExpected = !reportChangedInWorktree && headChangedReport
  ? execFileSync("git", ["rev-parse", "--verify", "HEAD^1"], { cwd: root, encoding: "utf8" }).trim()
  : checkedOutRevision;
assert.equal(expectedRevision, independentlyExpected, "evidence revision must be the analyzed checkout");
const report = readFileSync(parityReportPath, "utf8");
const revisionState = getParityReportRevisionState({ cwd: root, reportPath: parityReportPath, document: report });
const result = inspectRepositoryRevision(report, expectedRevision);
assert.ok(
  ["current", "stale", "unverified"].includes(revisionState.status),
  formatRepositoryRevisionFailure(result),
);
if (revisionState.status === "current") {
  assert.equal(result.ok, true, formatRepositoryRevisionFailure(result));
} else {
  assert.equal(result.ok, false, "historical evidence must not be accepted as current");
  assert.equal(revisionState.observedRevision, result.observedRevision);
  console.log(
    `CI parity evidence ${revisionState.status.toUpperCase()} (not current): analyzed=${revisionState.observedRevision} checkout=${expectedRevision}; ` +
    "collect new revision-bound evidence before making current parity claims",
  );
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), "ci-parity-revision-"));
const temporaryReportPath = join(
  temporaryDirectory,
  "ci-validation-parity.md",
);
try {
  copyFileSync(parityReportPath, temporaryReportPath);
  if (revisionState.status !== "current") {
    assert.throws(
      () => refreshParityReportFile({ reportPath: temporaryReportPath }),
      /refusing metadata-only refresh across revisions/,
    );
    assert.equal(readFileSync(temporaryReportPath, "utf8"), report);
  } else {
    const generatedMetadata = refreshParityReportFile({ reportPath: temporaryReportPath });
    const generatedReport = readFileSync(temporaryReportPath, "utf8");
    assert.equal(generatedMetadata.revision, expectedRevision);
    assert.equal(inspectRepositoryRevision(generatedReport, expectedRevision).ok, true);
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

const fixtureRevision = "c".repeat(40);
const fixtureDate = "2026-09-22";
const fixtureAnalysis = [
  "# CI validation parity",
  "",
  "**Collection date:** `2026-01-01`",
  "**Repository revision:** `d000000000000000000000000000000000000000`",
  "",
  "Analysis with `repository details` that must remain unchanged.",
  "",
  "| unrelated | content |",
  "|---|---|",
  "| PRIVATE-CONTENT | stays private to this fixture |",
  "",
].join("\n");
const refreshedFixture = refreshParityReport(fixtureAnalysis, {
  collectionDate: fixtureDate,
  revision: fixtureRevision,
});
assert.equal(
  refreshedFixture,
  fixtureAnalysis
    .replace(
      "**Collection date:** `2026-01-01`",
      `**Collection date:** \`${fixtureDate}\``,
    )
    .replace(
      "**Repository revision:** `d000000000000000000000000000000000000000`",
      `**Repository revision:** \`${fixtureRevision}\``,
    ),
  "refresh must change only the two provenance headers",
);
assert.match(
  refreshedFixture,
  /Analysis with `repository details` that must remain unchanged\./,
);
assert.match(refreshedFixture, /PRIVATE-CONTENT/);

assert.deepEqual(
  getParityReportMetadata({
    cwd: root,
    now: new Date("2026-09-22T23:59:59.999Z"),
  }),
  {
    collectionDate: "2026-09-22",
    revision: expectedRevision,
  },
  "metadata capture must derive the evidence revision and UTC collection date together",
);

const historyDirectory = mkdtempSync(join(tmpdir(), "ci-parity-history-"));
try {
  const fixtureReportPath = join(historyDirectory, "parity.md");
  const git = (...args) => execFileSync("git", args, { cwd: historyDirectory, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Parity Fixture");
  git("config", "user.email", "parity@example.invalid");
  writeFileSync(fixtureReportPath, "first\n");
  git("add", "parity.md");
  git("commit", "-qm", "baseline");
  const baselineRevision = git("rev-parse", "HEAD");
  writeFileSync(fixtureReportPath, `**Repository revision:** \`${baselineRevision}\`\n`);
  assert.equal(getParityEvidenceRevision({ cwd: historyDirectory, reportPath: fixtureReportPath }), baselineRevision);
  assert.equal(getParityReportRevisionState({ cwd: historyDirectory, reportPath: fixtureReportPath }).status, "current");
  git("add", "parity.md");
  git("commit", "-qm", "report refresh");
  assert.equal(getParityEvidenceRevision({ cwd: historyDirectory, reportPath: fixtureReportPath }), baselineRevision,
    "a committed report must identify the analyzed parent checkout, not its self-referential commit");
  assert.equal(getParityReportRevisionState({ cwd: historyDirectory, reportPath: fixtureReportPath }).status, "current");
  writeFileSync(join(historyDirectory, "unrelated.txt"), "later change\n");
  git("add", "unrelated.txt");
  git("commit", "-qm", "unrelated revision");
  assert.notEqual(getParityEvidenceRevision({ cwd: historyDirectory, reportPath: fixtureReportPath }), baselineRevision,
    "an unrelated later commit must make the report stale");
  assert.equal(getParityReportRevisionState({ cwd: historyDirectory, reportPath: fixtureReportPath }).status, "stale");
  // A committed report with incorrect provenance remains quarantined after a
  // later commit; it must never be promoted to a current or verified state.
  writeFileSync(fixtureReportPath, `**Repository revision:** \`${"a".repeat(40)}\`\n`);
  git("add", "parity.md");
  git("commit", "-qm", "bad provenance");
  assert.equal(getParityReportRevisionState({ cwd: historyDirectory, reportPath: fixtureReportPath }).status, "mismatch");
  writeFileSync(join(historyDirectory, "later.txt"), "later\n");
  git("add", "later.txt");
  git("commit", "-qm", "later unrelated revision");
  assert.equal(getParityReportRevisionState({ cwd: historyDirectory, reportPath: fixtureReportPath }).status, "unverified");
  writeFileSync(fixtureReportPath,
    `**Collection date:** \`${fixtureDate}\`\n**Repository revision:** \`${baselineRevision}\`\n`);
  assert.throws(
    () => refreshParityReportFile({
      reportPath: fixtureReportPath,
      metadata: { collectionDate: fixtureDate, revision: git("rev-parse", "HEAD") },
    }),
    /refusing metadata-only refresh across revisions/,
  );
  assert.equal(readFileSync(fixtureReportPath, "utf8"),
    `**Collection date:** \`${fixtureDate}\`\n**Repository revision:** \`${baselineRevision}\`\n`);
  writeFileSync(fixtureReportPath, `**Repository revision:** \`${git("rev-parse", "HEAD")}\`\n`);
  assert.equal(getParityReportRevisionState({ cwd: historyDirectory, reportPath: fixtureReportPath }).status, "current");
  writeFileSync(fixtureReportPath, `**Repository revision:** \`${baselineRevision}\`\nchanged analysis\n`);
  assert.equal(getParityReportRevisionState({ cwd: historyDirectory, reportPath: fixtureReportPath }).status, "mismatch",
    "an edited report must not be isolated as historical");
  writeFileSync(fixtureReportPath, `**Repository revision:** \`${"b".repeat(40)}\`\n`);
  assert.equal(getParityReportRevisionState({ cwd: historyDirectory, reportPath: fixtureReportPath }).status, "mismatch");
  writeFileSync(fixtureReportPath, "**Repository revision:** `malformed`\n");
  assert.equal(getParityReportRevisionState({ cwd: historyDirectory, reportPath: fixtureReportPath }).status, "malformed");
} finally {
  rmSync(historyDirectory, { recursive: true, force: true });
}

for (const invalidDate of ["2026-02-30", "2026-02-29", "2026-13-01"]) {
  const invalidMetadata = {
    collectionDate: invalidDate,
    revision: fixtureRevision,
  };
  assert.throws(
    () => refreshParityReport(fixtureAnalysis, invalidMetadata),
    /collection date must be a valid UTC date/,
    `${invalidDate} must not produce report content`,
  );
  const invalidReportDirectory = mkdtempSync(join(tmpdir(), "ci-parity-invalid-date-"));
  const invalidReportPath = join(invalidReportDirectory, "ci-validation-parity.md");
  try {
    copyFileSync(parityReportPath, invalidReportPath);
    const original = readFileSync(invalidReportPath, "utf8");
    assert.throws(
      () => refreshParityReportFile({
        reportPath: invalidReportPath,
        metadata: invalidMetadata,
      }),
      /collection date must be a valid UTC date/,
      `${invalidDate} must not be written to the report`,
    );
    assert.equal(readFileSync(invalidReportPath, "utf8"), original);
    assert.equal(existsSync(`${invalidReportPath}.tmp-${process.pid}`), false);
  } finally {
    rmSync(invalidReportDirectory, { recursive: true, force: true });
  }
}

assert.throws(
  () =>
    refreshParityReport(fixtureAnalysis, {
      collectionDate: fixtureDate,
      revision: "not-a-revision",
    }),
  /full SHA-1/,
);
assert.throws(
  () =>
    refreshParityReport(
      fixtureAnalysis.replace("**Collection date:**", "**Other date:**"),
      { collectionDate: fixtureDate, revision: fixtureRevision },
    ),
  /exactly one Collection date header/,
);
assert.throws(
  () =>
    refreshParityReport(
      `${fixtureAnalysis}\n**Collection date:** \`2026-01-02\`\n`,
      { collectionDate: fixtureDate, revision: fixtureRevision },
    ),
  /exactly one Collection date header/,
);

const fixtureExpected = "a".repeat(40);
const fixtureObserved = "b".repeat(40);
const matching = inspectRepositoryRevision(
  `**Repository revision:** \`${fixtureExpected}\`\n`,
  fixtureExpected,
);
assert.deepEqual(matching, {
  ok: true,
  reason: "match",
  expectedRevision: fixtureExpected,
  observedRevision: fixtureExpected,
});

const stale = inspectRepositoryRevision(
  `**Repository revision:** \`${fixtureObserved}\`\n`,
  fixtureExpected,
);
assert.equal(stale.ok, false);
assert.equal(stale.reason, "mismatch");
assert.equal(
  formatRepositoryRevisionFailure(stale),
  `CI parity report repository revision mismatch: expected=${fixtureExpected} observed=${fixtureObserved}`,
);

const malformedDocument = [
  "**Repository revision:** `not-a-revision`",
  "unrelated repository contents: PRIVATE-CONTENT",
].join("\n");
const malformed = inspectRepositoryRevision(malformedDocument, fixtureExpected);
assert.equal(malformed.ok, false);
assert.equal(malformed.reason, "malformed");
const malformedMessage = formatRepositoryRevisionFailure(malformed);
assert.match(malformedMessage, new RegExp(`expected=${fixtureExpected}`));
assert.match(malformedMessage, /observed=<malformed>/);
assert.doesNotMatch(malformedMessage, /not-a-revision|PRIVATE-CONTENT/);

const missing = inspectRepositoryRevision(
  "This report has no revision header.\n",
  fixtureExpected,
);
assert.equal(missing.ok, false);
assert.equal(missing.reason, "malformed");
assert.equal(
  formatRepositoryRevisionFailure(missing),
  `CI parity report repository revision metadata is missing or malformed: expected=${fixtureExpected} observed=<malformed>`,
);

console.log(
  `CI validation parity revision contract: ${revisionState.status} report checked against ${expectedRevision}`,
);