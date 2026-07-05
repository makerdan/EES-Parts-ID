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

import { createFloorPlanCacheMock, createGestureHandlerMock, createReanimatedMock, createUseColorsMock } from "./mapMocks";

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

/**
 * Parse all method names called at depth-0 on each gesture chain in
 * WarehouseMapView.tsx.  "Depth-0" means the method is called directly on the
 * fluent gesture builder object — NOT inside a callback body passed to another
 * method.  For example:
 *
 *   Gesture.Pan()
 *     .minPointers(1)          ← depth-0: captured ✓
 *     .onBegin(() => {
 *       runOnJS(foo)();         ← depth > 0: ignored ✓
 *     })
 *     .onEnd(() => { ... });   ← depth-0: captured ✓
 *
 * Returns a sorted, deduplicated array of method names found across all
 * Pan/Pinch/Tap/LongPress gesture constructions in the file.
 */
function parseGestureChainMethods(
  source: string,
): { type: string; methods: string[] }[] {
  // Strip single-line comments before depth-tracking so unbalanced parens
  // inside comments (e.g. "// screenX = (cx/VBW)*svgRW/2) * ...") do not
  // corrupt the bracket depth counter and cause false-positive method matches.
  const stripped = source
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");

  const GESTURE_TYPES = ["Pan", "Pinch", "Tap", "LongPress", "Fling", "Rotation"];
  const result: { type: string; methods: string[] }[] = [];

  for (const gestureType of GESTURE_TYPES) {
    const methods = new Set<string>();
    const startRe = new RegExp(`Gesture\\.${gestureType}\\(\\)`, "g");
    let m: RegExpExecArray | null;

    while ((m = startRe.exec(stripped)) !== null) {
      let depth = 0;
      let i = m.index + m[0].length;

      while (i < stripped.length) {
        const ch = stripped[i];
        if (ch === "(" || ch === "{" || ch === "[") {
          depth++;
          i++;
        } else if (ch === ")" || ch === "}" || ch === "]") {
          depth--;
          i++;
        } else if (ch === ";" && depth === 0) {
          break;
        } else if (ch === "." && depth === 0) {
          i++;
          const nameStart = i;
          while (i < stripped.length && /\w/.test(stripped[i])) i++;
          const methodName = stripped.slice(nameStart, i);
          if (methodName.length > 0 && i < stripped.length && stripped[i] === "(") {
            methods.add(methodName);
          }
        } else {
          i++;
        }
      }
    }

    if (methods.size > 0) {
      result.push({ type: gestureType, methods: [...methods].sort() });
    }
  }

  return result;
}

describe("createGestureHandlerMock() smoke — every gesture chain method used in WarehouseMapView is mocked", () => {
  /**
   * WHY THIS EXISTS
   * ---------------
   * createGestureHandlerMock() builds chainable gesture objects via a hardcoded
   * list of method names in makeChainable().  If a new method is added to a
   * Gesture.Pan / Pinch / Tap chain in WarehouseMapView.tsx but omitted from
   * that list, the proxy silently swallows the call and tests still pass — the
   * component actually receives `undefined` at runtime.
   *
   * This test extracts every method called at depth-0 on gesture chains in the
   * component source and asserts each one exists as a function on the mock
   * object.  A new method will cause this test to fail immediately with a clear
   * message before it can cause a silent regression.
   *
   * HOW TO FIX A FAILURE
   * --------------------
   * If this test fails with "X is not a function":
   *   1. Add X to the method name array inside makeChainable() in mapMocks.ts.
   * The test itself never needs updating.
   */

  let gestureChains: { type: string; methods: string[] }[];
  let gestureMock: Record<string, (...args: unknown[]) => Record<string, unknown>>;

  beforeAll(() => {
    const source = fs.readFileSync(WAREHOUSE_MAP_VIEW_PATH, "utf-8");
    gestureChains = parseGestureChainMethods(source);
    gestureMock = (
      createGestureHandlerMock() as { Gesture: typeof gestureMock }
    ).Gesture;
  });

  it("WarehouseMapView.tsx uses at least one Gesture chain method (sanity check)", () => {
    const total = gestureChains.reduce((n, g) => n + g.methods.length, 0);
    expect(total).toBeGreaterThan(0);
  });

  it("mock exports a Gesture object with Pan, Pinch, and Tap factories", () => {
    expect(typeof gestureMock.Pan).toBe("function");
    expect(typeof gestureMock.Pinch).toBe("function");
    expect(typeof gestureMock.Tap).toBe("function");
  });

  it("every depth-0 chain method used in WarehouseMapView is callable on the mock chainable object", () => {
    const failures: string[] = [];

    for (const { type, methods } of gestureChains) {
      const factory = gestureMock[type] as (() => Record<string, unknown>) | undefined;
      if (typeof factory !== "function") {
        failures.push(`  • Gesture.${type} factory is missing from the mock`);
        continue;
      }

      const chainable = factory();
      for (const method of methods) {
        if (typeof chainable[method] !== "function") {
          failures.push(
            `  • Gesture.${type}().${method}() — missing from makeChainable() ` +
              `(got: ${typeof chainable[method]})`,
          );
        }
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `The following gesture chain methods are used by WarehouseMapView.tsx ` +
          `but are missing or not a function in createGestureHandlerMock():\n` +
          failures.join("\n") +
          `\n\nFix: add each missing method name to the array inside makeChainable() in mapMocks.ts.`,
      );
    }

    expect(failures).toEqual([]);
  });
});

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

