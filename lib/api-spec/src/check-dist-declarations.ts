#!/usr/bin/env tsx
/**
 * check-dist-declarations.ts
 *
 * Verifies that the pre-built declaration files in lib/api-client-react/dist/
 * are up-to-date with the current src/. Runs tsc --emitDeclarationOnly into a
 * temporary directory and diffs every .d.ts file against the committed dist/.
 *
 * This catches the failure mode where dist/index.d.ts goes stale and TypeScript
 * consumers resolving the pre-built declarations get incomplete types.
 *
 * Exit 0: dist is up-to-date.
 * Exit 1: dist is stale — prints the first differing line per file.
 *
 * Usage:
 *   pnpm --filter @workspace/api-spec run dist:check
 */

import { execSync } from "child_process";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  existsSync,
} from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_CLIENT_ROOT = resolve(__dirname, "../../../lib/api-client-react");
const DIST_DIR = resolve(API_CLIENT_ROOT, "dist");

/**
 * Strip `//# sourceMappingURL=...` comment lines and normalize trailing
 * whitespace so a lone trailing newline difference is never flagged.
 */
function stripSourceMapComments(content: string): string {
  return content
    .split("\n")
    .filter((line) => !line.startsWith("//# sourceMappingURL="))
    .join("\n")
    .trimEnd();
}

/** Return a human-readable diff summary for one file pair, or null if equal. */
function diffFiles(
  relPath: string,
  committed: string,
  fresh: string,
): string | null {
  const a = stripSourceMapComments(committed).replace(/\r\n/g, "\n");
  const b = stripSourceMapComments(fresh).replace(/\r\n/g, "\n");
  if (a === b) return null;

  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const maxLen = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < maxLen; i++) {
    if (aLines[i] !== bLines[i]) {
      return (
        `  ${relPath}: first difference at line ${i + 1}\n` +
        `    committed: ${JSON.stringify(aLines[i] ?? "<missing>")}\n` +
        `    fresh:     ${JSON.stringify(bLines[i] ?? "<missing>")}`
      );
    }
  }
  return `  ${relPath}: files differ (lengths ${aLines.length} vs ${bLines.length})`;
}

const DTS_FILES = [
  "index.d.ts",
  "custom-fetch.d.ts",
  "generated/api.d.ts",
  "generated/api.schemas.d.ts",
];

const tmpDir = mkdtempSync(join(tmpdir(), "dist-check-"));

try {
  // Write a temporary tsconfig that compiles src/ into tmpDir without
  // composite/incremental to avoid .tsbuildinfo side-effects.
  const tmpTsconfig = join(tmpDir, "tsconfig.json");
  writeFileSync(
    tmpTsconfig,
    JSON.stringify({
      extends: resolve(API_CLIENT_ROOT, "../../tsconfig.base.json"),
      compilerOptions: {
        composite: false,
        incremental: false,
        declaration: true,
        declarationMap: true,
        emitDeclarationOnly: true,
        outDir: tmpDir,
        rootDir: resolve(API_CLIENT_ROOT, "src"),
        lib: ["dom", "es2022"],
      },
      include: [resolve(API_CLIENT_ROOT, "src")],
    }),
  );

  try {
    execSync(`npx tsc --project ${tmpTsconfig}`, {
      cwd: API_CLIENT_ROOT,
      stdio: "pipe",
    });
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer; stdout?: Buffer };
    const output = [e.stdout?.toString(), e.stderr?.toString()]
      .filter(Boolean)
      .join("\n");
    console.error("❌  dist declarations check failed: tsc exited with errors:");
    console.error(output);
    process.exit(1);
  }

  const failures: string[] = [];

  for (const relPath of DTS_FILES) {
    const committedPath = join(DIST_DIR, relPath);
    const freshPath = join(tmpDir, relPath);

    if (!existsSync(committedPath)) {
      failures.push(`  ${relPath}: missing from dist/ (not committed)`);
      continue;
    }
    if (!existsSync(freshPath)) {
      failures.push(`  ${relPath}: tsc did not generate this file`);
      continue;
    }

    const diff = diffFiles(
      relPath,
      readFileSync(committedPath, "utf8"),
      readFileSync(freshPath, "utf8"),
    );
    if (diff) failures.push(diff);
  }

  if (failures.length > 0) {
    console.error(
      "❌  dist declarations are stale. Run `pnpm --filter @workspace/api-spec run codegen` to rebuild.",
    );
    for (const f of failures) console.error(f);
    process.exit(1);
  } else {
    console.log(
      `✅  dist declarations are up-to-date (checked ${DTS_FILES.length} files).`,
    );
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
