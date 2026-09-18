#!/usr/bin/env node
/**
 * Verify that every tracked pnpm patch still applies to its exact published
 * package version.
 *
 * `pnpm patch` normally applies an existing patch before extracting a package.
 * `--ignore-existing` is intentional here: validation must start from the
 * unpatched published package so context drift cannot be hidden.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const patchDirectory = "patches";

function quoteValue(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function parsePatchedDependenciesLockfile(lockfile) {
  const entries = new Map();
  let inSection = false;
  let currentKey;

  for (const line of lockfile.split(/\r?\n/)) {
    if (line === "patchedDependencies:") {
      inSection = true;
      currentKey = undefined;
      continue;
    }
    if (!inSection) continue;
    if (line && !line.startsWith(" ")) break;

    const entry = line.match(/^  (.+):\s*$/);
    if (entry) {
      currentKey = quoteValue(entry[1]);
      entries.set(currentKey, {});
      continue;
    }

    const field = line.match(/^    (hash|path):\s*(.+)$/);
    if (field && currentKey) {
      entries.get(currentKey)[field[1]] = quoteValue(field[2]);
    }
  }

  return entries;
}

export function parseExactPackageSpecifier(specifier) {
  if (typeof specifier !== "string") return null;
  const at = specifier.lastIndexOf("@");
  if (at <= 0) return null;

  const name = specifier.slice(0, at);
  const version = specifier.slice(at + 1);
  if (
    !name ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
  ) {
    return null;
  }
  return { name, version };
}

export function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

export function patchFileIntegrityErrors(specifier, patchPath, patchText) {
  if (patchText.endsWith("\n")) return [];
  return [`${specifier}: ${patchPath} must end with a newline; the patch is truncated or corrupt`];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function commandFailure(result) {
  if (result.error) return result.error.message;
  if (result.signal) return `terminated by ${result.signal}`;
  return `exited with status ${result.status}`;
}

function workspacePath(root, candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) return null;
  const absolute = resolve(root, candidate);
  const outside = relative(root, absolute);
  if (outside === ".." || outside.startsWith(`..${sep}`) || isAbsolute(outside)) {
    return null;
  }
  return outside.split(sep).join("/");
}

function printCommandOutput(result) {
  const output = `${result.stdout}${result.stderr}`.trim();
  return output ? `\n${output}` : "";
}

export function checkPatchApplication(packageDirectory, patchPath, specifier) {
  const apply = run(
    "git",
    ["apply", "--check", "--verbose", "--", patchPath],
    { cwd: packageDirectory },
  );
  if (apply.status === 0) return [];
  return [
    `${specifier}: patch does not apply to the published package; context or end-of-file integrity drift detected (${commandFailure(apply)})${printCommandOutput(apply)}`,
  ];
}

export function listTrackedPatches(root) {
  const result = run("git", ["ls-files", "-z", "--", patchDirectory], { cwd: root });
  if (result.status !== 0) {
    throw new Error(`could not list tracked patches: ${commandFailure(result)}${printCommandOutput(result)}`);
  }
  return result.stdout
    .split("\0")
    .filter((path) => path.startsWith(`${patchDirectory}/`) && path.endsWith(".patch"));
}

function readWorkspaceConfig(root) {
  const packagePath = join(root, "package.json");
  const lockPath = join(root, "pnpm-lock.yaml");
  if (!existsSync(packagePath)) throw new Error("package.json is missing");
  if (!existsSync(lockPath)) throw new Error("pnpm-lock.yaml is missing");

  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch (error) {
    throw new Error(`could not parse package.json: ${error.message}`);
  }

  let lockfile;
  try {
    lockfile = readFileSync(lockPath, "utf8");
  } catch (error) {
    throw new Error(`could not read pnpm-lock.yaml: ${error.message}`);
  }

  return {
    patchedDependencies: packageJson.pnpm?.patchedDependencies ?? {},
    lockEntries: parsePatchedDependenciesLockfile(lockfile),
  };
}

function checkPatch(root, specifier, patchPath, lockEntry) {
  const parsed = parseExactPackageSpecifier(specifier);
  if (!parsed) {
    return [`${specifier}: patched dependency keys must name an exact package version`];
  }

  const absolutePatchPath = join(root, patchPath);
  const patchText = readFileSync(absolutePatchPath, "utf8");
  const errors = patchFileIntegrityErrors(specifier, patchPath, patchText);

  const hash = sha256(patchText);
  if (!lockEntry) {
    errors.push(`${specifier}: pnpm-lock.yaml has no patchedDependencies entry`);
  } else {
    if (lockEntry.path !== patchPath) {
      errors.push(
        `${specifier}: pnpm-lock.yaml points to ${lockEntry.path ?? "no path"} instead of ${patchPath}`,
      );
    }
    if (lockEntry.hash !== hash) {
      errors.push(
        `${specifier}: pnpm-lock.yaml patch hash ${lockEntry.hash ?? "missing"} does not match ${hash}`,
      );
    }
  }

  if (errors.length) return errors;

  const tempRoot = mkdtempSync(join(tmpdir(), "patched-dependency-check-"));
  const editDirectory = join(tempRoot, "package");
  try {
    const extract = run(
      "pnpm",
      ["patch", specifier, "--ignore-existing", "--edit-dir", editDirectory],
      { cwd: root, timeout: 120_000 },
    );
    if (extract.status !== 0) {
      return [
        `${specifier}: could not extract the exact published package for patch validation (${commandFailure(extract)})${printCommandOutput(extract)}`,
      ];
    }

    let publishedPackage;
    try {
      publishedPackage = JSON.parse(readFileSync(join(editDirectory, "package.json"), "utf8"));
    } catch (error) {
      return [`${specifier}: extracted package has no readable package.json: ${error.message}`];
    }
    if (publishedPackage.name !== parsed.name || publishedPackage.version !== parsed.version) {
      return [
        `${specifier}: extracted package is ${publishedPackage.name ?? "unknown"}@${publishedPackage.version ?? "unknown"}, not the declared published version`,
      ];
    }

    return checkPatchApplication(editDirectory, absolutePatchPath, specifier);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function main(root = workspaceRoot) {
  const errors = [];
  let trackedPatches;
  let config;
  try {
    trackedPatches = listTrackedPatches(root);
    config = readWorkspaceConfig(root);
  } catch (error) {
    console.error(`[patch-integrity] ERROR: ${error.message}`);
    return 1;
  }

  const manifestEntries = new Map();
  for (const [specifier, configuredPath] of Object.entries(config.patchedDependencies)) {
    const patchPath = workspacePath(root, configuredPath);
    if (!patchPath || !patchPath.startsWith(`${patchDirectory}/`) || !patchPath.endsWith(".patch")) {
      errors.push(`${specifier}: patchedDependencies path must be a .patch file under ${patchDirectory}/`);
      continue;
    }
    if (manifestEntries.has(patchPath)) {
      errors.push(`${patchPath}: multiple patched dependency entries point to the same patch`);
      continue;
    }
    manifestEntries.set(patchPath, specifier);
  }

  const trackedSet = new Set(trackedPatches);
  for (const trackedPatch of trackedPatches) {
    if (!manifestEntries.has(trackedPatch)) {
      errors.push(`${trackedPatch}: tracked patch is not declared in package.json pnpm.patchedDependencies`);
    }
  }
  for (const patchPath of manifestEntries.keys()) {
    if (!trackedSet.has(patchPath)) {
      errors.push(`${patchPath}: patched dependency is not a tracked patch file`);
    }
  }

  for (const [patchPath, specifier] of manifestEntries) {
    const absolutePath = join(root, patchPath);
    if (!existsSync(absolutePath)) {
      errors.push(`${specifier}: configured patch ${patchPath} does not exist`);
      continue;
    }
    errors.push(...checkPatch(root, specifier, patchPath, config.lockEntries.get(specifier)));
  }

  if (errors.length) {
    console.error("[patch-integrity] FAILED");
    for (const error of errors) console.error(`- ${error}`);
    return 1;
  }

  console.log(`[patch-integrity] PASS (${manifestEntries.size} patched package${manifestEntries.size === 1 ? "" : "s"})`);
  return 0;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}