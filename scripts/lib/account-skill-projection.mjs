import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  link,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export const ACCOUNT_SKILLS_REVISION_FILE = ".account-revision";
export const ACCOUNT_SKILLS_PROJECTION_RELATIVE_PATH = ".agents/skills/.account-projections";
export const ACCOUNT_SKILLS_MANIFEST_FILE = "manifest.json";
export const ACCOUNT_SKILL_MIRROR_METADATA_FILE = ".account-skill-metadata.json";

const LOCK_WAIT_MS = 25;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class AccountSkillProjectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AccountSkillProjectionError";
    this.code = code;
  }
}

function projectionPath(workspaceRoot) {
  return join(resolve(workspaceRoot), ACCOUNT_SKILLS_PROJECTION_RELATIVE_PATH);
}

function assertSkillName(name) {
  if (!SKILL_NAME.test(name)) {
    throw new AccountSkillProjectionError("invalid-skill-name", `Invalid account skill name: ${name}`);
  }
}

function isWithin(root, candidate) {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${sep}`);
}

function assertRelativeFilePath(filePath) {
  if (!filePath || filePath.startsWith("/") || filePath.split("/").some((part) => part === ".." || part === "")) {
    throw new AccountSkillProjectionError("invalid-file-path", `Invalid skill file path: ${filePath}`);
  }
}

async function ensureRegularFile(filePath, description) {
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    throw new AccountSkillProjectionError("incomplete-projection", `Missing ${description}: ${filePath}`);
  }
  if (!fileStat.isFile()) {
    throw new AccountSkillProjectionError("incomplete-projection", `${description} is not a regular file: ${filePath}`);
  }
}

async function readRevision(accountSource) {
  const sourceRoot = resolve(accountSource);
  let sourceStat;
  try {
    sourceStat = await stat(sourceRoot);
  } catch {
    throw new AccountSkillProjectionError("source-unavailable", `Account skill source is unavailable: ${sourceRoot}`);
  }
  if (!sourceStat.isDirectory()) {
    throw new AccountSkillProjectionError("source-unavailable", `Account skill source is not a directory: ${sourceRoot}`);
  }

  const revisionPath = join(sourceRoot, ACCOUNT_SKILLS_REVISION_FILE);
  await ensureRegularFile(revisionPath, "account skill revision");
  const revision = (await readFile(revisionPath, "utf8")).trim();
  if (!revision) {
    throw new AccountSkillProjectionError("source-unavailable", `Account skill revision is empty: ${revisionPath}`);
  }
  return { sourceRoot, revision };
}

async function enumerateFiles(root, relativeDirectory = "") {
  const directory = join(root, relativeDirectory);
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const files = [];
  for (const entry of entries) {
    const filePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      throw new AccountSkillProjectionError("unsupported-source-entry", `Symlinks are not account skill files: ${filePath}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await enumerateFiles(root, filePath)));
    } else if (entry.isFile()) {
      files.push(filePath);
    } else {
      throw new AccountSkillProjectionError("unsupported-source-entry", `Unsupported account skill entry: ${filePath}`);
    }
  }
  return files;
}

