#!/usr/bin/env tsx
/**
 * check-env-vars.ts
 *
 * Diffs process.env reads in artifacts/api-server/src/ and lib/db/src/ against
 * the variables declared in .env.example and reports two lists:
 *
 *   UNDOCUMENTED  — vars read in server code but absent from .env.example
 *   OBSOLETE      — vars declared in .env.example but never read in server code
 *
 * Exits non-zero when any UNDOCUMENTED vars are found.
 *
 * Run via:
 *   pnpm --filter @workspace/scripts env:check
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const SERVER_SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

/**
 * EXPO_PUBLIC_* vars are Expo build-time client vars — not server env vars.
 * They legitimately live in .env.example but will never appear in server code.
 */
const IGNORED_PREFIXES = ["EXPO_PUBLIC_"];

// These are intentionally not direct process.env reads:
// DATABASE_ENV is consumed through the shared runtime contract, and
// ADMIN_PASSWORD appears only in legacy test fixtures rather than production
// code. Neither should become a public setup secret.
const IGNORED_UNDOCUMENTED_VARS = new Set(["ADMIN_PASSWORD"]);
const CONTRACT_ONLY_VARS = new Set([
  "DATABASE_ENV",
  "AI_INTEGRATIONS_GEMINI_API_KEY",
  "AI_INTEGRATIONS_GEMINI_BASE_URL",
]);

/**
 * Standard Node.js / platform-injected vars that don't need .env.example docs.
 * NODE_ENV is universally understood and is injected by the runtime.
 * JEST_WORKER_ID is injected by Jest in test workers; it is never set by users.
 */
const ALWAYS_EXPECTED_IN_CODE = new Set([
  "NODE_ENV",
  "JEST_WORKER_ID",
  "REPLIT_DEPLOYMENT",
]);

// ---------------------------------------------------------------------------
// Collect all .ts files under a directory (recursive)
// ---------------------------------------------------------------------------
function collectSourceFiles(dir: string): string[] {
  if (
    dir.endsWith(".ts") ||
    dir.endsWith(".tsx") ||
    dir.endsWith(".js") ||
    dir.endsWith(".jsx") ||
    dir.endsWith(".mjs") ||
    dir.endsWith(".cjs")
  ) {
    return [dir];
  }
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      result.push(...collectSourceFiles(full));
    } else if (
      entry.isFile() &&
      SERVER_SOURCE_EXTENSIONS.has(
        entry.name.slice(entry.name.lastIndexOf(".")),
      )
    ) {
      result.push(full);
    }
  }
  return result.sort();
}

