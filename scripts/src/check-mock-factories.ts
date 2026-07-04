#!/usr/bin/env tsx
/**
 * check-mock-factories.ts
 *
 * Scans every *.test.ts and *.test.tsx file in the monorepo for
 * `jest.mock(modulePath, factoryFn)` calls where:
 *   1. The real module at `modulePath` exports one or more `class` declarations.
 *   2. The factory function does NOT call `jest.requireActual`.
 *
 * Any such call is a latent bug: `instanceof` checks performed by the
 * production code under test will silently break because the mock factory
 * returns a different class identity than the real module.
 *
 * Exit codes:
 *   0  — no violations found
 *   1  — one or more violations found (list printed to stderr)
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, dirname, resolve, extname } from "path";

// ── Configuration ─────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "../..");

/** Directories to scan for test files (relative to REPO_ROOT). */
const SCAN_DIRS = [
  "artifacts/api-server/__tests__",
  "artifacts/api-server/src",
  "artifacts/parts-id/__tests__",
  "artifacts/parts-id/components/__tests__",
  "lib",
];

/**
 * Maps `@workspace/<name>` to the source directory (relative to REPO_ROOT)
 * that holds the package's index.ts entry point.
 */
const WORKSPACE_MAP: Record<string, string> = {
  "@workspace/db": "lib/db/src",
  "@workspace/api-client-react": "lib/api-client-react/src",
  "@workspace/api-zod": "lib/api-zod/src",
  "@workspace/api-spec": "lib/api-spec/src",
  "@workspace/zone-validation": "lib/zone-validation/src",
  "@workspace/integrations-openai-ai-server": "lib/integrations-openai-ai-server/src",
  "@workspace/integrations-openai-ai-react": "lib/integrations-openai-ai-react/src",
  "@workspace/integrations-gemini-ai": "lib/integrations-gemini-ai/src",
  "@workspace/integrations-poe-server": "lib/integrations-poe-server/src",
};

// ── File walking ──────────────────────────────────────────────────────────────

function walkTestFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...walkTestFiles(full));
    } else if (/\.test\.tsx?$/.test(entry)) {
      results.push(full);
    }
  }
  return results;
}

// ── Module resolution ─────────────────────────────────────────────────────────

const EXTENSIONS = [".ts", ".tsx", "/index.ts", "/index.tsx"];

