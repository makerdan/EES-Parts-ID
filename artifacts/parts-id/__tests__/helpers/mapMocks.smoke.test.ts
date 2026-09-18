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

import {
  createExpoAssetMock,
  createFloorPlanCacheMock,
  createMapViewportMock,
  createReanimatedMock,
  createReanimatedMockWithCancelSpy,
  createReanimatedMockWithPropsCallback,
  createReanimatedMockWithTimingSpy,
  createSvgMock,
  createUseColorsMock,
} from "./mapMocks";

// jest.config.js moduleNameMapper routes react-native-gesture-handler to
// __mocks__/react-native-gesture-handler.js automatically — no jest.mock() needed.

const WAREHOUSE_MAP_VIEW_PATH = path.resolve(
  __dirname,
  "../../components/WarehouseMapView.tsx",
);

/** Root of the parts-id artifact (this file lives at __tests__/helpers/). */
const ARTIFACT_ROOT = path.resolve(__dirname, "../..");

/** Directories that never contain shipped, test-consumed component source. */
const SCAN_IGNORE_DIRS = new Set([
  "node_modules", "__tests__", "__mocks__",
  ".expo", "dist", "build", "coverage",
]);

/**
 * Recursively collect every .ts/.tsx source file under `dir`, skipping test,
 * mock, and build directories.  Used to find *all* components that import
 * react-native-reanimated — not just WarehouseMapView — so the shared mock is
 * validated against the entire real usage surface.
 */
function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      if (SCAN_IGNORE_DIRS.has(entry.name)) continue;
      collectSourceFiles(path.join(dir, entry.name), acc);
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      acc.push(path.join(dir, entry.name));
    }
  }
  return acc;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface ReanimatedUsage {
  /** Exported names of named value imports (aliases resolved to exported name). */
  namedValueExports: Set<string>;
  /** Exported name → members accessed on it as a namespace (e.g. Easing.bezier). */
  namespaceMembers: Map<string, Set<string>>;
  /** Members accessed on the default import binding (e.g. Animated.View). */
  defaultMembers: Set<string>;
  /** Number of source files found importing react-native-reanimated. */
  fileCount: number;
}

/**
 * Parse the full react-native-reanimated usage surface across every source
 * file: named value imports, members accessed on named imports used as
 * namespace objects (Easing.bezier, …), and members accessed on the default
 * `Animated` import (Animated.View, Animated.createAnimatedComponent, …).
 *
 * Handles aliased imports (`foo as f`) by scanning usage under the *local*
 * binding while keying the mock lookup off the *exported* name.
 */
function collectReanimatedUsage(files: string[]): ReanimatedUsage {
  const usage: ReanimatedUsage = {
    namedValueExports: new Set(),
    namespaceMembers: new Map(),
    defaultMembers: new Set(),
    fileCount: 0,
  };

  // Optional default binding, optional named brace group. `[^}]` spans newlines
  // so multiline import statements are matched.
  const importRe =
    /import\s+(?:([A-Za-z_$][\w$]*)\s*,\s*)?(?:\{([^}]*)\})?\s*from\s*["']react-native-reanimated["']/;

  for (const file of files) {
    const source = fs.readFileSync(file, "utf-8");
    const m = source.match(importRe);
    if (!m) continue;
    usage.fileCount++;

    const defaultLocal = m[1] ?? null;
    const namedRaw = m[2] ?? "";

    const named: { local: string; exported: string }[] = namedRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith("type "))
      .map((s) => {
        const aliasIdx = s.search(/\s+as\s+/);
        if (aliasIdx >= 0) {
          return {
            exported: s.slice(0, aliasIdx).trim(),
            local: s.slice(aliasIdx).replace(/^\s+as\s+/, "").trim(),
          };
        }
        return { exported: s, local: s };
      });

    for (const { local, exported } of named) {
      usage.namedValueExports.add(exported);
      const memberRe = new RegExp(
        `\\b${escapeRegExp(local)}\\.([A-Za-z_$][\\w$]*)`,
        "g",
      );
      let mm: RegExpExecArray | null;
      while ((mm = memberRe.exec(source)) !== null) {
        if (!usage.namespaceMembers.has(exported)) {
          usage.namespaceMembers.set(exported, new Set());
        }
        usage.namespaceMembers.get(exported)!.add(mm[1]!);
      }
    }

    if (defaultLocal) {
      const memberRe = new RegExp(
        `\\b${escapeRegExp(defaultLocal)}\\.([A-Za-z_$][\\w$]*)`,
        "g",
      );
      let mm: RegExpExecArray | null;
      while ((mm = memberRe.exec(source)) !== null) {
        usage.defaultMembers.add(mm[1]!);
      }
    }
  }

  return usage;
}

