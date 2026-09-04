#!/usr/bin/env node
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  ACCOUNT_SKILL_MIRROR_METADATA_FILE,
  ACCOUNT_SKILLS_MANIFEST_FILE,
  ACCOUNT_SKILLS_PROJECTION_RELATIVE_PATH,
  AccountSkillProjectionError,
  inspectAccountSkillMirror,
  loadAccountSkill,
  syncAccountSkillProjection,
} from "../lib/account-skill-projection.mjs";
import { scanPaths } from "./public-repository-boundary.test.mjs";
import { getTierSteps } from "../validation-steps.mjs";

const root = await mkdtemp(join(tmpdir(), "account-skill-projection-"));
const accountSource = join(root, "account-skills");
const workspaceRoot = join(root, "workspace");
const projectionRoot = join(workspaceRoot, ACCOUNT_SKILLS_PROJECTION_RELATIVE_PATH);
const authoredRoot = join(workspaceRoot, ".agents/skills/catalog");
const statusCommand = resolve("scripts/account-skill-status.mjs");

async function put(path, contents) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents);
}

async function expectProjectionError(operation, code) {
  await assert.rejects(operation, (error) => error instanceof AccountSkillProjectionError && error.code === code);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function runStatus(source = accountSource) {
  return spawnSync(process.execPath, [statusCommand, "--skill", "catalog"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: { ...process.env, ACCOUNT_SKILLS_SOURCE: source },
  });
}

try {
  await put(join(accountSource, ".account-revision"), "account-rev-1\n");
  await put(join(accountSource, "catalog/SKILL.md"), "# Catalog v1\n");
  await put(join(accountSource, "catalog/references/guide.md"), "supporting file\n");
  await put(join(accountSource, "review/SKILL.md"), "# Review\n");
  await put(join(authoredRoot, "SKILL.md"), "# Workspace-authored skill\n");

  const first = await syncAccountSkillProjection({ accountSource, workspaceRoot });
  assert.equal(first.changed, true, "the first invocation must create a projection");
  assert.equal(await readFile(join(projectionRoot, "catalog/references/guide.md"), "utf8"), "supporting file\n");
  const firstManifest = JSON.parse(await readFile(join(projectionRoot, ACCOUNT_SKILLS_MANIFEST_FILE), "utf8"));
  assert.equal(firstManifest.sourceRevision, "account-rev-1");
  assert.deepEqual(firstManifest.skills.catalog.files, ["references/guide.md", "SKILL.md"]);

  const loadedV1 = await loadAccountSkill({ accountSource, workspaceRoot, skillName: "catalog" });
  assert.equal(loadedV1.contents, "# Catalog v1\n");
  assert.equal(await readFile(join(authoredRoot, "SKILL.md"), "utf8"), "# Workspace-authored skill\n");

  const canonicalMetadata = first.manifest.skills.catalog;
  const mirrorRoot = join(workspaceRoot, ".local/custom_skills");
  assert.deepEqual(
    await inspectAccountSkillMirror({ accountSource, workspaceRoot, skillName: "catalog", mirrorRoot }),
    {
      outcome: "missing-mirror",
      skillId: "catalog",
      sourceRevision: "account-rev-1",
      fingerprint: canonicalMetadata.fingerprint,
    },
  );
  const missingMirrorCommand = runStatus();
  assert.equal(missingMirrorCommand.status, 3);
  assert.equal(JSON.parse(missingMirrorCommand.stdout).outcome, "missing-mirror");
  await put(
    join(mirrorRoot, "catalog", ACCOUNT_SKILL_MIRROR_METADATA_FILE),
    `${JSON.stringify({
      format: 1,
      skillId: "catalog",
      sourceRevision: "account-rev-1",
      fingerprint: canonicalMetadata.fingerprint,
    })}\n`,
  );
  assert.equal(
    (await inspectAccountSkillMirror({ accountSource, workspaceRoot, skillName: "catalog", mirrorRoot })).outcome,
    "pass",
  );
  const passingCommand = runStatus();
  assert.equal(passingCommand.status, 0);
  assert.deepEqual(Object.keys(JSON.parse(passingCommand.stdout)).sort(), [
    "fingerprint",
    "outcome",
    "skillId",
    "sourceRevision",
  ]);
  await put(
    join(mirrorRoot, "catalog", ACCOUNT_SKILL_MIRROR_METADATA_FILE),
    '{"format":1,"skillId":"catalog","sourceRevision":"wrong","fingerprint":"wrong"}\n',
  );
  assert.equal(
    (await inspectAccountSkillMirror({ accountSource, workspaceRoot, skillName: "catalog", mirrorRoot })).outcome,
    "mismatch",
  );
  const mismatchCommand = runStatus();
  assert.equal(mismatchCommand.status, 1);
  assert.deepEqual(JSON.parse(mismatchCommand.stdout), {
    outcome: "mismatch",
    skillId: "catalog",
    sourceRevision: "account-rev-1",
    fingerprint: canonicalMetadata.fingerprint,
    reason: "revision-mismatch",
  });
  assert.deepEqual(
    await inspectAccountSkillMirror({
      accountSource: join(root, "missing-account-source"),
      workspaceRoot,
      skillName: "catalog",
      mirrorRoot,
    }),
    { outcome: "unavailable-source", skillId: "catalog" },
  );
  const unavailableCommand = runStatus(join(root, "missing-account-source"));
  assert.equal(unavailableCommand.status, 2);
  assert.equal(JSON.parse(unavailableCommand.stdout).outcome, "unavailable-source");

  const missingRevisionSource = join(root, "missing-revision-source");
  await put(join(missingRevisionSource, "catalog/SKILL.md"), "# Catalog\n");
  const missingRevisionCommand = runStatus(missingRevisionSource);
  assert.equal(missingRevisionCommand.status, 2);
  assert.deepEqual(JSON.parse(missingRevisionCommand.stdout), {
    outcome: "unavailable-source",
    skillId: "catalog",
  });

  const malformedSource = join(root, "malformed-source");
  await put(join(malformedSource, ".account-revision"), "account-rev-malformed\n");
  await put(join(malformedSource, "unexpected.txt"), "not a skill directory\n");
  const malformedSourceCommand = runStatus(malformedSource);
  assert.equal(malformedSourceCommand.status, 2);
  assert.deepEqual(JSON.parse(malformedSourceCommand.stdout), {
    outcome: "unavailable-source",
    skillId: "catalog",
  });

  await writeFile(join(accountSource, "catalog/SKILL.md"), "# Catalog v2\n");
  await writeFile(join(accountSource, ".account-revision"), "account-rev-2\n");
  const loadedV2 = await loadAccountSkill({ accountSource, workspaceRoot, skillName: "catalog" });
  assert.equal(loadedV2.contents, "# Catalog v2\n", "invocation must refresh after an account revision changes");
  assert.equal(loadedV2.sourceRevision, "account-rev-2");

  await rm(join(projectionRoot, "catalog/references/guide.md"));
  await writeFile(join(accountSource, ".account-revision"), "account-rev-3\n");
  await expectProjectionError(
    () => loadAccountSkill({ accountSource: join(root, "missing-account-source"), workspaceRoot, skillName: "catalog" }),
    "source-unavailable",
  );
  const repaired = await loadAccountSkill({ accountSource, workspaceRoot, skillName: "catalog" });
  assert.equal(repaired.contents, "# Catalog v2\n", "an incomplete copy must be replaced before loading");
  assert.equal(await readFile(join(projectionRoot, "catalog/references/guide.md"), "utf8"), "supporting file\n");

  await rm(join(projectionRoot, ACCOUNT_SKILLS_MANIFEST_FILE));
  await writeFile(join(accountSource, ".account-revision"), "account-rev-4\n");
  await expectProjectionError(
    () => loadAccountSkill({ accountSource: join(root, "missing-account-source"), workspaceRoot, skillName: "catalog" }),
    "source-unavailable",
  );
  const repairedWithoutManifest = await loadAccountSkill({ accountSource, workspaceRoot, skillName: "catalog" });
  assert.equal(repairedWithoutManifest.sourceRevision, "account-rev-4");

  await rm(join(accountSource, "review"), { recursive: true });
  await writeFile(join(accountSource, ".account-revision"), "account-rev-5\n");
  await syncAccountSkillProjection({ accountSource, workspaceRoot });
  await assert.rejects(
    () => loadAccountSkill({ accountSource, workspaceRoot, skillName: "review" }),
    (error) => error instanceof AccountSkillProjectionError && error.code === "skill-not-found",
  );
  assert.equal(await readFile(join(authoredRoot, "SKILL.md"), "utf8"), "# Workspace-authored skill\n");

  const concurrentWorkspace = join(root, "concurrent-workspace");
  const concurrentProjectionRoot = join(concurrentWorkspace, ACCOUNT_SKILLS_PROJECTION_RELATIVE_PATH);
  const staleStaging = `${concurrentProjectionRoot}.staging-11111111-1111-4111-8111-111111111111`;
  const staleBackup = `${concurrentProjectionRoot}.backup-22222222-2222-4222-8222-222222222222`;
  const unrelatedLookalike = `${concurrentProjectionRoot}.staging-not-owned`;
  const lockPath = `${concurrentProjectionRoot}.lock`;
  await put(join(staleStaging, "partial.txt"), "interrupted staging fixture\n");
  await put(join(staleBackup, "partial.txt"), "interrupted backup fixture\n");
  await put(join(unrelatedLookalike, "keep.txt"), "unrelated fixture\n");
  await put(lockPath, "");
  await utimes(lockPath, new Date(0), new Date(0));
  const concurrentResults = await Promise.all([
    syncAccountSkillProjection({ accountSource, workspaceRoot: concurrentWorkspace }),
    syncAccountSkillProjection({ accountSource, workspaceRoot: concurrentWorkspace }),
  ]);
  assert.equal(
    concurrentResults.filter((result) => result.changed).length,
    1,
    "serialized concurrent refreshes must install exactly one projection",
  );
  assert.equal(await exists(staleStaging), false, "a stale owned staging directory must be removed under the lock");
  assert.equal(await exists(staleBackup), false, "a stale owned backup directory must be removed under the lock");
  assert.equal(await exists(unrelatedLookalike), true, "a similarly named directory not owned by the projection helper must remain");
  assert.equal(
    await readFile(join(concurrentProjectionRoot, "catalog/SKILL.md"), "utf8"),
    "# Catalog v2\n",
    "concurrent cleanup must not delete the active serialized refresh",
  );

  const liveLockWorkspace = join(root, "live-lock-workspace");
  const liveProjectionRoot = join(liveLockWorkspace, ACCOUNT_SKILLS_PROJECTION_RELATIVE_PATH);
  const liveStaging = `${liveProjectionRoot}.staging-33333333-3333-4333-8333-333333333333`;
  await put(join(liveStaging, "active.txt"), "active refresh fixture\n");
  await put(
    `${liveProjectionRoot}.lock`,
    `${JSON.stringify({ format: 1, pid: process.pid, token: "live-owner" })}\n`,
  );
  await expectProjectionError(
    () => syncAccountSkillProjection({ accountSource, workspaceRoot: liveLockWorkspace, lockTimeoutMs: 50 }),
    "projection-busy",
  );
  assert.equal(await exists(liveStaging), true, "a live lock must protect its active staging directory from cleanup");

  const contract = await readFile("docs/validation/account-level-skills.md", "utf8");
  assert.match(contract, /account\/platform-managed skill store is authoritative/i);
  assert.match(contract, /\.agents\/skills/);
  assert.match(contract, /\.local\/custom_skills/);
  assert.match(contract, /must not edit `.local\/custom_skills` directly/i);
  assert.match(contract, /fingerprint/i);
  assert.match(contract, /recursive/i);
  assert.match(contract, /account-skill:status/);
  assert.match(contract, /unavailable-source/);
  assert.match(contract, /missing-mirror/);
  assert.match(contract, /must not add a skill registry/i);

  const canonicalSkill = await readFile(".agents/skills/skill-mirror-sync/SKILL.md", "utf8");
  const canonicalSkillText = canonicalSkill.replace(/\s+/g, " ");
  assert.match(canonicalSkill, /^---\nname: skill-mirror-sync\n/m, "canonical skill must use lowercase identity frontmatter");
  assert.match(canonicalSkillText, /ACCOUNT_SKILLS_SOURCE.*authoritative/i);
  assert.match(canonicalSkillText, /\.agents\/skills\/\.account-projections\//);
  assert.match(canonicalSkillText, /recursively enumerate.*regular.*files/i);
  assert.match(canonicalSkillText, /SHA-256.*relative path.*bytes/i);
  assert.match(canonicalSkillText, /read-only.*command/i);
  assert.match(canonicalSkillText, /serialized.*lock/i);
  assert.match(canonicalSkillText, /atomic.*rename/i);
  assert.match(canonicalSkillText, /interrupted refresh/i);
  assert.match(canonicalSkillText, /never edit it directly/i);
  assert.match(canonicalSkillText, /never flows back/i);
  assert.match(canonicalSkillText, /MD5 is not an authoritative fingerprint/i);
  assert.doesNotMatch(
    canonicalSkillText,
    /directly copy.*canonical.*runtime|canonical.*directly.*runtime.*copy/i,
    "canonical skill must not endorse a direct canonical-to-runtime copy",
  );
  assert.ok(
    canonicalSkill.split("\n").length < 500,
    "canonical skill must remain under 500 lines",
  );

  const implementation = await readFile("scripts/lib/account-skill-projection.mjs", "utf8");
  const inspectionImplementation = implementation.slice(
    implementation.indexOf("export async function inspectAccountSkillMirror"),
    implementation.indexOf("async function fingerprintDirectory"),
  );
  assert.doesNotMatch(
    inspectionImplementation,
    /\b(writeFile|mkdir|rename|rm)\s*\(/,
    "account metadata inspection must not write the runtime mirror",
  );
  const ignored = await readFile(".gitignore", "utf8");
  assert.match(ignored, /\/\.agents\/skills\/\.account-projections\//);
  const generatedProjectionPath = ".agents/skills/.account-projections/catalog/SKILL.md";
  assert.ok(
    scanPaths([generatedProjectionPath], new Map([[generatedProjectionPath, "# generated fixture\n"]])).some((finding) =>
      finding.includes("generated account skill projection"),
    ),
    "repository boundary must reject a force-added account projection",
  );
  assert.ok(
    getTierSteps("fast").some(([name, command]) =>
      name === "skill-mirror-sync-contract" && command === "node scripts/test/skill-mirror-sync-contract.test.mjs",
    ),
    "focused contract must remain in the fast tier",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Skill Mirror Sync contract: recursive projection, freshness, ownership, atomicity, fail-closed source handling, and downstream boundary passed.");