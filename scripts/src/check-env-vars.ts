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

import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = [
  join(REPO_ROOT, "artifacts", "api-server", "src"),
  join(REPO_ROOT, "lib", "db", "src"),
];
const ENV_EXAMPLE = join(REPO_ROOT, ".env.example");

/**
 * EXPO_PUBLIC_* vars are Expo build-time client vars — not server env vars.
 * They legitimately live in .env.example but will never appear in server code.
 */
const IGNORED_PREFIXES = ["EXPO_PUBLIC_"];

/**
 * Standard Node.js / platform-injected vars that don't need .env.example docs.
 * NODE_ENV is universally understood and is injected by the runtime.
 * JEST_WORKER_ID is injected by Jest in test workers; it is never set by users.
 */
const ALWAYS_EXPECTED_IN_CODE = new Set(["NODE_ENV", "JEST_WORKER_ID"]);

// ---------------------------------------------------------------------------
// Collect all .ts files under a directory (recursive)
// ---------------------------------------------------------------------------
function collectTsFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      result.push(...collectTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      result.push(full);
    }
  }
  return result;
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

function collectCodeVars(files: string[]): Set<string> {
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const tsFiles = SCAN_DIRS.flatMap(collectTsFiles);
const codeVars = collectCodeVars(tsFiles);
const exampleContent = readFileSync(ENV_EXAMPLE, "utf-8");
const exampleVars = collectExampleVars(exampleContent);

const undocumented = [...codeVars]
  .filter((v) => !exampleVars.has(v))
  .sort();

const obsolete = [...exampleVars]
  .filter(
    (v) =>
      !codeVars.has(v) &&
      !IGNORED_PREFIXES.some((p) => v.startsWith(p)),
  )
  .sort();

let hasError = false;

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
  hasError = true;
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

process.exit(hasError ? 1 : 0);