/**
 * Parse every named, non-type import that WarehouseMapView.tsx pulls from
 * "react-native-svg".  Returns the ORIGINAL export names (the left-hand side of
 * any "as" alias), since those are the keys createSvgMock() must expose.
 *
 * Handles:
 *   import { Path, Rect, Text as SvgText, type NumberProp } from "react-native-svg";
 *   import Svg, { G, Path } from "react-native-svg";
 *
 * Type-only imports (`type Foo`) are excluded — they never reach the runtime
 * mock.
 */
function parseSvgElementImports(source: string): string[] {
  const match = source.match(
    /import\s+(?:\w+\s*,\s*)?\{\s*([^}]+)\s*\}\s*from\s*["']react-native-svg["']/,
  );
  if (!match || match[1] === undefined) return [];

  return match[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("type "))
    .map((s) => {
      // "Text as SvgText" → "Text" (mock is keyed by the real export name).
      const aliasIdx = s.search(/\s+as\s+/);
      return aliasIdx >= 0 ? s.slice(0, aliasIdx).trim() : s;
    });
}

/**
 * Parse every `Asset.<method>(` call site in WarehouseMapView.tsx.  Returns the
 * sorted, deduplicated set of method names invoked on the expo-asset `Asset`
 * object.  These are the methods createExpoAssetMock().Asset must expose.
 */
function parseExpoAssetMethods(source: string): string[] {
  const methods = new Set<string>();
  const re = /\bAsset\.(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    methods.add(m[1]!);
  }
  return [...methods].sort();
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
          while (i < stripped.length && /\w/.test(stripped[i]!)) i++;
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

describe("react-native-gesture-handler file mock smoke — every gesture chain method used in WarehouseMapView is mocked", () => {
  /**
   * WHY THIS EXISTS
   * ---------------
   * The unified file mock at __mocks__/react-native-gesture-handler.js builds
   * chainable gesture objects via a hardcoded list of method names in
   * CHAINABLE_METHODS.  If a new method is added to a Gesture.Pan / Pinch / Tap
   * chain in WarehouseMapView.tsx but omitted from that list, the call returns
   * `undefined` and tests silently break.
   *
   * This test extracts every method called at depth-0 on gesture chains in the
   * component source and asserts each one exists as a function on the mock
   * object.  A new method will cause this test to fail immediately with a clear
   * message before it can cause a silent regression.
   *
   * HOW TO FIX A FAILURE
   * --------------------
   * If this test fails with "X is not a function":
   *   1. Add X to CHAINABLE_METHODS in __mocks__/react-native-gesture-handler.js.
   * The test itself never needs updating.
   */

  let gestureChains: { type: string; methods: string[] }[];
  let gestureMock: Record<string, (...args: unknown[]) => Record<string, unknown>>;

  beforeAll(() => {
    const source = fs.readFileSync(WAREHOUSE_MAP_VIEW_PATH, "utf-8");
    gestureChains = parseGestureChainMethods(source);
    // Obtain the mock via require() — Jest resolves this to the file mock
    // because jest.mock("react-native-gesture-handler") is called at the top.
    gestureMock = (
      require("react-native-gesture-handler") as { Gesture: typeof gestureMock }
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

  it("mock exports __simulateTap and __resetTap helpers", () => {
    const gh = require("react-native-gesture-handler") as Record<string, unknown>;
    expect(typeof gh.__simulateTap).toBe("function");
    expect(typeof gh.__resetTap).toBe("function");
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
            `  • Gesture.${type}().${method}() — missing from CHAINABLE_METHODS ` +
              `in __mocks__/react-native-gesture-handler.js ` +
              `(got: ${typeof chainable[method]})`,
          );
        }
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `The following gesture chain methods are used by WarehouseMapView.tsx ` +
          `but are missing or not a function in the file mock:\n` +
          failures.join("\n") +
          `\n\nFix: add each missing method name to CHAINABLE_METHODS in ` +
          `__mocks__/react-native-gesture-handler.js.`,
      );
    }

    expect(failures).toEqual([]);
  });

  it("__simulateTap fires the last registered Gesture.Tap onEnd callback", () => {
    const gh = require("react-native-gesture-handler") as {
      Gesture: { Tap: () => Record<string, (...args: unknown[]) => unknown> };
      __simulateTap: (e?: unknown) => void;
      __resetTap: () => void;
    };

    gh.__resetTap();

    let received: unknown = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gh.Gesture.Tap() as any).runOnJS(true).onEnd((e: unknown) => { received = e; });

    const event = { x: 10, y: 20 };
    gh.__simulateTap(event);
    expect(received).toBe(event);

    gh.__resetTap();
  });

  it("__simulateTap throws when no onEnd has been registered", () => {
    const gh = require("react-native-gesture-handler") as {
      __simulateTap: () => void;
      __resetTap: () => void;
    };
    gh.__resetTap();
    expect(() => gh.__simulateTap()).toThrow("No Gesture.Tap onEnd callback registered");
  });
});

