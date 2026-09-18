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
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { declarationInventoryFailures } from "./check-dist-declarations-helpers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_CLIENT_ROOT = resolve(__dirname, "../../../lib/api-client-react");
const DIST_DIR = resolve(API_CLIENT_ROOT, "dist");
const manifest = JSON.parse(
  readFileSync(resolve(__dirname, "../generated-output-manifest.json"), "utf8"),
) as {
  declarationFiles: Array<string>;
};

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

function declarationFilesIn(root: string): Set<string> {
  const files = new Set<string>();
  function visit(dir: string, prefix = ""): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(entryPath, relativePath);
      } else if (entry.isFile() && entry.name.endsWith(".d.ts")) {
        files.add(relativePath);
      }
    }
  }
  visit(root);
  return files;
}

const DECLARATION_PREFIX = "lib/api-client-react/dist/";
const expectedDtsFiles = new Set(
  manifest.declarationFiles.map((path) => {
    if (!path.startsWith(DECLARATION_PREFIX)) {
      throw new Error(
        `declaration manifest entry is outside api-client-react/dist: ${path}`,
      );
    }
    return path.slice(DECLARATION_PREFIX.length);
  }),
);

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

  const failures: Array<string> = [];

  const freshDtsFiles = declarationFilesIn(tmpDir);
  const committedDtsFiles = declarationFilesIn(DIST_DIR);

  for (const relPath of expectedDtsFiles) {
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

  failures.push(
    ...declarationInventoryFailures(
      expectedDtsFiles,
      freshDtsFiles,
      committedDtsFiles,
    ),
  );

  if (failures.length > 0) {
    console.error(
      "❌  dist declarations are stale. Run `pnpm --filter @workspace/api-spec run codegen` to rebuild.",
    );
    for (const f of failures) console.error(f);
    process.exit(1);
  } else {
    console.log(
      `✅  dist declarations are up-to-date (checked ${expectedDtsFiles.size} files).`,
    );
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
