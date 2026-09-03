#!/usr/bin/env node
/**
 * Rebuild or verify the tracked Failure Gate distribution.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const DISTRIBUTION_FILES = [
  "docs/validation/failure-baseline.json",
  "docs/validation/failure-baseline.md",
  "scripts/check-failure-gate.mjs",
  "scripts/check-regression-guard.mjs",
  "scripts/lib/failure-baseline.mjs",
  "scripts/lib/tier-lock-check.mjs",
  "scripts/maintain-validation-baseline.mjs",
  "scripts/new-plan.mjs",
  "scripts/new-task-plan.mjs",
  "scripts/publish-failure-gate.mjs",
  "scripts/run-locked-tier.mjs",
  "scripts/run-tier.mjs",
  "scripts/test/failure-gate-contract.test.mjs",
  "scripts/test-heavy-serial.mjs",
  "scripts/validation-steps.mjs",
];
const archive = resolve("artifacts/failure-gate-skill.zip");

function archiveEntries(archivePath = archive) {
  if (!existsSync(archivePath)) return [];
  const result = spawnSync("unzip", ["-Z1", archivePath], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/).filter(Boolean) : [];
}

function verify(archivePath = archive) {
  const entries = new Set(archiveEntries(archivePath));
  const expected = ["SKILL.md", ...DISTRIBUTION_FILES];
  const missing = expected.filter((path) => !entries.has(path));
  if (missing.length) {
    console.error(`[failure-gate-package] missing entries: ${missing.join(", ")}`);
    return false;
  }
  const skill = spawnSync("unzip", ["-p", archivePath, "SKILL.md"], { encoding: "utf8" });
  const canonical = readFileSync(".agents/skills/failure-gate/SKILL.md", "utf8");
  if (skill.status !== 0 || skill.stdout !== canonical) {
    console.error("[failure-gate-package] SKILL.md does not match the tracked canonical skill.");
    return false;
  }
  for (const path of DISTRIBUTION_FILES) {
    const archived = spawnSync("unzip", ["-p", archivePath, path], { encoding: "buffer" });
    const current = readFileSync(path);
    if (archived.status !== 0 || !Buffer.from(archived.stdout).equals(current)) {
      console.error(`[failure-gate-package] packaged content is stale: ${path}`);
      return false;
    }
  }
  console.log(`[failure-gate-package] verified ${expected.length} required entries.`);
  return true;
}

function publish() {
  const staging = mkdtempSync(join(tmpdir(), "failure-gate-package-"));
  try {
    copyFileSync(".agents/skills/failure-gate/SKILL.md", join(staging, "SKILL.md"));
    for (const path of DISTRIBUTION_FILES) {
      const target = join(staging, path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(path, target);
    }
    writeFileSync(
      join(staging, "manifest.json"),
      JSON.stringify({ format: 1, source: ".agents/skills/failure-gate/SKILL.md", files: DISTRIBUTION_FILES }, null, 2) + "\n",
    );
    const temporaryArchive = `${archive}.tmp`;
    rmSync(temporaryArchive, { force: true });
    const result = spawnSync("zip", ["-q", "-X", "-r", temporaryArchive, "."], {
      cwd: staging,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      console.error(result.stderr || "[failure-gate-package] zip failed");
      return false;
    }
    mkdirSync(dirname(archive), { recursive: true });
    copyFileSync(temporaryArchive, archive);
    rmSync(temporaryArchive, { force: true });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  if (!verify()) return false;
  console.log(`[failure-gate-package] published ${archive}`);
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(process.argv.includes("--check") ? (verify() ? 0 : 1) : (publish() ? 0 : 1));
}

export { publish, verify };