/**
 * Smoke test for createReanimatedMock().
 *
 * WHY THIS EXISTS
 * ---------------
 * createReanimatedMock() in mapMocks.ts hardcodes its full export surface: the
 * named value hooks (useSharedValue, withTiming, …), the default `Animated`
 * object (View, ScrollView, createAnimatedComponent), and the `Easing`
 * sub-object.  An earlier smoke test only checked the *named value imports of
 * WarehouseMapView.tsx* — it could not catch drift in the default object's
 * members (Animated.View, …) or a differently-shaped `Easing` sub-object, and
 * it was blind to any other component that consumes reanimated.
 *
 * HOW IT WORKS
 * ------------
 * This test scans EVERY .ts/.tsx source file under the artifact (excluding
 * tests, mocks, and build output) for react-native-reanimated usage and builds
 * the real usage surface:
 *   • named value imports        → must be a function on the mock
 *   • namespace members (X.foo)  → mock[X] must be an object exposing `foo`
 *                                  (this is what guards the Easing sub-object)
 *   • default members (Animated.foo) → mock.default.foo must be a function
 * When any component adds a new hook, a new Animated.* member, or an Easing.*
 * call that the mock doesn't provide, this test fails immediately with a clear
 * message — no manual list to maintain.
 *
 * HOW TO FIX A FAILURE
 * --------------------
 * Add the reported export/member to createReanimatedMock() in mapMocks.ts.
 * The test itself never needs updating.
 */
describe("createReanimatedMock() smoke — reanimated export surface matches real usage across all source files", () => {
  let mock: Record<string, unknown>;
  let usage: ReanimatedUsage;

  beforeAll(() => {
    usage = collectReanimatedUsage(collectSourceFiles(ARTIFACT_ROOT));
    mock = createReanimatedMock() as Record<string, unknown>;
  });

  it("at least one source file imports react-native-reanimated (sanity check)", () => {
    expect(usage.fileCount).toBeGreaterThan(0);
  });

  it("uses at least one member of the default Animated export (sanity check)", () => {
    // Guards against a future refactor silently disabling the default-export
    // assertion below (which would make the mock's default object untested).
    expect(usage.defaultMembers.size).toBeGreaterThan(0);
  });

  it("returns an object (mock was called successfully)", () => {
    expect(typeof mock).toBe("object");
    expect(mock).not.toBeNull();
  });

  it("mock provides every named reanimated import used across source files, correctly shaped", () => {
    const failures: string[] = [];

    for (const name of [...usage.namedValueExports].sort()) {
      const members = usage.namespaceMembers.get(name);
      const val = mock[name];

      if (members && members.size > 0) {
        // Used as a namespace object (e.g. Easing.bezier, Easing.inOut).
        if (val === null || typeof val !== "object") {
          failures.push(
            `  • ${name} — accessed as a namespace object (${name}.${[...members][0]}) ` +
              `but the mock exports ${val === null ? "null" : typeof val}`,
          );
          continue;
        }
        for (const member of [...members].sort()) {
          if ((val as Record<string, unknown>)[member] === undefined) {
            failures.push(
              `  • ${name}.${member} — missing from the ${name} sub-object in the mock`,
            );
          }
        }
      } else if (typeof val !== "function") {
        // Used as a plain value/hook — must be a callable function.
        failures.push(`  • ${name} — missing or not a function (got: ${typeof val})`);
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `The following react-native-reanimated exports are used by the app ` +
          `but are missing or wrongly shaped in createReanimatedMock():\n` +
          failures.join("\n") +
          `\n\nFix: add/repair each entry in createReanimatedMock() in mapMocks.ts.`,
      );
    }

    expect(failures).toEqual([]);
  });

  it("mock's default (Animated) export provides every member accessed across source files", () => {
    const def = mock.default as Record<string, unknown> | undefined;
    expect(def).toBeDefined();
    expect(typeof def).toBe("object");

    const failures: string[] = [];
    for (const member of [...usage.defaultMembers].sort()) {
      const val = def![member];
      if (typeof val !== "function") {
        failures.push(
          `  • Animated.${member} — missing or not a function on the default export (got: ${typeof val})`,
        );
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `The following members of the default Animated export are used by the app ` +
          `but are missing or wrongly shaped in createReanimatedMock().default:\n` +
          failures.join("\n") +
          `\n\nFix: add each member to the \`default\` object in createReanimatedMock() in mapMocks.ts.`,
      );
    }

    expect(failures).toEqual([]);
  });
});