function resolveModulePath(rawPath: string, fromFile: string): string | null {
  const fromDir = dirname(fromFile);

  if (rawPath.startsWith(".")) {
    const base = resolve(fromDir, rawPath);
    if (extname(base) && existsSync(base)) return base;
    for (const ext of EXTENSIONS) {
      const candidate = base + ext;
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  if (rawPath.startsWith("@workspace/")) {
    const srcDir = WORKSPACE_MAP[rawPath];
    if (!srcDir) return null;
    for (const idx of ["index.ts", "index.tsx"]) {
      const p = join(REPO_ROOT, srcDir, idx);
      if (existsSync(p)) return p;
    }
    return null;
  }

  // Third-party npm package — skip.
  return null;
}

// ── Class-export detection ────────────────────────────────────────────────────

/**
 * Returns the names of top-level `export class Foo` declarations in a source
 * file.  Uses a simple regex — accurate enough for well-structured TS source.
 */
function exportedClassNames(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  const src = readFileSync(filePath, "utf-8");
  const names: string[] = [];
  // Match: export class Foo / export abstract class Foo
  const re = /\bexport\s+(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    names.push(m[1]);
  }
  return names;
}

// ── jest.mock call parsing ────────────────────────────────────────────────────

interface MockCall {
  /** First argument: the module path. */
  modulePath: string;
  /** Whether the factory body calls jest.requireActual. */
  factoryCallsRequireActual: boolean;
  /** Line number (1-based) of the jest.mock call. */
  line: number;
}

/**
 * Extracts all `jest.mock(path, factory)` calls from source text.
 *
 * Strategy:
 *  1. Find every occurrence of `jest.mock(`.
 *  2. Extract the first string argument as the module path.
 *  3. Check if a second argument is present (factory function).
 *  4. Walk balanced parens to capture the full call text, then search for
 *     `jest.requireActual` within it.
 */
function parseMockCalls(src: string): MockCall[] {
  const calls: MockCall[] = [];
  const lines = src.split("\n");

  // Build a lookup: character offset → 1-based line number.
  const offsetToLine = (offset: number): number => {
    let lineNo = 1;
    for (let i = 0; i < offset && i < src.length; i++) {
      if (src[i] === "\n") lineNo++;
    }
    return lineNo;
  };

  const mockRe = /jest\.mock\(/g;
  let match: RegExpExecArray | null;

  while ((match = mockRe.exec(src)) !== null) {
    const callStart = match.index;

    // Walk balanced parentheses to find the end of the jest.mock(…) call.
    let depth = 1;
    let i = callStart + match[0].length; // position right after the opening `(`
    let inString: string | null = null;
    let escaped = false;

    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (escaped) { escaped = false; i++; continue; }
      if (ch === "\\") { escaped = true; i++; continue; }
      if (inString) {
        if (ch === inString) inString = null;
        i++; continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { inString = ch; i++; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      i++;
    }

    const callText = src.slice(callStart, i);

    // Extract the first string argument (the module path).
    const pathMatch = callText.match(/jest\.mock\(\s*(['"`])(.+?)\1/);
    if (!pathMatch) continue;
    const modulePath = pathMatch[2];

    // Determine whether a factory (second argument) is present.
    // Look for a comma after the closing quote, then a `(` or `=>`
    // which signals an arrow/function expression.
    const afterPath = callText.slice(pathMatch[0].length);
    const hasFactory = /,\s*(?:async\s*)?(?:\(|function\s)/.test(afterPath) ||
                        /,\s*(?:async\s+)?\(/.test(afterPath);
    if (!hasFactory) continue;

    const factoryCallsRequireActual = callText.includes("jest.requireActual");
    const line = offsetToLine(callStart);

    calls.push({ modulePath, factoryCallsRequireActual, line });
  }

  return lines.length > 0 ? calls : []; // silence unused var warning
}

// ── Violation type ────────────────────────────────────────────────────────────

interface Violation {
  testFile: string;
  line: number;
  modulePath: string;
  resolvedFile: string;
  exportedClasses: string[];
}

// ── Main ──────────────────────────────────────────────────────────────────────

function scanFile(filePath: string): Violation[] {
  let src: string;
  try {
    src = readFileSync(filePath, "utf-8");
  } catch { return []; }

  const violations: Violation[] = [];

  for (const call of parseMockCalls(src)) {
    if (call.factoryCallsRequireActual) continue;

    const resolved = resolveModulePath(call.modulePath, filePath);
    if (!resolved) continue;

    const classes = exportedClassNames(resolved);
    if (classes.length === 0) continue;

    violations.push({
      testFile: filePath,
      line: call.line,
      modulePath: call.modulePath,
      resolvedFile: resolved,
      exportedClasses: classes,
    });
  }

  return violations;
}

function main(): void {
  const allFiles: string[] = SCAN_DIRS.flatMap((dir) =>
    walkTestFiles(join(REPO_ROOT, dir)),
  );

  const allViolations: Violation[] = allFiles.flatMap(scanFile);

  if (allViolations.length === 0) {
    console.log("✓ No jest.mock factory violations found.");
    process.exit(0);
  }

  process.stderr.write(
    `✗ Found ${allViolations.length} jest.mock factory violation(s):\n\n`,
  );

  for (const v of allViolations) {
    const rel = v.testFile.replace(REPO_ROOT + "/", "");
    const classes = v.exportedClasses.join(", ");
    process.stderr.write(`  ${rel}:${v.line}\n`);
    process.stderr.write(
      `    mock("${v.modulePath}") — real module exports: ${classes}\n`,
    );
    process.stderr.write(
      `    Fix: spread jest.requireActual("${v.modulePath}") in the factory.\n\n`,
    );
  }

  process.exit(1);
}

main();
