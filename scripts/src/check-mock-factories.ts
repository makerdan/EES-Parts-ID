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
import { join, dirname, resolve, extname, relative, sep } from "path";
import { fileURLToPath } from "url";
import ts from "typescript";

// ── Configuration ─────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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

const EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  "/index.ts",
  "/index.tsx",
  "/index.mts",
  "/index.cts",
  "/index.js",
  "/index.jsx",
];

function resolveFile(base: string): string | null {
  if (extname(base) && existsSync(base)) return base;
  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolveModulePath(rawPath: string, fromFile: string): string | null {
  const fromDir = dirname(fromFile);

  if (rawPath.startsWith(".")) {
    return resolveFile(resolve(fromDir, rawPath));
  }

  if (rawPath.startsWith("@workspace/")) {
    const packageName = Object.keys(WORKSPACE_MAP).find(
      (name) => rawPath === name || rawPath.startsWith(`${name}/`),
    );
    if (!packageName) return null;

    const srcRoot = resolve(REPO_ROOT, WORKSPACE_MAP[packageName]!);
    const subpath = rawPath.slice(packageName.length).replace(/^\/+/, "");
    const base = resolve(srcRoot, subpath || ".");
    const relativeToRoot = relative(srcRoot, base);
    if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${sep}`)) {
      return null;
    }
    return resolveFile(base);
  }

  // Third-party npm package — skip.
  return null;
}

// ── Class-export detection ────────────────────────────────────────────────────

/**
 * Returns the names of top-level `export class Foo` declarations in a source
 * file.  Uses a simple regex — accurate enough for well-structured TS source.
 */
export function exportedClassNames(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  const src = readFileSync(filePath, "utf-8");
  const sourceFile = ts.createSourceFile(
    filePath,
    src,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const localClasses = new Set<string>();
  const exportedClasses = new Set<string>();

  const hasExportModifier = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    !!ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      localClasses.add(node.name.text);
      if (hasExportModifier(node)) exportedClasses.add(node.name.text);
    }

    if (
      ts.isExportDeclaration(node) &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const element of node.exportClause.elements) {
        if (localClasses.has(element.propertyName?.text ?? element.name.text)) {
          exportedClasses.add(element.name.text);
        }
      }
    }

    if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression)) {
      if (localClasses.has(node.expression.text)) exportedClasses.add("default");
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...exportedClasses];
}

// ── jest.mock call parsing ────────────────────────────────────────────────────

export interface MockCall {
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
export function parseMockCalls(src: string, filePath = "fixture.ts"): MockCall[] {
  const calls: MockCall[] = [];
  const sourceFile = ts.createSourceFile(
    filePath,
    src,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const isJestMethodCall = (expression: ts.Expression, method: string): boolean =>
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "jest" &&
    expression.name.text === method;
  const isModulePath = (
    node: ts.Node | undefined,
  ): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
    !!node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
  const containsRequireActualCall = (node: ts.Node): boolean => {
    let found = false;
    const visit = (child: ts.Node): void => {
      if (ts.isCallExpression(child) && isJestMethodCall(child.expression, "requireActual")) {
        found = true;
        return;
      }
      ts.forEachChild(child, visit);
    };
    ts.forEachChild(node, visit);
    return found;
  };
  const visit = (node: ts.Node): void => {
    const factory = ts.isCallExpression(node) ? node.arguments[1] : undefined;
    if (
      ts.isCallExpression(node) &&
      isJestMethodCall(node.expression, "mock") &&
      node.arguments.length >= 2 &&
      isModulePath(node.arguments[0]) &&
      factory !== undefined &&
      (ts.isArrowFunction(factory) || ts.isFunctionExpression(factory))
    ) {
      calls.push({
        modulePath: node.arguments[0].text,
        factoryCallsRequireActual: containsRequireActualCall(factory),
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

// ── Violation type ────────────────────────────────────────────────────────────

export interface Violation {
  testFile: string;
  line: number;
  modulePath: string;
  resolvedFile: string;
  exportedClasses: string[];
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function scanFile(filePath: string): Violation[] {
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

if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  main();
}