async function discoverAccountSkills(sourceRoot) {
  const entries = (await readdir(sourceRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const skills = [];
  for (const entry of entries) {
    if (entry.name === ACCOUNT_SKILLS_REVISION_FILE) continue;
    if (entry.isSymbolicLink()) {
      throw new AccountSkillProjectionError("unsupported-source-entry", `Symlinks are not account skill directories: ${entry.name}`);
    }
    if (!entry.isDirectory()) {
      throw new AccountSkillProjectionError("invalid-account-source", `Unexpected account source entry: ${entry.name}`);
    }
    assertSkillName(entry.name);
    const skillRoot = join(sourceRoot, entry.name);
    const files = await enumerateFiles(skillRoot);
    if (!files.includes("SKILL.md")) {
      throw new AccountSkillProjectionError("invalid-account-source", `Account skill is missing SKILL.md: ${entry.name}`);
    }
    skills.push({ name: entry.name, files });
  }
  return skills;
}

async function readCanonicalSkillMetadata(accountSource, skillName) {
  assertSkillName(skillName);
  if (!accountSource) {
    throw new AccountSkillProjectionError("source-unavailable", "ACCOUNT_SKILLS_SOURCE is required; refusing to use a fallback source");
  }
  const { sourceRoot, revision } = await readRevision(accountSource);
  const skills = await discoverAccountSkills(sourceRoot);
  const skill = skills.find((candidate) => candidate.name === skillName);
  if (!skill) {
    throw new AccountSkillProjectionError("skill-not-found", `Account skill is not published: ${skillName}`);
  }
  return {
    skillId: skillName,
    sourceRevision: revision,
    fingerprint: await fingerprintDirectory(join(sourceRoot, skillName), skill.files),
  };
}

export async function inspectAccountSkillMirror({
  accountSource,
  workspaceRoot = process.cwd(),
  skillName,
  mirrorRoot = join(resolve(workspaceRoot), ".local/custom_skills"),
} = {}) {
  let canonical;
  try {
    canonical = await readCanonicalSkillMetadata(accountSource, skillName);
  } catch (error) {
    if (error instanceof AccountSkillProjectionError) {
      return { outcome: "unavailable-source", skillId: skillName };
    }
    throw error;
  }

  const metadataPath = join(resolve(mirrorRoot), skillName, ACCOUNT_SKILL_MIRROR_METADATA_FILE);
  let mirror;
  try {
    mirror = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return { outcome: "missing-mirror", ...canonical };
    }
    return { outcome: "mismatch", ...canonical, reason: "invalid-mirror-metadata" };
  }

  if (
    mirror?.format !== 1 ||
    typeof mirror?.skillId !== "string" ||
    typeof mirror?.sourceRevision !== "string" ||
    typeof mirror?.fingerprint !== "string"
  ) {
    return { outcome: "mismatch", ...canonical, reason: "invalid-mirror-metadata" };
  }
  if (mirror.skillId !== canonical.skillId) {
    return { outcome: "mismatch", ...canonical, reason: "identity-mismatch" };
  }
  if (mirror.sourceRevision !== canonical.sourceRevision) {
    return { outcome: "mismatch", ...canonical, reason: "revision-mismatch" };
  }
  if (mirror.fingerprint !== canonical.fingerprint) {
    return { outcome: "mismatch", ...canonical, reason: "fingerprint-mismatch" };
  }
  return { outcome: "pass", ...canonical };
}

async function fingerprintDirectory(root, files) {
  const hash = createHash("sha256");
  for (const filePath of files) {
    assertRelativeFilePath(filePath);
    hash.update(filePath);
    hash.update("\0");
    hash.update(await readFile(join(root, filePath)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function copySkill(sourceRoot, stagingRoot, skill) {
  const destinationRoot = join(stagingRoot, skill.name);
  await mkdir(destinationRoot, { recursive: true });
  for (const filePath of skill.files) {
    assertRelativeFilePath(filePath);
    const sourcePath = join(sourceRoot, skill.name, filePath);
    const destinationPath = join(destinationRoot, filePath);
    if (!isWithin(join(sourceRoot, skill.name), sourcePath)) {
      throw new AccountSkillProjectionError("invalid-file-path", `Account skill path escapes its root: ${filePath}`);
    }
    await ensureRegularFile(sourcePath, `account skill file ${skill.name}/${filePath}`);
    await mkdir(dirname(destinationPath), { recursive: true });
    await writeFile(destinationPath, await readFile(sourcePath));
  }
}

async function readManifest(root) {
  const manifestPath = join(root, ACCOUNT_SKILLS_MANIFEST_FILE);
  await ensureRegularFile(manifestPath, "account skill projection manifest");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new AccountSkillProjectionError("incomplete-projection", `Invalid account skill projection manifest: ${manifestPath}`);
  }
  if (manifest?.format !== 1 || typeof manifest.sourceRevision !== "string" || !manifest.skills || typeof manifest.skills !== "object") {
    throw new AccountSkillProjectionError("incomplete-projection", `Malformed account skill projection manifest: ${manifestPath}`);
  }
  return manifest;
}

async function validateProjection(root, expectedRevision) {
  const manifest = await readManifest(root);
  if (manifest.sourceRevision !== expectedRevision) {
    throw new AccountSkillProjectionError(
      "stale-projection",
      `Account skill projection revision ${manifest.sourceRevision} does not match ${expectedRevision}`,
    );
  }

  const entries = (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const expectedSkillNames = Object.keys(manifest.skills).sort();
  const actualSkillNames = entries.filter((entry) => entry.name !== ACCOUNT_SKILLS_MANIFEST_FILE).map((entry) => entry.name);
  if (JSON.stringify(actualSkillNames) !== JSON.stringify(expectedSkillNames)) {
    throw new AccountSkillProjectionError("incomplete-projection", "Account skill projection contains an unexpected or missing skill");
  }

  for (const skillName of expectedSkillNames) {
    assertSkillName(skillName);
    const record = manifest.skills[skillName];
    if (!Array.isArray(record?.files) || typeof record.fingerprint !== "string") {
      throw new AccountSkillProjectionError("incomplete-projection", `Malformed projection metadata for ${skillName}`);
    }
    const skillRoot = join(root, skillName);
    const files = await enumerateFiles(skillRoot);
    if (JSON.stringify(files) !== JSON.stringify(record.files)) {
      throw new AccountSkillProjectionError("incomplete-projection", `Account skill files are incomplete: ${skillName}`);
    }
    const fingerprint = await fingerprintDirectory(skillRoot, files);
    if (fingerprint !== record.fingerprint) {
      throw new AccountSkillProjectionError("stale-projection", `Account skill fingerprint does not match metadata: ${skillName}`);
    }
  }
  return manifest;
}

async function acquireLock(lockPath, timeoutMs) {
  const startedAt = Date.now();
  while (true) {
    const token = randomUUID();
    const candidatePath = `${lockPath}.candidate-${token}`;
    let acquired = false;
    try {
      await writeFile(candidatePath, `${JSON.stringify({ format: 1, pid: process.pid, token })}\n`, { flag: "wx" });
      try {
        await link(candidatePath, lockPath);
        acquired = true;
      } finally {
        await rm(candidatePath, { force: true });
      }
      if (!acquired) continue;
      return async () => {
        let owner;
        try {
          owner = JSON.parse(await readFile(lockPath, "utf8"));
        } catch {
          return;
        }
        if (owner?.token === token) await rm(lockPath, { force: true });
      };
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw new AccountSkillProjectionError("projection-busy", `Unable to serialize account skill projection updates: ${lockPath}`);
      }
      await rm(candidatePath, { force: true });
      let owner;
      try {
        owner = JSON.parse(await readFile(lockPath, "utf8"));
      } catch {
        owner = undefined;
      }
      if (owner?.format === 1 && Number.isInteger(owner.pid) && typeof owner.token === "string") {
        let ownerIsAlive = true;
        try {
          process.kill(owner.pid, 0);
        } catch (ownerError) {
          ownerIsAlive = ownerError.code !== "ESRCH";
        }
        if (!ownerIsAlive) {
          const abandonedLockPath = `${lockPath}.abandoned-${randomUUID()}`;
          try {
            await rename(lockPath, abandonedLockPath);
          } catch (renameError) {
            if (renameError.code === "ENOENT") continue;
            throw new AccountSkillProjectionError("projection-busy", `Unable to recover abandoned projection lock: ${lockPath}`);
          }
          await rm(abandonedLockPath, { force: true });
          continue;
        }
      }
      if (!owner) {
        let lockStat;
        try {
          lockStat = await stat(lockPath);
        } catch (statError) {
          if (statError.code === "ENOENT") continue;
          throw new AccountSkillProjectionError("projection-busy", `Unable to inspect projection lock: ${lockPath}`);
        }
        if (Date.now() - lockStat.mtimeMs >= timeoutMs) {
          const abandonedLockPath = `${lockPath}.abandoned-${randomUUID()}`;
          try {
            await rename(lockPath, abandonedLockPath);
          } catch (renameError) {
            if (renameError.code === "ENOENT") continue;
            throw new AccountSkillProjectionError("projection-busy", `Unable to recover abandoned projection lock: ${lockPath}`);
          }
          await rm(abandonedLockPath, { force: true });
          continue;
        }
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new AccountSkillProjectionError("projection-busy", `Unable to serialize account skill projection updates: ${lockPath}`);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, LOCK_WAIT_MS));
    }
  }
}

async function removeStaleProjectionDirectories(parent, destinationName) {
  const ownedPrefixes = [`${destinationName}.staging-`, `${destinationName}.backup-`];
  const entries = await readdir(parent, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const prefix = ownedPrefixes.find((candidate) => entry.name.startsWith(candidate));
    if (!prefix || !UUID.test(entry.name.slice(prefix.length))) continue;
    await rm(join(parent, entry.name), { recursive: true, force: true });
  }
}

async function buildProjection({ sourceRoot, revision, stagingRoot }) {
  const skills = await discoverAccountSkills(sourceRoot);
  const manifest = { format: 1, sourceRevision: revision, skills: {} };
  for (const skill of skills) {
    await copySkill(sourceRoot, stagingRoot, skill);
    manifest.skills[skill.name] = {
      files: skill.files,
      fingerprint: await fingerprintDirectory(join(sourceRoot, skill.name), skill.files),
    };
  }
  await writeFile(join(stagingRoot, ACCOUNT_SKILLS_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  await validateProjection(stagingRoot, revision);
  return manifest;
}

export async function syncAccountSkillProjection({
  accountSource,
  workspaceRoot = process.cwd(),
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
} = {}) {
  if (!accountSource) {
    throw new AccountSkillProjectionError("source-unavailable", "ACCOUNT_SKILLS_SOURCE is required; refusing to use a fallback source");
  }
  const sourceBefore = await readRevision(accountSource);
  const destination = projectionPath(workspaceRoot);
  const parent = dirname(destination);
  const lockPath = `${destination}.lock`;
  await mkdir(parent, { recursive: true });
  const release = await acquireLock(lockPath, lockTimeoutMs);
  let stagingRoot;
  let backupRoot;
  try {
    await removeStaleProjectionDirectories(parent, destination.slice(parent.length + 1));
    const current = await readRevision(sourceBefore.sourceRoot);
    let currentManifest;
    try {
      currentManifest = await validateProjection(destination, current.revision);
    } catch (error) {
      if (!(error instanceof AccountSkillProjectionError) || !["stale-projection", "incomplete-projection"].includes(error.code)) {
        throw error;
      }
    }
    if (currentManifest) return { destination, manifest: currentManifest, changed: false };

    stagingRoot = `${destination}.staging-${randomUUID()}`;
    await mkdir(stagingRoot, { recursive: true });
    const manifest = await buildProjection({ sourceRoot: current.sourceRoot, revision: current.revision, stagingRoot });
    const sourceAfter = await readRevision(current.sourceRoot);
    if (sourceAfter.revision !== current.revision) {
      throw new AccountSkillProjectionError("source-changed", "Account skill source changed while projection was being built");
    }

    backupRoot = `${destination}.backup-${randomUUID()}`;
    let hadDestination = false;
    try {
      await rename(destination, backupRoot);
      hadDestination = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await rename(stagingRoot, destination);
      stagingRoot = undefined;
    } catch (error) {
      if (hadDestination) await rename(backupRoot, destination);
      backupRoot = undefined;
      throw new AccountSkillProjectionError("atomic-install-failed", `Unable to install account skill projection: ${error.message}`);
    }
    if (hadDestination) await rm(backupRoot, { recursive: true, force: true });
    backupRoot = undefined;
    return { destination, manifest, changed: true };
  } finally {
    if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true });
    if (backupRoot) await rm(backupRoot, { recursive: true, force: true });
    await release();
  }
}

export async function loadAccountSkill({
  accountSource,
  workspaceRoot = process.cwd(),
  skillName,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
} = {}) {
  assertSkillName(skillName);
  const { destination, manifest } = await syncAccountSkillProjection({ accountSource, workspaceRoot, lockTimeoutMs });
  const record = manifest.skills[skillName];
  if (!record) {
    throw new AccountSkillProjectionError("skill-not-found", `Account skill is not published: ${skillName}`);
  }
  await validateProjection(destination, manifest.sourceRevision);
  return {
    skillName,
    sourceRevision: manifest.sourceRevision,
    fingerprint: record.fingerprint,
    path: join(destination, skillName, "SKILL.md"),
    contents: await readFile(join(destination, skillName, "SKILL.md"), "utf8"),
  };
}