function collectServerSourceRoots(repoRoot: string): {
  roots: string[];
  missing: string[];
} {
  const roots: string[] = [];
  const missing: string[] = [];
  const apiSourceRoot = join(repoRoot, "artifacts", "api-server", "src");
  if (existsSync(apiSourceRoot)) roots.push(apiSourceRoot);
  else missing.push(apiSourceRoot);
  const libRoot = join(repoRoot, "lib");
  const pending = [libRoot];

  while (pending.length > 0) {
    const directory = pending.pop()!;
    if (!existsSync(directory)) {
      missing.push(directory);
      continue;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile() && entry.name === "package.json") {
        let manifest: { serverOnly?: boolean };
        try {
          manifest = JSON.parse(readFileSync(fullPath, "utf-8")) as {
            serverOnly?: boolean;
          };
        } catch (error) {
          throw new Error(
            `could not parse ${fullPath}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        if (manifest.serverOnly === true) {
          const sourceRoot = join(resolve(fullPath, ".."), "src");
          if (existsSync(sourceRoot)) roots.push(sourceRoot);
          else missing.push(sourceRoot);
        }
      }
    }
  }

  // This checker itself contains the production privacy contract. Keeping it
  // in the scan makes changes to that contract visible in env:check output.
  const privacyChecker = join(
    repoRoot,
    "scripts",
    "src",
    "check-production-privacy.ts",
  );
  if (existsSync(privacyChecker)) roots.push(privacyChecker);
  return { roots, missing };
}

// ---------------------------------------------------------------------------
// Grep all process.env reads — both dot notation and static bracket notation
//
//   process.env.VAR_NAME
//   process.env["VAR_NAME"]
//   process.env['VAR_NAME']
// ---------------------------------------------------------------------------
const ENV_VAR_PATTERN =
  /process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[["']([A-Z_][A-Z0-9_]*)["']\])/g;

export function collectCodeVars(files: string[]): Set<string> {
  const vars = new Set<string>();
  for (const file of files) {
    const src = readFileSync(file, "utf-8");
    for (const match of src.matchAll(ENV_VAR_PATTERN)) {
      const name = match[1] ?? match[2];
      if (name && !ALWAYS_EXPECTED_IN_CODE.has(name)) {
        vars.add(name);
      }
    }
  }
  return vars;
}

// ---------------------------------------------------------------------------
// Parse .env.example for KEY=… lines
// ---------------------------------------------------------------------------
const EXAMPLE_KEY_PATTERN = /^([A-Z_][A-Z0-9_]*)=/m;

function collectExampleVars(content: string): Set<string> {
  const vars = new Set<string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed === "") continue;
    const match = trimmed.match(EXAMPLE_KEY_PATTERN);
    if (match) {
      vars.add(match[1]!);
    }
  }
  return vars;
}

export function checkEnvVars(repoRoot = REPO_ROOT): {
  scanRoots: string[];
  scannedFiles: string[];
  undocumented: string[];
  obsolete: string[];
} {
  const { roots, missing } = collectServerSourceRoots(repoRoot);
  if (missing.length > 0) {
    throw new Error(
      `declared server package source root(s) missing:\n${missing
        .map((path) => `  • ${path}`)
        .join("\n")}`,
    );
  }
  const scanRoots = roots.filter((root) => existsSync(root));
  const scannedFiles = scanRoots.flatMap(collectSourceFiles);
  const codeVars = collectCodeVars(scannedFiles);
  const exampleContent = readFileSync(join(repoRoot, ".env.example"), "utf-8");
  const exampleVars = collectExampleVars(exampleContent);
  const undocumented = [...codeVars]
    .filter((v) => !exampleVars.has(v) && !IGNORED_UNDOCUMENTED_VARS.has(v))
    .sort();
  const obsolete = [...exampleVars]
    .filter(
      (v) =>
        !codeVars.has(v) &&
        !CONTRACT_ONLY_VARS.has(v) &&
        !IGNORED_PREFIXES.some((p) => v.startsWith(p)),
    )
    .sort();
  return { scanRoots, scannedFiles, undocumented, obsolete };
}

async function main(): Promise<void> {
  try {
    const { undocumented, obsolete } = checkEnvVars();
    if (undocumented.length > 0) {
      console.error(
        `\n❌  UNDOCUMENTED env vars (read in server code, missing from .env.example):\n`,
      );
      for (const v of undocumented) {
        console.error(`   ${v}`);
      }
      console.error(
        `\nAdd entries for these vars to .env.example with a comment explaining\n` +
          `their purpose, accepted values, and safe default (or "required").\n`,
      );
    } else {
      console.log(`✅  All server env vars are documented in .env.example.`);
    }

    if (obsolete.length > 0) {
      console.warn(
        `\n⚠️   OBSOLETE env vars (in .env.example, not read by server code):\n`,
      );
      for (const v of obsolete) {
        console.warn(`   ${v}`);
      }
      console.warn(
        `\nThese are informational — remove them from .env.example if they are\n` +
          `no longer needed, or keep them if they are still required by other services.\n`,
      );
    }

    if (!undocumented.length && !obsolete.length) {
      console.log(`✅  .env.example and server code are perfectly in sync.`);
    }
    process.exitCode = undocumented.length > 0 ? 1 : 0;
  } catch (error) {
    console.error(
      `env:check FAILED — ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  void main();
}
