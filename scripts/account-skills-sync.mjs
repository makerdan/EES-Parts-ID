#!/usr/bin/env node
import {
  AccountSkillProjectionError,
  recoverAccountSkillProjection,
  syncAccountSkillProjection,
} from "./lib/account-skill-projection.mjs";

const FAILURE_REASONS = new Set([
  "atomic-install-failed",
  "atomic-recovery-failed",
  "atomic-restore-failed",
  "incomplete-projection",
  "invalid-account-source",
  "invalid-skill-name",
  "projection-busy",
  "recovery-ambiguous",
  "recovery-destination-exists",
  "recovery-not-found",
  "source-changed",
  "source-unavailable",
  "stale-projection",
  "unsupported-source-entry",
]);

try {
  if (process.argv.includes("--recover")) {
    const result = await recoverAccountSkillProjection({
      accountSource: process.env.ACCOUNT_SKILLS_SOURCE,
    });
    process.stdout.write(`${JSON.stringify({ outcome: "recovered", changed: result.changed })}\n`);
  } else {
    const result = await syncAccountSkillProjection({
      accountSource: process.env.ACCOUNT_SKILLS_SOURCE,
    });
    process.stdout.write(
      `${JSON.stringify({
        outcome: "projected",
        changed: result.changed,
        skillCount: Object.keys(result.manifest.skills).length,
      })}\n`,
    );
  }
} catch (error) {
  const reason =
    error instanceof AccountSkillProjectionError && FAILURE_REASONS.has(error.code)
      ? error.code
      : "projection-failed";
  process.stdout.write(`${JSON.stringify({ outcome: "failed", reason })}\n`);
  process.exitCode = 1;
}