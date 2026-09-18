#!/usr/bin/env node
import assert from "node:assert/strict";
import { access, chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
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
  recoverAccountSkillProjection,
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
const syncCommand = resolve("scripts/account-skills-sync.mjs");
const SKILL_MIRROR_COMMAND_TIMEOUT_MS = 5_000;

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

async function snapshotTree(root) {
  if (!(await exists(root))) return undefined;
  const entries = [];
  async function visit(current, relative = "") {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const entryPath = join(current, entry.name);
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        entries.push([entryRelative, "directory"]);
        await visit(entryPath, entryRelative);
      } else if (entry.isFile()) {
        const fileStat = await lstat(entryPath);
        try {
          entries.push([entryRelative, "file", (await readFile(entryPath)).toString("base64"), fileStat.mode & 0o777]);
        } catch (error) {
          if (error.code !== "EACCES") throw error;
          entries.push([entryRelative, "unreadable-file", fileStat.mode & 0o777]);
        }
      } else if (entry.isSymbolicLink()) {
        entries.push([entryRelative, "symbolic-link"]);
      } else {
        entries.push([entryRelative, "other"]);
      }
    }
  }
  await visit(root);
  return entries;
}

function runBoundedCommand(command, args, { cwd, env, label, timeoutMs = SKILL_MIRROR_COMMAND_TIMEOUT_MS } = {}) {
  const result = spawnSync(command, args, {
    cwd: cwd ?? workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const timedOut = result.error?.code === "ETIMEDOUT";
  result.timedOut = timedOut;
  result.timeoutMessage = timedOut ? `${label ?? command} timed out after ${timeoutMs} ms` : undefined;
  return result;
}

function assertCommandDidNotTimeOut(result, label) {
  assert.equal(result.timedOut, false, result.timeoutMessage ?? `${label} unexpectedly timed out`);
}

function runStatus(source = accountSource, mirrorRoot) {
  const result = runBoundedCommand(process.execPath, [statusCommand, "--skill", "catalog"], {
    label: "account skill status",
    env: {
      ACCOUNT_SKILLS_SOURCE: source,
      ...(mirrorRoot ? { ACCOUNT_SKILLS_MIRROR_ROOT: mirrorRoot } : {}),
    },
  });
  assertCommandDidNotTimeOut(result, "account skill status");
  return result;
}

function runSync(source = accountSource, cwd = workspaceRoot) {
  const result = runBoundedCommand(process.execPath, [syncCommand], {
    cwd,
    label: "account skill sync",
    env: { ACCOUNT_SKILLS_SOURCE: source },
  });
  assertCommandDidNotTimeOut(result, "account skill sync");
  return result;
}

async function canCreateReadPermissionBoundary(filePath) {
  try {
    await readFile(filePath);
    return false;
  } catch (error) {
    if (error.code !== "EACCES") throw error;
    return true;
  }
}

try {
  await put(join(accountSource, ".account-revision"), "account-rev-1\n");
  await put(join(accountSource, "catalog/SKILL.md"), "# Catalog v1\n");
  await put(join(accountSource, "catalog/references/guide.md"), "supporting file\n");
  await put(join(accountSource, "review/SKILL.md"), "# Review\n");
  await put(join(authoredRoot, "SKILL.md"), "# Workspace-authored skill\n");

  const stalledCommand = runBoundedCommand(
    process.execPath,
    ["-e", "setInterval(() => {}, 60_000)"],
    { label: "skill mirror timeout fixture", timeoutMs: 100 },
  );
  assert.equal(stalledCommand.timedOut, true);
  assert.equal(stalledCommand.status, null);
  assert.equal(stalledCommand.signal, "SIGKILL");
  assert.match(stalledCommand.timeoutMessage, /skill mirror timeout fixture timed out after 100 ms/);

  const deniedCanonicalSource = join(root, "denied-canonical-source");
  const deniedRevisionPath = join(deniedCanonicalSource, ".account-revision");
  await put(deniedRevisionPath, "denied-revision\n");
  await put(join(deniedCanonicalSource, "catalog/SKILL.md"), "private canonical bytes\n");
  const deniedRevisionMode = (await lstat(deniedRevisionPath)).mode & 0o777;
  await chmod(deniedRevisionPath, 0o000);
  try {
    if (await canCreateReadPermissionBoundary(deniedRevisionPath)) {
      const deniedSourceCommand = runStatus(deniedCanonicalSource);
      assert.equal(deniedSourceCommand.status, 2, deniedSourceCommand.stderr);
      assert.deepEqual(JSON.parse(deniedSourceCommand.stdout), {
        outcome: "unavailable-source",
        skillId: "catalog",
      });
      assert.doesNotMatch(
        deniedSourceCommand.stdout,
        /denied-canonical-source|private canonical bytes|EACCES|permission denied|readFile|account-revision/,
        "permission-denied canonical status must not expose source paths, private bytes, or filesystem errors",
      );
    } else {
      console.log("SKIP: runner could not create a read permission boundary for the canonical revision file");
    }
  } finally {
    await chmod(deniedRevisionPath, deniedRevisionMode);
  }

  const firstCommand = runSync();
  assert.equal(firstCommand.status, 0, firstCommand.stderr);
  assert.deepEqual(JSON.parse(firstCommand.stdout), {
    outcome: "projected",
    changed: true,
    skillCount: 2,
  });
  assert.equal(await readFile(join(projectionRoot, "catalog/references/guide.md"), "utf8"), "supporting file\n");
  const firstManifest = JSON.parse(await readFile(join(projectionRoot, ACCOUNT_SKILLS_MANIFEST_FILE), "utf8"));
  assert.equal(firstManifest.sourceRevision, "account-rev-1");
  assert.deepEqual(firstManifest.skills.catalog.files, ["references/guide.md", "SKILL.md"]);
  assert.deepEqual(Object.keys(firstManifest.skills).sort(), ["catalog", "review"]);
  const first = await syncAccountSkillProjection({ accountSource, workspaceRoot });
  assert.equal(first.changed, false, "the public command must install through the canonical helper");

  const loadedV1 = await loadAccountSkill({ accountSource, workspaceRoot, skillName: "catalog" });
  assert.equal(loadedV1.contents, "# Catalog v1\n");
  assert.equal(await readFile(join(authoredRoot, "SKILL.md"), "utf8"), "# Workspace-authored skill\n");

  await writeFile(join(accountSource, "catalog/SKILL.md"), "# Catalog same revision\n");
  const loadedSameRevision = await loadAccountSkill({ accountSource, workspaceRoot, skillName: "catalog" });
  assert.equal(
    loadedSameRevision.contents,
    "# Catalog same revision\n",
    "invocation must refresh when source bytes change without a revision change",
  );

  const canonicalMetadata = { fingerprint: loadedSameRevision.fingerprint };
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
  const missingMirrorBefore = await snapshotTree(mirrorRoot);
  const missingMirrorCommand = runStatus();
  assert.equal(missingMirrorCommand.status, 3);
  assert.equal(JSON.parse(missingMirrorCommand.stdout).outcome, "missing-mirror");
  assert.deepEqual(await snapshotTree(mirrorRoot), missingMirrorBefore, "missing-mirror status must be read-only");
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
  const passingBefore = await snapshotTree(mirrorRoot);
  const passingCommand = runStatus();
  assert.equal(passingCommand.status, 0);
  assert.deepEqual(Object.keys(JSON.parse(passingCommand.stdout)).sort(), [
    "fingerprint",
    "outcome",
    "skillId",
    "sourceRevision",
  ]);
  assert.deepEqual(await snapshotTree(mirrorRoot), passingBefore, "pass status must be read-only");
  const platformMirrorRoot = join(root, "platform-runtime-mirror");
  await put(
    join(platformMirrorRoot, "catalog", ACCOUNT_SKILL_MIRROR_METADATA_FILE),
    `${JSON.stringify({
      format: 1,
      skillId: "catalog",
      sourceRevision: "account-rev-1",
      fingerprint: canonicalMetadata.fingerprint,
    })}\n`,
  );
  await put(
    join(mirrorRoot, "catalog", ACCOUNT_SKILL_MIRROR_METADATA_FILE),
    '{"format":1,"skillId":"catalog","sourceRevision":"wrong","fingerprint":"wrong"}\n',
  );
  const platformPassBefore = await snapshotTree(platformMirrorRoot);
  const disposableDuringPlatformPass = await snapshotTree(mirrorRoot);
  const platformRootCommand = runStatus(accountSource, platformMirrorRoot);
  assert.equal(platformRootCommand.status, 0);
  assert.deepEqual(JSON.parse(platformRootCommand.stdout), {
    outcome: "pass",
    skillId: "catalog",
    sourceRevision: "account-rev-1",
    fingerprint: canonicalMetadata.fingerprint,
  });
  assert.deepEqual(await snapshotTree(platformMirrorRoot), platformPassBefore, "platform pass status must be read-only");
  assert.deepEqual(
    await snapshotTree(mirrorRoot),
    disposableDuringPlatformPass,
    "platform pass status must not write the disposable mirror",
  );
  assert.doesNotMatch(platformRootCommand.stdout, /platform-runtime-mirror|Catalog v1|Catalog same revision/);
  await put(
    join(platformMirrorRoot, "catalog", ACCOUNT_SKILL_MIRROR_METADATA_FILE),
    '{"format":1,"skillId":"catalog","sourceRevision":"wrong","fingerprint":"wrong"}\n',
  );
  const platformMismatchBefore = await snapshotTree(platformMirrorRoot);
  const platformMismatchCommand = runStatus(accountSource, platformMirrorRoot);
  assert.equal(platformMismatchCommand.status, 1);
  assert.deepEqual(JSON.parse(platformMismatchCommand.stdout), {
    outcome: "mismatch",
    skillId: "catalog",
    sourceRevision: "account-rev-1",
    fingerprint: canonicalMetadata.fingerprint,
    reason: "revision-mismatch",
  });
  assert.deepEqual(
    await snapshotTree(platformMirrorRoot),
    platformMismatchBefore,
    "platform mismatch status must be read-only",
  );
  await put(
    join(mirrorRoot, "catalog", ACCOUNT_SKILL_MIRROR_METADATA_FILE),
    '{"format":1,"skillId":"catalog","sourceRevision":"wrong","fingerprint":"wrong"}\n',
  );
  assert.equal(
    (await inspectAccountSkillMirror({ accountSource, workspaceRoot, skillName: "catalog", mirrorRoot })).outcome,
    "mismatch",
  );
  const mismatchBefore = await snapshotTree(mirrorRoot);
  const mismatchCommand = runStatus();
  assert.equal(mismatchCommand.status, 1);
  assert.deepEqual(JSON.parse(mismatchCommand.stdout), {
    outcome: "mismatch",
    skillId: "catalog",
    sourceRevision: "account-rev-1",
    fingerprint: canonicalMetadata.fingerprint,
    reason: "revision-mismatch",
  });
  assert.deepEqual(await snapshotTree(mirrorRoot), mismatchBefore, "mismatch status must be read-only");
  assert.deepEqual(
    await inspectAccountSkillMirror({
      accountSource: join(root, "missing-account-source"),
      workspaceRoot,
      skillName: "catalog",
      mirrorRoot,
    }),
    { outcome: "unavailable-source", skillId: "catalog" },
  );
  const unavailableBefore = await snapshotTree(mirrorRoot);
  const unavailableCommand = runStatus(join(root, "missing-account-source"));
  assert.equal(unavailableCommand.status, 2);
  assert.equal(JSON.parse(unavailableCommand.stdout).outcome, "unavailable-source");
  assert.deepEqual(await snapshotTree(mirrorRoot), unavailableBefore, "unavailable-source status must be read-only");
  const missingPlatformRoot = join(root, "missing-platform-root");
  const missingPlatformBefore = await snapshotTree(missingPlatformRoot);
  const missingPlatformRootCommand = runStatus(accountSource, missingPlatformRoot);
  assert.equal(missingPlatformRootCommand.status, 3);
  assert.deepEqual(JSON.parse(missingPlatformRootCommand.stdout), {
    outcome: "missing-mirror",
    skillId: "catalog",
    sourceRevision: "account-rev-1",
    fingerprint: canonicalMetadata.fingerprint,
  });
  assert.deepEqual(
    await snapshotTree(missingPlatformRoot),
    missingPlatformBefore,
    "missing-mirror status with a missing root must be read-only",
  );

  await put(
    join(mirrorRoot, "catalog", ACCOUNT_SKILL_MIRROR_METADATA_FILE),
    `${JSON.stringify({
      format: 1,
      skillId: "catalog",
      sourceRevision: "account-rev-1",
      fingerprint: canonicalMetadata.fingerprint,
    })}\n`,
  );
  await writeFile(join(accountSource, ".account-revision"), "account-rev-2\n");
  const revisionMismatchBefore = await snapshotTree(mirrorRoot);
  const revisionMismatchCommand = runStatus();
  assert.equal(revisionMismatchCommand.status, 1);
  assert.deepEqual(JSON.parse(revisionMismatchCommand.stdout), {
    outcome: "mismatch",
    skillId: "catalog",
    sourceRevision: "account-rev-2",
    fingerprint: canonicalMetadata.fingerprint,
    reason: "revision-mismatch",
  });
  assert.deepEqual(
    await snapshotTree(mirrorRoot),
    revisionMismatchBefore,
    "revision mismatch status must be read-only",
  );

  await put(
    join(mirrorRoot, "catalog", ACCOUNT_SKILL_MIRROR_METADATA_FILE),
    `${JSON.stringify({
      format: 1,
      skillId: "catalog",
      sourceRevision: "account-rev-2",
      fingerprint: canonicalMetadata.fingerprint,
    })}\n`,
  );
  assert.equal(
    (await inspectAccountSkillMirror({ accountSource, workspaceRoot, skillName: "catalog", mirrorRoot })).outcome,
    "pass",
    "refreshing mirror revision metadata should clear the stale result",
  );

  await writeFile(join(accountSource, "catalog/SKILL.md"), "# Catalog fingerprint v2\n");
  const fingerprintCanonical = await inspectAccountSkillMirror({
    accountSource,
    workspaceRoot,
    skillName: "catalog",
    mirrorRoot,
  });
  assert.equal(fingerprintCanonical.outcome, "mismatch");
  const fingerprintMismatchBefore = await snapshotTree(mirrorRoot);
  const fingerprintMismatchCommand = runStatus();
  assert.equal(fingerprintMismatchCommand.status, 1);
  assert.deepEqual(JSON.parse(fingerprintMismatchCommand.stdout), {
    outcome: "mismatch",
    skillId: "catalog",
    sourceRevision: "account-rev-2",
    fingerprint: fingerprintCanonical.fingerprint,
    reason: "fingerprint-mismatch",
  });
  assert.deepEqual(
    await snapshotTree(mirrorRoot),
    fingerprintMismatchBefore,
    "fingerprint mismatch status must be read-only",
  );
  await put(
    join(mirrorRoot, "catalog", ACCOUNT_SKILL_MIRROR_METADATA_FILE),
    `${JSON.stringify({
      format: 1,
      skillId: "catalog",
      sourceRevision: fingerprintCanonical.sourceRevision,
      fingerprint: fingerprintCanonical.fingerprint,
    })}\n`,
  );
  assert.equal(
    (await inspectAccountSkillMirror({ accountSource, workspaceRoot, skillName: "catalog", mirrorRoot })).outcome,
    "pass",
    "refreshing mirror fingerprint metadata should clear the stale result",
  );

  const permissionMirrorRoot = join(root, "permission-metadata-mirror");
  await put(
    join(permissionMirrorRoot, "catalog", ACCOUNT_SKILL_MIRROR_METADATA_FILE),
    `${JSON.stringify({
      format: 1,
      skillId: "catalog",
      sourceRevision: fingerprintCanonical.sourceRevision,
      fingerprint: fingerprintCanonical.fingerprint,
    })}\n`,
  );
  const permissionSidecar = join(permissionMirrorRoot, "catalog", ACCOUNT_SKILL_MIRROR_METADATA_FILE);
  await chmod(permissionSidecar, 0o000);
  const permissionBefore = await snapshotTree(permissionMirrorRoot);
  const permissionCommand = runStatus(accountSource, permissionMirrorRoot);
  assert.equal(permissionCommand.status, 1);
  assert.deepEqual(JSON.parse(permissionCommand.stdout), {
    outcome: "mismatch",
    skillId: "catalog",
    sourceRevision: fingerprintCanonical.sourceRevision,
    fingerprint: fingerprintCanonical.fingerprint,
    reason: "invalid-mirror-metadata",
  });
  assert.deepEqual(
    await snapshotTree(permissionMirrorRoot),
    permissionBefore,
    "permission-denied metadata status must be read-only",
  );
  assert.doesNotMatch(permissionCommand.stdout, /permission-metadata-mirror|Catalog fingerprint v2/);

  const directoryMirrorRoot = join(root, "directory-shaped-metadata-mirror");
  const directorySidecar = join(directoryMirrorRoot, "catalog", ACCOUNT_SKILL_MIRROR_METADATA_FILE);
  await mkdir(directorySidecar, { recursive: true });
  await put(join(directorySidecar, "private.txt"), "private metadata fixture\n");
  const directoryBefore = await snapshotTree(directoryMirrorRoot);
  const directoryCommand = runStatus(accountSource, directoryMirrorRoot);
  assert.equal(directoryCommand.status, 1);
  assert.deepEqual(JSON.parse(directoryCommand.stdout), {
    outcome: "mismatch",
    skillId: "catalog",
    sourceRevision: fingerprintCanonical.sourceRevision,
    fingerprint: fingerprintCanonical.fingerprint,
    reason: "invalid-mirror-metadata",
  });
  assert.deepEqual(
    await snapshotTree(directoryMirrorRoot),
    directoryBefore,
    "directory-shaped metadata status must be read-only",
  );
  assert.doesNotMatch(directoryCommand.stdout, /directory-shaped-metadata-mirror|private metadata fixture/);

  const linkedMirrorRoot = join(root, "linked-metadata-mirror");
  const linkedTarget = join(root, "linked-metadata-target.json");
  await put(
    linkedTarget,
    `${JSON.stringify({
      format: 1,
      skillId: "catalog",
      sourceRevision: fingerprintCanonical.sourceRevision,
      fingerprint: fingerprintCanonical.fingerprint,
    })}\n`,
  );
  await mkdir(join(linkedMirrorRoot, "catalog"), { recursive: true });
  await symlink(linkedTarget, join(linkedMirrorRoot, "catalog", ACCOUNT_SKILL_MIRROR_METADATA_FILE));
  const linkedCommand = runStatus(accountSource, linkedMirrorRoot);
  assert.equal(linkedCommand.status, 1);
  assert.deepEqual(JSON.parse(linkedCommand.stdout), {
    outcome: "mismatch",
    skillId: "catalog",
    sourceRevision: fingerprintCanonical.sourceRevision,
    fingerprint: fingerprintCanonical.fingerprint,
    reason: "invalid-mirror-metadata",
  });

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
  const unavailableSync = runSync(join(root, "missing-account-source"));
  assert.equal(unavailableSync.status, 1);
  assert.deepEqual(JSON.parse(unavailableSync.stdout), {
    outcome: "failed",
    reason: "source-unavailable",
  });
  assert.doesNotMatch(unavailableSync.stdout, /missing-account-source|account-skill-projection-/);
  const malformedSync = runSync(malformedSource);
  assert.equal(malformedSync.status, 1);
  assert.deepEqual(JSON.parse(malformedSync.stdout), {
    outcome: "failed",
    reason: "invalid-account-source",
  });
  assert.doesNotMatch(malformedSync.stdout, /malformed-source|unexpected\.txt/);

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
  const reconciledCommand = runSync();
  assert.equal(reconciledCommand.status, 0, reconciledCommand.stderr);
  assert.equal(JSON.parse(reconciledCommand.stdout).changed, true);
  assert.equal(await exists(join(projectionRoot, "review")), false, "the public command must remove unpublished projected skills");
  await assert.rejects(
    () => loadAccountSkill({ accountSource, workspaceRoot, skillName: "review" }),
    (error) => error instanceof AccountSkillProjectionError && error.code === "skill-not-found",
  );
  assert.equal(await readFile(join(authoredRoot, "SKILL.md"), "utf8"), "# Workspace-authored skill\n");

  const changedDuringBuildWorkspace = join(root, "changed-during-build-workspace");
  const changedDuringBuildSource = join(root, "changed-during-build-account-skills");
  const changedDuringBuildProjectionRoot = join(
    changedDuringBuildWorkspace,
    ACCOUNT_SKILLS_PROJECTION_RELATIVE_PATH,
  );
  const changedDuringBuildSkillsParent = join(changedDuringBuildWorkspace, ".agents/skills");
  await put(join(changedDuringBuildSource, ".account-revision"), "account-rev-1\n");
  await put(join(changedDuringBuildSource, "catalog/SKILL.md"), "# Catalog baseline\n");
  await put(join(changedDuringBuildSource, "review/SKILL.md"), "# Review baseline\n");
  await loadAccountSkill({
    accountSource: changedDuringBuildSource,
    workspaceRoot: changedDuringBuildWorkspace,
    skillName: "catalog",
  });
  await writeFile(join(changedDuringBuildSource, "catalog/SKILL.md"), "# Catalog pending v2\n");
  await writeFile(join(changedDuringBuildSource, ".account-revision"), "account-rev-2\n");
  let changedDuringBuild = false;
  await expectProjectionError(
    () =>
      syncAccountSkillProjection({
        accountSource: changedDuringBuildSource,
        workspaceRoot: changedDuringBuildWorkspace,
        afterSkillCopy: async ({ skillName }) => {
          if (skillName !== "catalog") return;
          changedDuringBuild = true;
          await writeFile(join(changedDuringBuildSource, "review/SKILL.md"), "# Review changed mid-refresh\n");
          await writeFile(join(changedDuringBuildSource, ".account-revision"), "account-rev-3\n");
        },
      }),
    "source-changed",
  );
  assert.equal(changedDuringBuild, true, "the fixture must mutate the source while staging is still being built");
  assert.equal(
    await readFile(join(changedDuringBuildProjectionRoot, "catalog/SKILL.md"), "utf8"),
    "# Catalog baseline\n",
    "a source mutation during staging must leave the prior projection readable",
  );
  assert.equal(
    await readFile(join(changedDuringBuildProjectionRoot, "review/SKILL.md"), "utf8"),
    "# Review baseline\n",
    "a source mutation during staging must not partially replace the prior projection",
  );
  assert.equal(
    JSON.parse(await readFile(join(changedDuringBuildProjectionRoot, ACCOUNT_SKILLS_MANIFEST_FILE), "utf8")).sourceRevision,
    "account-rev-1",
    "a source mutation during staging must leave the prior projection manifest intact",
  );
  assert.deepEqual(
    (await readdir(changedDuringBuildSkillsParent)).filter(
      (entry) =>
        entry.startsWith(".account-projections.staging-") ||
        entry.startsWith(".account-projections.backup-"),
    ),
    [],
    "source-changed refreshes must clean owned staging and backup artifacts",
  );

  const interruptedWorkspace = join(root, "interrupted-install-workspace");
  const interruptedSource = join(root, "interrupted-account-skills");
  const interruptedProjectionRoot = join(
    interruptedWorkspace,
    ACCOUNT_SKILLS_PROJECTION_RELATIVE_PATH,
  );
  const interruptedSkillsParent = join(interruptedWorkspace, ".agents/skills");
  const interruptedLookalike = `${interruptedProjectionRoot}.staging-not-owned`;
  await put(join(interruptedSource, ".account-revision"), "account-rev-5\n");
  await put(join(interruptedSource, "catalog/SKILL.md"), "# Catalog v2\n");
  await put(join(interruptedLookalike, "keep.txt"), "unrelated interrupted fixture\n");
  const interruptedInitial = await loadAccountSkill({
    accountSource: interruptedSource,
    workspaceRoot: interruptedWorkspace,
    skillName: "catalog",
  });
  assert.equal(interruptedInitial.contents, "# Catalog v2\n");
  await writeFile(join(interruptedSource, "catalog/SKILL.md"), "# Catalog interrupted v6\n");
  await writeFile(join(interruptedSource, ".account-revision"), "account-rev-6\n");
  await expectProjectionError(
    () =>
      syncAccountSkillProjection({
        accountSource: interruptedSource,
        workspaceRoot: interruptedWorkspace,
        afterInstall: async ({ destination }) => {
          await rm(join(destination, "catalog/SKILL.md"));
        },
      }),
    "atomic-install-failed",
  );
  assert.equal(
    await readFile(join(interruptedProjectionRoot, "catalog/SKILL.md"), "utf8"),
    "# Catalog v2\n",
    "a failed post-install validation must restore the prior complete projection",
  );
  assert.equal(
    JSON.parse(await readFile(join(interruptedProjectionRoot, ACCOUNT_SKILLS_MANIFEST_FILE), "utf8")).sourceRevision,
    "account-rev-5",
    "rollback must restore the prior projection manifest",
  );
  assert.deepEqual(
    (await readdir(interruptedSkillsParent)).filter(
      (entry) =>
        entry.startsWith(".account-projections.staging-") ||
        entry.startsWith(".account-projections.backup-"),
    ),
    [".account-projections.staging-not-owned"],
    "owned staging and backup artifacts must be cleaned without touching lookalikes",
  );

  let restoreFailure;
  await assert.rejects(
    () =>
      syncAccountSkillProjection({
        accountSource: interruptedSource,
        workspaceRoot: interruptedWorkspace,
        afterInstall: async ({ destination }) => {
          await rm(join(destination, "catalog/SKILL.md"));
        },
        restoreBackup: async () => {
          throw new Error("simulated restore failure");
        },
      }),
    (error) => {
      restoreFailure = error;
      return error instanceof AccountSkillProjectionError && error.code === "atomic-restore-failed";
    },
  );
  assert.match(restoreFailure.message, /backup preserved at/);
  const retainedArtifacts = (await readdir(interruptedSkillsParent)).filter((entry) =>
    entry.startsWith(".account-projections.backup-"),
  );
  assert.equal(retainedArtifacts.length, 1, "a failed restore must retain the owned backup artifact");
  const retainedBackupRoot = join(interruptedSkillsParent, retainedArtifacts[0]);
  assert.equal(
    await readFile(join(retainedBackupRoot, "catalog/SKILL.md"), "utf8"),
    "# Catalog v2\n",
    "the retained backup must contain the last known-good projection",
  );
  assert.equal(
    JSON.parse(await readFile(join(retainedBackupRoot, ACCOUNT_SKILLS_MANIFEST_FILE), "utf8")).sourceRevision,
    "account-rev-5",
    "the retained backup must preserve the last known-good manifest",
  );
  assert.equal(await exists(interruptedProjectionRoot), false, "a failed restore must not masquerade as an installed projection");
  assert.equal(await exists(interruptedLookalike), true, "restore failure handling must not touch lookalike directories");
  assert.equal(
    await readFile(join(interruptedLookalike, "keep.txt"), "utf8"),
    "unrelated interrupted fixture\n",
    "a failed restore must preserve similarly named directories byte-for-byte",
  );

  await writeFile(join(interruptedSource, ".account-revision"), "account-rev-7\n");
  const recovered = await recoverAccountSkillProjection({
    accountSource: interruptedSource,
    workspaceRoot: interruptedWorkspace,
  });
  assert.equal(recovered.recovered, true, "operators must be able to restore a validated preserved projection");
  assert.equal(await readFile(join(interruptedProjectionRoot, "catalog/SKILL.md"), "utf8"), "# Catalog v2\n");
  assert.equal(
    (await readdir(interruptedSkillsParent)).filter((entry) =>
      entry.startsWith(".account-projections.backup-"),
    ).length,
    0,
    "a successful recovery must consume only the restored owned backup",
  );
  assert.equal(await exists(interruptedLookalike), true, "recovery must not touch lookalike directories");

  const recoveryFailureBackup = `${interruptedProjectionRoot}.backup-44444444-4444-4444-8444-444444444444`;
  await rename(interruptedProjectionRoot, recoveryFailureBackup);
  await assert.rejects(
    () =>
      recoverAccountSkillProjection({
        accountSource: interruptedSource,
        workspaceRoot: interruptedWorkspace,
        restoreBackup: async ({ backupRoot, destination }) => {
          await rename(backupRoot, destination);
          throw new Error("simulated filesystem restore failure");
        },
      }),
    (error) => error instanceof AccountSkillProjectionError && error.code === "atomic-recovery-failed",
  );
  assert.equal(await exists(interruptedProjectionRoot), false, "a failed recovery must not leave a partial destination");
  assert.equal(await exists(recoveryFailureBackup), true, "a failed recovery must retain the owned backup");
  assert.equal(
    await readFile(join(recoveryFailureBackup, "catalog/SKILL.md"), "utf8"),
    "# Catalog v2\n",
    "a failed recovery must retain the last-known-good bytes",
  );
  await recoverAccountSkillProjection({ accountSource: interruptedSource, workspaceRoot: interruptedWorkspace });

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

  const malformedLockWorkspace = join(root, "malformed-lock-workspace");
  const malformedLockProjectionRoot = join(
    malformedLockWorkspace,
    ACCOUNT_SKILLS_PROJECTION_RELATIVE_PATH,
  );
  const malformedLockPath = `${malformedLockProjectionRoot}.lock`;
  await put(malformedLockPath, `${JSON.stringify({ format: 1, pid: process.pid, token: "" })}\n`);
  await utimes(malformedLockPath, new Date(0), new Date(0));
  const recoveredMalformedLock = await syncAccountSkillProjection({
    accountSource,
    workspaceRoot: malformedLockWorkspace,
    lockTimeoutMs: 50,
  });
  assert.equal(recoveredMalformedLock.changed, true, "malformed structured locks must recover only after the stale timeout");

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
  assert.match(contract, /ACCOUNT_SKILLS_MIRROR_ROOT/);
  assert.match(contract, /account-skills:sync/);
  assert.match(contract, /unavailable-source/);
  assert.match(contract, /missing-mirror/);
  assert.match(contract, /invalid-mirror-metadata/);
  assert.match(contract, /permission-denied/);
  assert.match(contract, /directory at the/);
  assert.match(contract, /Status checks do/);
  assert.match(contract, /must not add a skill registry/i);

  const canonicalSkill = await readFile(".agents/skills/skill-mirror-sync/SKILL.md", "utf8");
  const canonicalSkillText = canonicalSkill.replace(/\s+/g, " ");
  assert.match(canonicalSkill, /^---\nname: skill-mirror-sync\n/m, "canonical skill must use lowercase identity frontmatter");
  assert.match(canonicalSkillText, /ACCOUNT_SKILLS_SOURCE.*authoritative/i);
  assert.match(canonicalSkillText, /\.agents\/skills\/\.account-projections\//);
  assert.match(canonicalSkillText, /recursively enumerate.*regular.*files/i);
  assert.match(canonicalSkillText, /SHA-256.*relative path.*bytes/i);
  assert.match(canonicalSkillText, /read-only.*command/i);
  assert.match(canonicalSkillText, /account-skills:sync/);
  assert.match(canonicalSkillText, /serialized.*lock/i);
  assert.match(canonicalSkillText, /atomic.*rename/i);
  assert.match(canonicalSkillText, /interrupted refresh/i);
  assert.match(canonicalSkillText, /never edit it directly/i);
  assert.match(canonicalSkillText, /never flows back/i);
  assert.match(canonicalSkillText, /invalid-mirror-metadata/);
  assert.match(canonicalSkillText, /permission denial/);
  assert.match(canonicalSkillText, /directory at the/);
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
  const statusImplementation = await readFile("scripts/account-skill-status.mjs", "utf8");
  assert.match(statusImplementation, /ACCOUNT_SKILLS_MIRROR_ROOT/);
  const syncImplementation = await readFile("scripts/account-skills-sync.mjs", "utf8");
  assert.match(syncImplementation, /syncAccountSkillProjection/);
  assert.doesNotMatch(syncImplementation, /\b(writeFile|mkdir|rename|rm|cp)\s*\(/);
  assert.doesNotMatch(syncImplementation, /\.local\/custom_skills|ACCOUNT_SKILL_MIRROR_METADATA_FILE/);
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
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(packageJson.scripts["account-skills:sync"], "node scripts/account-skills-sync.mjs");
  const repositoryWiring = await Promise.all([
    readFile("package.json", "utf8"),
    readFile(".replit", "utf8"),
    readFile("scripts/account-skills-sync.mjs", "utf8"),
  ]);
  assert.doesNotMatch(
    repositoryWiring.join("\n"),
    /(?:cp|copy|rsync|writeFile|rename|mkdir).{0,120}\.local\/custom_skills|\.local\/custom_skills.{0,120}(?:cp|copy|rsync|writeFile|rename|mkdir)/i,
    "repository command and workflow wiring must not write the platform runtime mirror",
  );
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