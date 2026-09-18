#!/usr/bin/env tsx
// check-tsconfig-refs.ts
//
// Scans every tsconfig.json under the declared lib workspace root and checks
// that each lib package either:
//   1. Appears in the root tsconfig.json "references" array, OR
//   2. Contains a `// tsconfig-ref: excluded` opt-out comment.
//
// Any tsconfig.json that is neither referenced nor opted-out is a silent gap
// in `tsc --build` coverage — type errors in that lib go completely undetected.
//
// Exit codes:
//   0  — all lib tsconfigs are accounted for
//   1  — one or more are unregistered and not opted-out (names printed to stderr)

import { existsSync, readdirSync, readFileSync } from "fs";
import { dirname, relative, resolve } from "path";
import { fileURLToPath } from "url";
import * as ts from "typescript";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "../..");

export function parseJsonConfig(
  filePath: string,
  raw = readFileSync(filePath, "utf-8"),
): unknown {
  const parsed = ts.parseConfigFileTextToJson(filePath, raw);
  if (!parsed.error) return parsed.config;

  const message = ts.flattenDiagnosticMessageText(parsed.error.messageText, " ");
  const position =
    parsed.error.start === undefined
      ? ""
      : ` at offset ${parsed.error.start}`;
  throw new Error(`Invalid JSONC in ${filePath}${position}: ${message}`);
}

export function readJsonConfig(filePath: string): unknown {
  return parseJsonConfig(filePath);
}

function hasOptOut(tsconfigPath: string): boolean {
  const raw = readFileSync(tsconfigPath, "utf-8");
  return /\/\/\s*tsconfig-ref:\s*excluded/i.test(raw);
}

function findLibTsconfigs(libRoot: string): string[] {
  const found: string[] = [];
  const pending = [libRoot];

  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "coverage" ||
        entry.name === ".git"
      ) {
        continue;
      }

      const fullPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile() && entry.name === "tsconfig.json") {
        found.push(fullPath);
      }
    }
  }

  return found.sort();
}

export async function checkTsconfigRefs(root = ROOT): Promise<{
  found: string[];
  violations: string[];
}> {
  const rootTsconfig = resolve(root, "tsconfig.json");
  const libRoot = resolve(root, "lib");

  if (!existsSync(rootTsconfig)) {
    throw new Error(`Root tsconfig not found: ${rootTsconfig}`);
  }
  if (!existsSync(libRoot)) {
    throw new Error(`Library workspace root not found: ${libRoot}`);
  }

  const rootConfig = readJsonConfig(rootTsconfig) as {
    references?: Array<{ path: string }>;
  };
  const referencedPaths = new Set(
    (rootConfig.references ?? []).map((ref) => resolve(root, ref.path)),
  );
  const found = findLibTsconfigs(libRoot);
  const violations: string[] = [];

  for (const tsconfigPath of found) {
    const libDir = dirname(tsconfigPath);
    const relDir = relative(root, libDir);
    const isReferenced = referencedPaths.has(libDir);
    const isOptedOut = hasOptOut(tsconfigPath);

    if (!isReferenced && !isOptedOut) {
      violations.push(relDir);
    }
  }

  return { found, violations };
}

async function main(): Promise<void> {
  try {
    const { found, violations } = await checkTsconfigRefs();
    if (violations.length > 0) {
      console.error(
        "tsconfig:check FAILED — the following lib packages have a tsconfig.json\n" +
          "but are neither listed in the root tsconfig.json references nor opted-out\n" +
          "with a `// tsconfig-ref: excluded — <reason>` comment:\n",
      );
      for (const violation of violations) {
        console.error(`  • ${violation}`);
      }
      console.error(
        "\nFix: add the package to the root tsconfig.json references array,\n" +
          "or add `// tsconfig-ref: excluded — <reason>` to its tsconfig.json.\n",
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      `tsconfig:check passed — all ${found.length} lib tsconfig(s) are accounted for.`,
    );
  } catch (error) {
    console.error(
      `tsconfig:check FAILED — ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  void main();
}