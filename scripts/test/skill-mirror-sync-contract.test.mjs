#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACCOUNT_SKILLS_MANIFEST_FILE,
  ACCOUNT_SKILLS_PROJECTION_RELATIVE_PATH,
  AccountSkillProjectionError,
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

async function put(path, contents) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents);
}

async function expectProjectionError(operation, code) {
  await assert.rejects(operation, (error) => error instanceof AccountSkillProjectionError && error.code === code);
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
  const concurrentResults = await Promise.all([
    syncAccountSkillProjection({ accountSource, workspaceRoot: concurrentWorkspace }),
    syncAccountSkillProjection({ accountSource, workspaceRoot: concurrentWorkspace }),
  ]);
  assert.equal(
    concurrentResults.filter((result) => result.changed).length,
    1,
    "serialized concurrent refreshes must install exactly one projection",
  );

  const contract = await readFile("docs/validation/account-level-skills.md", "utf8");
  assert.match(contract, /account\/platform-managed skill store is authoritative/i);
  assert.match(contract, /\.agents\/skills/);
  assert.match(contract, /\.local\/custom_skills/);
  assert.match(contract, /must not edit `.local\/custom_skills` directly/i);
  assert.match(contract, /fingerprint/i);
  assert.match(contract, /recursive/i);

  const implementation = await readFile("scripts/lib/account-skill-projection.mjs", "utf8");
  assert.doesNotMatch(implementation, /\.local\/custom_skills/, "account projection tooling must not write the runtime mirror");
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