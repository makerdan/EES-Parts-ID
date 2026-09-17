import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, "../../..");
const MANIFEST_PATH = resolve(__dirname, "..", "generated-output-manifest.json");

function loadManifest(manifestPath = MANIFEST_PATH) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.version !== 1) {
    throw new Error(`unsupported generated-output manifest version: ${manifest.version}`);
  }
  return manifest;
}

function walkFiles(root, current = root) {
  if (!existsSync(current)) return [];
  const entries = readdirSync(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(root, path));
    } else if (entry.isFile()) {
      files.push(relative(root, path).split("\\").join("/"));
    }
  }
  return files;
}

function isTracked(root, path) {
  try {
    execFileSync("git", ["-C", root, "ls-files", "--error-unmatch", "--", path], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function gitRepositoryExists(root) {
  try {
    const gitRoot = execFileSync(
      "git",
      ["-C", root, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return resolve(gitRoot) === resolve(root);
  } catch {
    return false;
  }
}

export function checkGeneratedOutputs({
  root = process.env.GENERATED_OUTPUT_ROOT || DEFAULT_ROOT,
  checkTracked = gitRepositoryExists(root),
} = {}) {
  const manifest = loadManifest();
  const failures = [];
  const sourceFiles = new Set(manifest.sourceFiles);
  const requiredFiles = new Set([...manifest.sourceFiles, ...manifest.requiredFiles]);

  for (const path of requiredFiles) {
    const absolutePath = resolve(root, path);
    if (!existsSync(absolutePath)) {
      failures.push(`MISSING generated output: ${path}`);
      continue;
    }
    if (!lstatSync(absolutePath).isFile()) {
      failures.push(`NOT A FILE generated output: ${path}`);
      continue;
    }
    if (lstatSync(absolutePath).size === 0) {
      failures.push(`EMPTY generated output: ${path}`);
    }
  }

  for (const path of manifest.nonEmptyDirectories) {
    const absolutePath = resolve(root, path);
    if (!existsSync(absolutePath) || !lstatSync(absolutePath).isDirectory()) {
      failures.push(`MISSING generated directory: ${path}`);
      continue;
    }
    if (walkFiles(absolutePath).length === 0) {
      failures.push(`EMPTY generated directory: ${path}`);
    }
  }

  for (const rootPath of manifest.generatedRoots) {
    const absolutePath = resolve(root, rootPath);
    for (const actualRelative of walkFiles(absolutePath)) {
      const actualPath = `${rootPath}/${actualRelative}`;
      if (!sourceFiles.has(actualPath)) {
        failures.push(`UNEXPECTED generated output: ${actualPath}`);
      }
    }
  }

  if (checkTracked) {
    for (const path of sourceFiles) {
      if (existsSync(resolve(root, path)) && !isTracked(root, path)) {
        failures.push(`UNTRACKED generated output: ${path}`);
      }
    }
  }

  return {
    manifest,
    failures,
    ok: failures.length === 0,
  };
}

export function formatGeneratedOutputFailures(failures) {
  return failures.map((failure) => `  - ${failure}`).join("\n");
}