#!/usr/bin/env tsx
/**
 * check-barrel.ts
 *
 * Verifies that every name exported by generated/api.ts and
 * generated/api.schemas.ts is reachable from lib/api-client-react/src/index.ts
 * via transitive `export * from` chains.
 *
 * This catches the failure mode where index.ts is missing an
 * `export * from "./generated/api"` line, making all React Query hooks
 * invisible to TypeScript consumers.
 *
 * Exit 0: all generated names are reachable.
 * Exit 1: one or more names are missing — prints the list.
 *
 * Usage:
 *   pnpm --filter @workspace/api-spec run barrel:check
 */

import { readFileSync } from "fs";
import { dirname, join,resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_CLIENT_SRC = resolve(__dirname, "../../../lib/api-client-react/src");

/**
 * Extract every name that a TypeScript source file explicitly exports.
 * Handles: export const/function/class/enum/type/interface NAME
 *          export { a, b as c }
 * Does NOT follow re-exports — that is handled by collectReachableNames.
 */
function extractExportedNames(filePath: string): Set<string> {
  const src = readFileSync(filePath, "utf8");
  const names = new Set<string>();

  // export [declare] const | function | class | enum | type | interface | abstract class NAME
  const declRe =
    /^export\s+(?:declare\s+)?(?:abstract\s+class|const|function|class|enum|type|interface)\s+(\w+)/gm;
  for (const m of src.matchAll(declRe)) {
    names.add(m[1]);
  }

  // export { name1, name2 as alias2, ... }
  const namedRe = /^export\s+\{([^}]+)\}/gm;
  for (const m of src.matchAll(namedRe)) {
    for (const segment of m[1].split(",")) {
      // "foo as bar" → we want the exported name "bar"; plain "foo" → "foo"
      const parts = segment.trim().split(/\s+as\s+/);
      const exported = parts[parts.length - 1].trim();
      if (exported) names.add(exported);
    }
  }

  return names;
}

/**
 * Starting from entryFile, follow every `export * from "..."` chain and
 * accumulate all directly-declared exported names that are reachable.
 */
function collectReachableNames(entryFile: string): Set<string> {
  const names = new Set<string>();
  const visited = new Set<string>();

  function visit(filePath: string): void {
    if (visited.has(filePath)) return;
    visited.add(filePath);

    const src = readFileSync(filePath, "utf8");
    const dir = dirname(filePath);

    for (const name of extractExportedNames(filePath)) {
      names.add(name);
    }

    // Follow `export * from "..."` and `export * as ns from "..."`
    const reExportRe =
      /^export\s+\*(?:\s+as\s+\w+)?\s+from\s+["']([^"']+)["']/gm;
    for (const m of src.matchAll(reExportRe)) {
      const specifier = m[1];
      if (!specifier.startsWith(".")) continue; // skip node_modules

      // Try .ts → /index.ts → bare (already has extension)
      const candidates = [
        join(dir, specifier + ".ts"),
        join(dir, specifier, "index.ts"),
        join(dir, specifier),
      ];
      for (const candidate of candidates) {
        try {
          readFileSync(candidate); // existence check only
          visit(candidate);
          break;
        } catch {
          // not found, try next
        }
      }
    }
  }

  visit(entryFile);
  return names;
}

const indexFile = resolve(API_CLIENT_SRC, "index.ts");
const apiFile = resolve(API_CLIENT_SRC, "generated/api.ts");
const schemasFile = resolve(API_CLIENT_SRC, "generated/api.schemas.ts");

const reachable = collectReachableNames(indexFile);

const required = new Set<string>([
  ...extractExportedNames(apiFile),
  ...extractExportedNames(schemasFile),
]);

const missing = [...required].filter((name) => !reachable.has(name)).sort();

if (missing.length > 0) {
  console.error(
    "❌  Barrel check failed: the following names from generated/ are NOT" +
      " reachable from src/index.ts:",
  );
  for (const name of missing) {
    console.error(`   - ${name}`);
  }
  console.error(
    "\nFix: ensure src/index.ts contains `export * from \"./generated/api\"`" +
      " and `export * from \"./generated/api.schemas\"`.",
  );
  process.exit(1);
} else {
  console.log(
    `✅  Barrel check passed: all ${required.size} generated names are reachable from src/index.ts`,
  );
}