/**
 * Smoke test for createUseColorsMock().
 *
 * WHY THIS EXISTS
 * ---------------
 * createUseColorsMock() must return the same color tokens as the real
 * useColors hook. If the mock ever drifts from constants/colors.ts,
 * components that destructure a token get `undefined` silently — the test
 * passes but the component renders incorrectly.
 *
 * HOW IT WORKS
 * ------------
 * The real useColors() returns { ...palette, radius } where palette is
 * colors.light or colors.dark from constants/colors.ts. Both this test AND
 * createUseColorsMock() itself derive their palette from the actual module
 * (via jest.requireActual), so the mock can no longer drift independently of
 * the source. This test is a belt-and-suspenders guard that the mock's key
 * set still matches the real hook's key set.
 *
 * HOW TO FIX A FAILURE
 * --------------------
 * If this test fails with "Missing keys in createUseColorsMock(): [X, ...]":
 *   1. Confirm createUseColorsMock() in mapMocks.ts still spreads the real
 *      colors.light palette via jest.requireActual("@/constants/colors").
 * A failure here means that derivation was broken — the mock should never
 * need a manually maintained token list.
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
 * Smoke test for createUseColorsMock() — named export coverage.
 *
 * WHY THIS EXISTS
 * ---------------
 * createUseColorsMock() must expose a function for every named export of
 * hooks/useColors.ts.  When `useIsDark` was added to the hook it was not
 * immediately added to the mock, silently breaking three map test suites with
 * confusing "useIsDark is not a function" errors deep inside unrelated files.
 *
 * The palette-key test above guards against color-token drift, but it only
 * inspects the *return value* of useColors() — it cannot catch a missing
 * top-level export like useIsDark that is never called in the test itself.
 *
 * HOW IT WORKS
 * ------------
 * This test loads the real @/hooks/useColors module via jest.requireActual and
 * enumerates every export whose runtime value is a function.  Those names
 * become the expected set.  The mock is loaded via createUseColorsMock() and
 * each expected name is asserted to be a function.  This covers all TypeScript
 * export forms — `export function`, `export const`, `export { … }`, re-exports
 * — not just literal `export function` declarations.  When a developer adds a
 * new exported hook to useColors.ts, this test fails immediately at the mock
 * layer with a clear message — no manual update to this test is required.
 *
 * HOW TO FIX A FAILURE
 * --------------------
 * If this test fails with "Missing function exports in createUseColorsMock(): [X, ...]":
 *   1. Add X as a function (e.g. `X: () => <sensible default>`) to the object
 *      returned by createUseColorsMock() in mapMocks.ts.
 * That's it.  The test itself never needs updating.
 */
