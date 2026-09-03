/**
 * Smoke test for the canonical react-native mock.
 *
 * Every shipped Parts ID source file is scanned for runtime named imports from
 * react-native.  If a component starts using a native export that is missing
 * from __mocks__/react-native.js, this test fails at the mock boundary instead
 * of allowing a mounted component to crash before its assertions run.
 */

import * as fs from "fs";
import * as path from "path";

const ARTIFACT_ROOT = path.resolve(__dirname, "../..");
const NATIVE_MOCK_PATH = path.resolve(ARTIFACT_ROOT, "__mocks__/react-native.js");
const IGNORED_DIRS = new Set([
  "node_modules",
  "__tests__",
  "__mocks__",
  ".expo",
  "dist",
  "build",
  "coverage",
]);

// These legacy imports are used only as TypeScript annotations in source
// files. They are erased from the runtime bundle and therefore do not belong
// in a JavaScript mock contract.
const TYPE_ONLY_NATIVE_EXPORTS = new Set([
  "AppStateStatus",
  "LayoutChangeEvent",
  "ScrollViewProps",
]);

function collectSourceFiles(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(fullPath, files);
    } else if (/\.(?:ts|tsx|js|jsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Read named imports without attempting to parse the whole TypeScript AST.
 * Each import declaration is collected line-by-line until its react-native
 * source clause is reached. This deliberately ignores type-only bindings
 * because they do not exist at runtime.
 */
function collectNativeImports(source: string): Set<string> {
  const names = new Set<string>();
  const lines = source.split(/\r?\n/);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    if (!/^\s*import\b/.test(lines[lineIndex] ?? "")) continue;

    let declaration = lines[lineIndex] ?? "";
    while (
      lineIndex + 1 < lines.length &&
      !/;\s*$/.test(declaration) &&
      !/\s+from\s+["'][^"']+["']\s*$/.test(declaration)
    ) {
      declaration += `\n${lines[++lineIndex]}`;
    }

    const match = declaration.match(
      /^\s*import\s+([\s\S]*?)\s+from\s+["']react-native["']\s*;?\s*$/,
    );
    if (!match) continue;
    const clause = match[1] ?? "";
    if (/^\s*type\b/.test(clause)) continue;
    const named = clause.match(/\{([\s\S]*)\}/)?.[1] ?? "";
    for (const binding of named.split(",")) {
      const trimmed = binding.trim();
      if (!trimmed || trimmed.startsWith("type ")) continue;
      const importedName = (trimmed.split(/\s+as\s+/)[0] ?? trimmed).trim();
      if (!TYPE_ONLY_NATIVE_EXPORTS.has(importedName)) names.add(importedName);
    }
  }

  return names;
}

describe("canonical react-native mock smoke", () => {
  it("exports every runtime named API imported by shipped Parts ID sources", () => {
    const expected = new Set<string>();
    for (const file of collectSourceFiles(ARTIFACT_ROOT)) {
      for (const name of collectNativeImports(fs.readFileSync(file, "utf8"))) {
        expected.add(name);
      }
    }

    const nativeMock = require(NATIVE_MOCK_PATH) as Record<string, unknown>;
    const missing = [...expected].filter((name) => !(name in nativeMock)).sort();

    expect(expected.size).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it("keeps the gesture API callable for components that use PanResponder", () => {
    const nativeMock = require(NATIVE_MOCK_PATH) as {
      PanResponder?: { create?: unknown };
    };

    expect(typeof nativeMock.PanResponder?.create).toBe("function");
  });
});
