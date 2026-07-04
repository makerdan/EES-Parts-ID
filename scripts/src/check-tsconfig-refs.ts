#!/usr/bin/env tsx
// check-tsconfig-refs.ts
//
// Scans every lib/[*]/tsconfig.json and lib/[*]/[*]/tsconfig.json and checks
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

import { existsSync, readFileSync } from "fs";
import { glob } from "fs/promises";
import { dirname, relative, resolve } from "path";
import { fileURLToPath } from "url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "../..");
const ROOT_TSCONFIG = resolve(ROOT, "tsconfig.json");

function readJsonStripComments(filePath: string): unknown {
  const raw = readFileSync(filePath, "utf-8");
  const stripped = raw
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  return JSON.parse(stripped);
}

function hasOptOut(tsconfigPath: string): boolean {
  const raw = readFileSync(tsconfigPath, "utf-8");
  return /\/\/\s*tsconfig-ref:\s*excluded/i.test(raw);
}

async function main(): Promise<void> {
  if (!existsSync(ROOT_TSCONFIG)) {
    console.error(`Root tsconfig not found: ${ROOT_TSCONFIG}`);
    process.exit(1);
  }

  const rootConfig = readJsonStripComments(ROOT_TSCONFIG) as {
    references?: Array<{ path: string }>;
  };

  const referencedPaths = new Set(
    (rootConfig.references ?? []).map((ref) => resolve(ROOT, ref.path))
  );

  const patterns = [
    `${ROOT}/lib/*/tsconfig.json`,
    `${ROOT}/lib/*/*/tsconfig.json`,
  ];

  const found: string[] = [];
  for (const pattern of patterns) {
    for await (const match of glob(pattern)) {
      found.push(match as string);
    }
  }

  const violations: string[] = [];

  for (const tsconfigPath of found) {
    const libDir = dirname(tsconfigPath);
    const relDir = relative(ROOT, libDir);

    const isReferenced = referencedPaths.has(libDir);
    const isOptedOut = hasOptOut(tsconfigPath);

    if (!isReferenced && !isOptedOut) {
      violations.push(relDir);
    }
  }

  if (violations.length > 0) {
    console.error(
      "tsconfig:check FAILED — the following lib packages have a tsconfig.json\n" +
        "but are neither listed in the root tsconfig.json references nor opted-out\n" +
        "with a `// tsconfig-ref: excluded — <reason>` comment:\n"
    );
    for (const v of violations) {
      console.error(`  • ${v}`);
    }
    console.error(
      "\nFix: add the package to the root tsconfig.json references array,\n" +
        "or add `// tsconfig-ref: excluded — <reason>` to its tsconfig.json.\n"
    );
    process.exit(1);
  }

  console.log(
    `tsconfig:check passed — all ${found.length} lib tsconfig(s) are accounted for.`
  );
  process.exit(0);
}

main();
