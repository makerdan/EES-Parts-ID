#!/usr/bin/env node
import {
  AccountSkillProjectionError,
  syncAccountSkillProjection,
} from "./lib/account-skill-projection.mjs";

const FAILURE_REASONS = new Set([
  "atomic-install-failed",
  "incomplete-projection",
  "invalid-account-source",
  "invalid-skill-name",
  "projection-busy",
  "source-changed",
  "source-unavailable",
  "stale-projection",
  "unsupported-source-entry",
]);

try {
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
} catch (error) {
  const reason =
    error instanceof AccountSkillProjectionError && FAILURE_REASONS.has(error.code)
      ? error.code
      : "projection-failed";
  process.stdout.write(`${JSON.stringify({ outcome: "failed", reason })}\n`);
  process.exitCode = 1;
}