/**
 * Smoke test for createUseColorsMock().
 *
 * WHY THIS EXISTS
 * ---------------
 * createUseColorsMock() returns a hardcoded set of color tokens. If a new
 * token is added to the real useColors hook (via constants/colors.ts) but
 * omitted from the mock, components that destructure it get `undefined`
 * silently — the test passes but the component renders incorrectly.
 *
 * HOW IT WORKS
 * ------------
 * The real useColors() returns { ...palette, radius } where palette is
 * colors.light or colors.dark from constants/colors.ts. This test derives
 * the expected key set from the actual module (via jest.requireActual) so it
 * never drifts independently of the source. When a new token is added to
 * colors.ts, this test fails immediately at the mock layer with a clear
 * message.
 *
 * HOW TO FIX A FAILURE
 * --------------------
 * If this test fails with "Missing keys in createUseColorsMock(): [X, ...]":
 *   1. Add X to the object returned by createUseColorsMock().useColors() in
 *      mapMocks.ts.
 * That's it. The test itself never needs updating.
 */
describe("createUseColorsMock() smoke — every key from the real useColors hook is present in the mock", () => {
  let mockColors: Record<string, unknown>;
  let expectedKeys: string[];

  beforeAll(() => {
    const actual = jest.requireActual<{
      default: {
        light: Record<string, unknown>;
        dark: Record<string, unknown>;
        radius: number;
      };
    }>("@/constants/colors");

    expectedKeys = [...Object.keys(actual.default.light), "radius"];

    const mod = createUseColorsMock() as { useColors: () => Record<string, unknown> };
    mockColors = mod.useColors();
  });

  it("mock useColors() returns an object (sanity check)", () => {
    expect(typeof mockColors).toBe("object");
    expect(mockColors).not.toBeNull();
  });

  it("every key returned by the real useColors hook is present in the mock", () => {
    const missing = expectedKeys.filter((k) => !(k in mockColors));

    if (missing.length > 0) {
      throw new Error(
        `Missing keys in createUseColorsMock():\n` +
          missing.map((k) => `  • ${k}`).join("\n") +
          `\n\nFix: add each missing token to createUseColorsMock().useColors() in mapMocks.ts.`,
      );
    }

    expect(missing).toEqual([]);
  });
});

/**
 * Smoke test for createFloorPlanCacheMock().
 *
 * WHY THIS EXISTS
 * ---------------
 * createFloorPlanCacheMock() in mapMocks.ts hardcodes a fixed set of function
 * stubs for "@/utils/floorPlanCache".  If a new function is added to
 * floorPlanCache.ts but omitted from the mock, call sites inside components
 * get `undefined` and tests throw a confusing "X is not a function" error deep
 * inside an unrelated test file, making the root cause hard to trace.
 *
 * HOW IT WORKS
 * ------------
 * This test uses jest.requireActual to load the real floorPlanCache module,
 * then filters its exports down to those whose value is a function.  Those
 * names become the expected set.  When a developer adds a new function to
 * floorPlanCache.ts, this test fails immediately at the mock layer with a
 * clear message — no manual update to this test file is ever required.
 *
 * HOW TO FIX A FAILURE
 * --------------------
 * If this test fails with "Missing or non-function in createFloorPlanCacheMock(): [X, ...]":
 *   1. Add X as a jest.fn() stub to createFloorPlanCacheMock() in mapMocks.ts.
 * That's it.  The test itself never needs updating.
 */
describe("createFloorPlanCacheMock() smoke — every function export of floorPlanCache is present in the mock", () => {
  let mock: Record<string, unknown>;
  let expectedFnNames: string[];

  beforeAll(() => {
    const actual = jest.requireActual<Record<string, unknown>>(
      "@/utils/floorPlanCache",
    );

    expectedFnNames = Object.entries(actual)
      .filter(([, v]) => typeof v === "function")
      .map(([k]) => k);

    mock = createFloorPlanCacheMock() as Record<string, unknown>;
  });

  it("floorPlanCache.ts exports at least one function (sanity check)", () => {
    expect(expectedFnNames.length).toBeGreaterThan(0);
  });

  it("createFloorPlanCacheMock() returns an object (sanity check)", () => {
    expect(typeof mock).toBe("object");
    expect(mock).not.toBeNull();
  });

  it("mock has a function stub for every function exported by floorPlanCache.ts", () => {
    const missing = expectedFnNames.filter(
      (name) => typeof mock[name] !== "function",
    );

    if (missing.length > 0) {
      throw new Error(
        `The following floorPlanCache.ts function exports are missing or not a ` +
          `function in createFloorPlanCacheMock():\n` +
          missing.map((n) => `  • ${n} (got: ${typeof mock[n]})`).join("\n") +
          `\n\nFix: add each missing export as a jest.fn() stub to ` +
          `createFloorPlanCacheMock() in mapMocks.ts.`,
      );
    }

    expect(missing).toEqual([]);
  });
});