describe("createUseColorsMock() named-export coverage — every function exported by useColors.ts is present in the mock", () => {
  let mock: Record<string, unknown>;
  let expectedFnNames: string[];

  beforeAll(() => {
    const actual = jest.requireActual<Record<string, unknown>>(
      "@/hooks/useColors",
    );

    expectedFnNames = Object.entries(actual)
      .filter(([, v]) => typeof v === "function")
      .map(([k]) => k);

    mock = createUseColorsMock() as Record<string, unknown>;
  });

  it("hooks/useColors.ts exports at least one function (sanity check)", () => {
    expect(expectedFnNames.length).toBeGreaterThan(0);
  });

  it("createUseColorsMock() returns an object (sanity check)", () => {
    expect(typeof mock).toBe("object");
    expect(mock).not.toBeNull();
  });

  it("mock has a function for every named export of hooks/useColors.ts", () => {
    const missing = expectedFnNames.filter(
      (name) => typeof mock[name] !== "function",
    );

    if (missing.length > 0) {
      throw new Error(
        `The following hooks/useColors.ts function exports are missing or not a ` +
          `function in createUseColorsMock():\n` +
          missing.map((n) => `  • ${n} (got: ${typeof mock[n]})`).join("\n") +
          `\n\nFix: add each missing export as a function to the object returned ` +
          `by createUseColorsMock() in mapMocks.ts.\n` +
          `Example: ${missing[0]}: () => false`,
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

/**
 * Smoke test for createMapViewportMock().
 *
 * WHY THIS EXISTS
 * ---------------
 * createMapViewportMock() in mapMocks.ts hardcodes a fixed set of function
 * stubs for "@/utils/mapViewport".  If a new function is added to
 * mapViewport.ts but omitted from the mock, call sites inside components get
 * `undefined` and tests throw a confusing "X is not a function" error deep
 * inside an unrelated test file, making the root cause hard to trace.
 *
 * HOW IT WORKS
 * ------------
 * This test uses jest.requireActual to load the real mapViewport module, then
 * filters its exports down to those whose value is a function.  Those names
 * become the expected set.  When a developer adds a new function to
 * mapViewport.ts, this test fails immediately at the mock layer with a clear
 * message — no manual update to this test file is ever required.
 *
 * HOW TO FIX A FAILURE
 * --------------------
 * If this test fails with "Missing or non-function in createMapViewportMock(): [X, ...]":
 *   1. Add X as a jest.fn() stub to createMapViewportMock() in mapMocks.ts.
 * That's it.  The test itself never needs updating.
 */
describe("createMapViewportMock() smoke — every function export of mapViewport is present in the mock", () => {
  let mock: Record<string, unknown>;
  let expectedFnNames: string[];

  beforeAll(() => {
    const actual = jest.requireActual<Record<string, unknown>>(
      "@/utils/mapViewport",
    );

    expectedFnNames = Object.entries(actual)
      .filter(([, v]) => typeof v === "function")
      .map(([k]) => k);

    mock = createMapViewportMock() as Record<string, unknown>;
  });

  it("mapViewport.ts exports at least one function (sanity check)", () => {
    expect(expectedFnNames.length).toBeGreaterThan(0);
  });

  it("createMapViewportMock() returns an object (sanity check)", () => {
    expect(typeof mock).toBe("object");
    expect(mock).not.toBeNull();
  });

  it("mock has a function stub for every function exported by mapViewport.ts", () => {
    const missing = expectedFnNames.filter(
      (name) => typeof mock[name] !== "function",
    );

    if (missing.length > 0) {
      throw new Error(
        `The following mapViewport.ts function exports are missing or not a ` +
          `function in createMapViewportMock():\n` +
          missing.map((n) => `  • ${n} (got: ${typeof mock[n]})`).join("\n") +
          `\n\nFix: add each missing export as a jest.fn() stub to ` +
          `createMapViewportMock() in mapMocks.ts.`,
      );
    }

    expect(missing).toEqual([]);
  });
});

/**
 * Smoke test for createSvgMock().
 *
 * WHY THIS EXISTS
 * ---------------
 * createSvgMock() in mapMocks.ts stubs each react-native-svg element with one
 * of two things:
 *   - a tag-forwarding component (make("svg-…")) that renders into the tree, or
 *   - a `noop` stub (() => null) that renders NOTHING.
 *
 * A `noop` for an element WarehouseMapView actually renders is a silent bug:
 * the floor plan / pins / zone shapes vanish from the rendered tree, yet the
 * test still passes because nothing threw.  Likewise, if the component starts
 * using an element the mock does not expose at all, that element resolves to
 * `undefined` and renders nothing (or throws deep inside an unrelated test).
 *
 * HOW IT WORKS
 * ------------
 * This test reads the actual source of WarehouseMapView.tsx at runtime, parses
 * every named (non-type) react-native-svg import, and asserts that
 * createSvgMock() exposes each one as a component that RENDERS — i.e. calling
 * it returns a non-null React element, not the null a `noop` produces.  When a
 * developer adds a new SVG element to the component, this test fails
 * immediately at the mock layer — no manual update to this test is required.
 *
 * HOW TO FIX A FAILURE
 * --------------------
 * If this test fails with "missing from createSvgMock()" or "renders nothing":
 *   1. Add (or change) X in createSvgMock() in mapMocks.ts so it forwards a
 *      tag, e.g. `Path: make("svg-path")` — never `Path: noop`.
 * That's it.  The test itself never needs updating.
 */
describe("createSvgMock() smoke — every react-native-svg element used in WarehouseMapView renders (not missing, not noop)", () => {
  let mock: Record<string, unknown>;
  let usedElements: string[];

  beforeAll(() => {
    const source = fs.readFileSync(WAREHOUSE_MAP_VIEW_PATH, "utf-8");
    usedElements = parseSvgElementImports(source);
    mock = createSvgMock() as Record<string, unknown>;
  });

  it("WarehouseMapView.tsx imports at least one react-native-svg element (sanity check)", () => {
    expect(usedElements.length).toBeGreaterThan(0);
  });

  it("createSvgMock() returns an object (sanity check)", () => {
    expect(typeof mock).toBe("object");
    expect(mock).not.toBeNull();
  });

  it("mock exposes a rendering component for every react-native-svg element used in WarehouseMapView", () => {
    const failures: string[] = [];

    for (const name of usedElements) {
      const comp = mock[name];

      if (typeof comp !== "function") {
        failures.push(
          `  • ${name} — missing from createSvgMock() (got: ${typeof comp})`,
        );
        continue;
      }

      let rendered: unknown;
      try {
        rendered = (comp as (props: Record<string, unknown>) => unknown)({});
      } catch (err) {
        failures.push(
          `  • ${name} — threw when rendered: ${(err as Error).message}`,
        );
        continue;
      }

      if (rendered == null) {
        failures.push(
          `  • ${name} — renders nothing (noop stub); it must forward its tag ` +
            `so the element appears in the rendered tree`,
        );
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `The following react-native-svg elements are used by WarehouseMapView.tsx ` +
          `but are missing or render nothing in createSvgMock():\n` +
          failures.join("\n") +
          `\n\nFix: add each element to createSvgMock() in mapMocks.ts as a ` +
          `tag-forwarding component (e.g. Path: make("svg-path")), never as a noop.`,
      );
    }

    expect(failures).toEqual([]);
  });
});

/**
 * Smoke test for createExpoAssetMock().
 *
 * WHY THIS EXISTS
 * ---------------
 * createExpoAssetMock() in mapMocks.ts exposes a fixed set of methods on the
 * `Asset` object (loadAsync, fromModule, …).  WarehouseMapView loads its floor
 * plan through `Asset.loadAsync(...)`.  If the component starts calling a new
 * Asset API that the mock does not stub, that call resolves to `undefined` and
 * either throws ("undefined is not a function") deep inside an unrelated test
 * or silently skips asset loading — the exact silent-failure class the other
 * smoke tests prevent.
 *
 * HOW IT WORKS
 * ------------
 * This test reads WarehouseMapView.tsx at runtime, extracts every
 * `Asset.<method>(` call site, and asserts createExpoAssetMock().Asset exposes
 * a function for each one.  A new Asset call causes this test to fail
 * immediately at the mock layer — no manual update to this test is required.
 *
 * HOW TO FIX A FAILURE
 * --------------------
 * If this test fails with "missing from createExpoAssetMock().Asset":
 *   1. Add X as a stub function to the Asset object in createExpoAssetMock()
 *      in mapMocks.ts.
 * That's it.  The test itself never needs updating.
 */
/**
 * Export-coverage guard for the three reanimated variant factories.
 *
 * WHY THIS EXISTS
 * ---------------
 * The four pin test files (mapPin3D, mapPinFillOpacity, mapPinWebPath,
 * pinAnimationCancelCleanup) each need a slightly different reanimated mock:
 * one needs withTiming as a spy, one invokes its useAnimatedProps callback,
 * one needs cancelAnimation as a spy.  Each of those needs was extracted into
 * a named factory in mapMocks.ts.  If a future refactor removes or renames
 * one of those factories, the pin test file that imports it will fail with a
 * confusing "not a function" error rather than a clear import error.
 *
 * This test ensures all three variant factories are exported and return objects
 * with the distinguishing properties that make them different from the base
 * createReanimatedMock().
 *
 * HOW TO FIX A FAILURE
 * --------------------
 * If "not a function" fails: restore or re-export the missing factory from
 * mapMocks.ts.
 * If "withTiming not a jest.fn()" fails: the TimingSpy factory must expose
 * withTiming as a jest.fn() so pin fill-opacity tests can assert on it.
 * If "cancelAnimation not a jest.fn()" fails: the CancelSpy factory must
 * expose cancelAnimation as a jest.fn() for cleanup tests.
 * If "useAnimatedProps invokes callback" fails: the PropsCallback factory must
 * invoke its callback argument so worklet bodies are exercised during render.
 */
describe("reanimated variant factory export coverage", () => {
  it("createReanimatedMockWithTimingSpy is exported and exposes withTiming as jest.fn()", () => {
    expect(typeof createReanimatedMockWithTimingSpy).toBe("function");
    const mock = createReanimatedMockWithTimingSpy() as Record<string, unknown>;
    expect(typeof mock["withTiming"]).toBe("function");
    expect((mock["withTiming"] as jest.Mock).mock).toBeDefined();   // jest.fn() has .mock
    // withTiming should pass the value through so animations resolve synchronously
    expect((mock["withTiming"] as (v: number) => number)(42)).toBe(42);
  });

  it("createReanimatedMockWithPropsCallback is exported and useAnimatedProps invokes callback", () => {
    expect(typeof createReanimatedMockWithPropsCallback).toBe("function");
    const mock = createReanimatedMockWithPropsCallback() as Record<string, unknown>;
    const useAnimatedProps = mock["useAnimatedProps"] as (cb: () => unknown) => unknown;
    expect(typeof useAnimatedProps).toBe("function");
    // The callback must actually be invoked (worklet execution path)
    const sentinel = Symbol("sentinel");
    const result = useAnimatedProps(() => sentinel);
    expect(result).toBe(sentinel);
  });

  it("createReanimatedMockWithCancelSpy is exported and exposes cancelAnimation as jest.fn()", () => {
    expect(typeof createReanimatedMockWithCancelSpy).toBe("function");
    const mock = createReanimatedMockWithCancelSpy() as Record<string, unknown>;
    expect(typeof mock["cancelAnimation"]).toBe("function");
    expect((mock["cancelAnimation"] as jest.Mock).mock).toBeDefined();
    expect(typeof mock["withTiming"]).toBe("function");
    expect((mock["withTiming"] as jest.Mock).mock).toBeDefined();
  });
});

describe("createExpoAssetMock() smoke — every Asset method used in WarehouseMapView is mocked", () => {
  let asset: Record<string, unknown>;
  let usedMethods: string[];

  beforeAll(() => {
    const source = fs.readFileSync(WAREHOUSE_MAP_VIEW_PATH, "utf-8");
    usedMethods = parseExpoAssetMethods(source);
    asset = (createExpoAssetMock() as { Asset: Record<string, unknown> }).Asset;
  });

  it("WarehouseMapView.tsx calls at least one Asset method (sanity check)", () => {
    expect(usedMethods.length).toBeGreaterThan(0);
  });

  it("createExpoAssetMock() exposes an Asset object (sanity check)", () => {
    expect(typeof asset).toBe("object");
    expect(asset).not.toBeNull();
  });

  it("mock exposes a function for every Asset method called in WarehouseMapView", () => {
    const missing = usedMethods.filter(
      (name) => typeof asset[name] !== "function",
    );

    if (missing.length > 0) {
      throw new Error(
        `The following expo-asset Asset methods are called by WarehouseMapView.tsx ` +
          `but are missing or not a function in createExpoAssetMock().Asset:\n` +
          missing.map((n) => `  • ${n} (got: ${typeof asset[n]})`).join("\n") +
          `\n\nFix: add each missing method as a stub function to the Asset ` +
          `object in createExpoAssetMock() in mapMocks.ts.`,
      );
    }

    expect(missing).toEqual([]);
  });
});

