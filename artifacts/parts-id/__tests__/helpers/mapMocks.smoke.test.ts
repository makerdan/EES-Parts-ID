/**
 * Smoke test for createReanimatedMock().
 *
 * WHY THIS EXISTS
 * ---------------
 * The shared createReanimatedMock() in mapMocks.ts stubs a fixed set of named
 * exports from "react-native-reanimated".  If a new hook or utility function
 * is added to WarehouseMapView.tsx but omitted from the mock, every test that
 * uses the shared mock throws a silent "X is not a function" deep inside an
 * unrelated test file, making the root cause hard to trace.
 *
 * HOW IT WORKS
 * ------------
 * Rather than maintaining a second manual list of hook names, this test reads
 * the actual source of WarehouseMapView.tsx at runtime and parses every named
 * (non-type) import from "react-native-reanimated".  Those names become the
 * expected set.  When a developer adds a new hook to the component, this test
 * fails immediately at the mock layer with a clear message — no manual update
 * to the test is required.
 *
 * HOW TO FIX A FAILURE
 * --------------------
 * If this test fails with "X is not a function":
 *   1. Add X to createReanimatedMock() in mapMocks.ts.
 * That's it.  The test itself never needs updating.
 */

import * as fs from "fs";
import * as path from "path";

import { createReanimatedMock } from "./mapMocks";

const WAREHOUSE_MAP_VIEW_PATH = path.resolve(
  __dirname,
  "../../components/WarehouseMapView.tsx",
);

/**
 * Parse every named, non-type import that WarehouseMapView.tsx pulls from
 * "react-native-reanimated".
 *
 * Handles:
 *   import Animated, { foo, type Bar, baz } from "react-native-reanimated";
 *   import { foo, type Bar, baz } from "react-native-reanimated";
 *   import { foo as f, bar } from "react-native-reanimated";
 *
 * Returns only runtime value names (type-only imports are excluded).
 */
function parseReanimatedValueImports(source: string): string[] {
  // Match the named-import brace group from the reanimated import statement.
  // The default export (Animated) is optional and excluded automatically.
  const match = source.match(
    /import\s+(?:Animated\s*,\s*)?\{\s*([^}]+)\s*\}\s*from\s*["']react-native-reanimated["']/,
  );
  if (!match) return [];

  return match[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("type "))
    .map((s) => {
      // "cancelAnimation as ca" → "cancelAnimation"
      const aliasIdx = s.search(/\s+as\s+/);
      return aliasIdx >= 0 ? s.slice(0, aliasIdx).trim() : s;
    });
}

describe("createReanimatedMock() smoke — every Reanimated value import in WarehouseMapView is mocked", () => {
  let mock: Record<string, unknown>;
  let importedNames: string[];

  beforeAll(() => {
    const source = fs.readFileSync(WAREHOUSE_MAP_VIEW_PATH, "utf-8");
    importedNames = parseReanimatedValueImports(source);
    mock = createReanimatedMock() as Record<string, unknown>;
  });

  it("WarehouseMapView.tsx has at least one react-native-reanimated import (sanity check)", () => {
    expect(importedNames.length).toBeGreaterThan(0);
  });

  it("returns an object (mock was called successfully)", () => {
    expect(typeof mock).toBe("object");
    expect(mock).not.toBeNull();
  });

  it("mock exports a function for every named Reanimated import used in WarehouseMapView", () => {
    const notMocked = importedNames.filter(
      (name) => typeof mock[name] !== "function",
    );

    if (notMocked.length > 0) {
      throw new Error(
        `The following react-native-reanimated exports are used by WarehouseMapView.tsx ` +
          `but are missing or not a function in createReanimatedMock():\n` +
          notMocked.map((n) => `  • ${n} (got: ${typeof mock[n]})`).join("\n") +
          `\n\nFix: add each missing export to createReanimatedMock() in mapMocks.ts.`,
      );
    }

    expect(notMocked).toEqual([]);
  });
});
